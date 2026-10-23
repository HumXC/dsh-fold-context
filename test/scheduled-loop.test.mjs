import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Session } from "@deepseek-ai/dsh-session";
import { createAssistantMessage } from "@deepseek-ai/dsh-llm";
import { fixture } from "./fixture.mjs";
import { assertTestRoot, call, loopFixture } from "./loop-fixture.mjs";

const signal = () => new AbortController().signal;
const affordable = {
    summaryInputRatio: 0.01,
    summaryOutputRatio: 0.01,
};

async function candidate(
    t,
    { scheduling = {}, compaction = {}, request = true, mark = false, ...options } = {},
) {
    const f = await fixture({
        ...options,
        scheduling: { ...affordable, ...scheduling },
        compaction: { targetTokens: 4096, cacheReadRatio: 1, ...compaction },
    });
    t.after(f.close);
    f.session.append("turn/start", { turn: 1 });
    const original = f.appendUser("Historical evidence that can be released. ".repeat(600));
    const marked = mark
        ? f.toolRound("read", "Consumed output available for a release batch. ".repeat(600))
        : null;
    const id = f.idFor(marked ?? original);
    if (mark)
        assert.equal(
            (await f.invoke("context_release", { ids: [Number(id)], reason: "Evidence extracted" }))
                .value.accepted,
            true,
        );
    if (request)
        assert.equal(
            (await f.invoke("context_compact", { reason: "Checkpoint when economically ready" }))
                .isError,
            false,
        );
    f.appendUser(
        "Keep this current balanced tail. ".repeat(
            Math.max(200, Math.ceil((compaction.targetTokens ?? 4096) / 32)),
        ),
    );
    return { ...f, id, original };
}

function assistant(f, text = "A committed work step.") {
    const step =
        Math.max(
            0,
            ...f.session
                .snapshotEvents()
                .filter((event) => event.type === "step/start")
                .map((event) => event.data.step),
        ) + 1;
    f.advanceSteps(step);
    f.session.append("step/start", { turn: 1, step });
    f.session.append(
        "assistant/message",
        {
            turn: 1,
            step,
            message: createAssistantMessage({
                source: { provider: "test", model: "fixture" },
                content: [{ type: "text", text }],
            }),
            stream: [],
        },
        { surfaceOp: "append" },
    );
    f.session.append("step/end", { turn: 1, step });
}

test("cheap-cache checkpoint requests wait for a later economic window and preserve intent", async (t) => {
    const f = await candidate(t, { compaction: { targetTokens: 100000, cacheReadRatio: 0 } });
    const status = await f.engine.schedulingStatus(f.agent);
    assert.equal(status.reason, "cost_deferred");
    assert.equal(status.decision, "wait");
    assert.equal(await f.engine.compactIfNeeded(f.agent, "pressure", signal()), null);
    assert.equal(f.calls.length, 0);
    assert.equal(f.engine.hasSummaryRequest(f.session), true);
    assert.equal(
        f.engine.state(f.session).entries.find((entry) => entry.id === f.id).status,
        "available",
    );
});

test("expensive summaries below the target remain queued", async (t) => {
    const f = await candidate(t, {
        compaction: { targetTokens: 100000, cacheReadRatio: 0.1 },
        scheduling: { summaryInputRatio: 1000 },
    });
    assert.equal((await f.engine.schedulingStatus(f.agent)).reason, "cost_deferred");
    assert.equal(await f.engine.compactIfNeeded(f.agent, "pressure", signal()), null);
    assert.equal(f.calls.length, 0);
    assert.equal(f.engine.hasSummaryRequest(f.session), true);
});

test("eligible requests summarize the full unmarked span through official transactions", async (t) => {
    const f = await candidate(t, { mark: false });
    const status = await f.engine.schedulingStatus(f.agent);
    assert.equal(status.reason, "window_pressure");
    assert.deepEqual(status.plan.markedIds, []);
    assert.ok(status.plan.netSavingTokens > 1000);
    const result = await f.engine.compactIfNeeded(f.agent, "pressure", signal());
    assert.ok(result);
    assert.equal(f.calls.length, 1);
    assert.equal(f.engine.hasSummaryRequest(f.session), false);
    const end = f.session.eventAt(result.endSeq);
    assert.equal(end.type, "compaction/end");
    assert.equal(end.data.compactionId, result.compactionId);
    assert.equal(end.data.error, undefined);
    const checkpoint = f.session.eventAt(result.summarySeq + 1);
    assert.equal(checkpoint.type, "user/message");
    assert.equal(checkpoint.data.source.kind, "compact-checkpoint");
    assert.deepEqual(checkpoint.surfaceOp, {
        op: "replace",
        startSeq: result.shadowedRange.start,
        endSeq: result.shadowedRange.end,
    });
    assert.ok(f.session.surface.nodes.includes(checkpoint.seq));
    assert.ok(result.shadowedSeqs.includes(f.original.seq));
    assert.ok(result.shadowedSeqs.every((seq) => !f.session.surface.nodes.includes(seq)));
    assert.equal(f.engine.state(f.session).summaryRequests.at(-1).status, "applied");
    assert.equal(f.engine.state(f.session).lastSummary.seq, checkpoint.seq);
    assert.ok(
        f.calls[0].messages.some((message) =>
            message.content.some(
                (block) => block.type === "text" && block.text.includes("Historical evidence"),
            ),
        ),
    );
});

test("recent tool marks drain without summaries whether automatic checkpointing is enabled", async (t) => {
    for (const auto of [true, false]) {
        const f = await candidate(t, {
            request: false,
            mark: true,
            compaction: { auto, targetTokens: 100000 },
        });
        assert.equal(
            f.engine.state(f.session).entries.find((entry) => entry.id === f.id).status,
            "queued",
        );
        assert.equal(await f.engine.compactIfNeeded(f.agent, "pressure", signal()), null);
        assert.equal(
            f.engine.state(f.session).entries.find((entry) => entry.id === f.id).status,
            "released",
        );
        assert.equal(f.engine.hasSummaryRequest(f.session), false);
        assert.equal(f.calls.length, 0);
    }
});

test("pressure and overflow bypass adverse summary economics", async (t) => {
    const pressure = await candidate(t, {
        request: false,
        compaction: { auto: true, targetTokens: 2048, cacheReadRatio: 0 },
        scheduling: { summaryInputRatio: 1000 },
    });
    pressure.llm.resolveModelInfo = async () => ({
        context: { contextWindow: 4096 },
        defaultMaxTokens: 128,
    });
    assert.equal(
        (await pressure.engine.schedulingStatus(pressure.agent)).reason,
        "safety_pressure",
    );
    assert.ok(await pressure.engine.compactIfNeeded(pressure.agent, "pressure", signal()));
    assert.equal(pressure.calls.length, 1);
    const overflow = await candidate(t, {
        request: false,
        compaction: { cacheReadRatio: 0 },
        scheduling: { summaryInputRatio: 1000 },
    });
    assert.ok(await overflow.engine.compactIfNeeded(overflow.agent, "context-overflow", signal()));
    assert.equal(overflow.calls.length, 1);
});

test("automatic summaries disabled still honors economic deferral of explicit requests", async (t) => {
    const f = await candidate(t, {
        compaction: { auto: false, targetTokens: 100000, cacheReadRatio: 0 },
    });
    const status = await f.engine.schedulingStatus(f.agent);
    assert.equal(status.decision, "wait");
    assert.equal(status.reason, "cost_deferred");
    assert.equal(await f.engine.compactIfNeeded(f.agent, "pressure", signal()), null);
    assert.equal(f.calls.length, 0);
    assert.equal(f.engine.hasSummaryRequest(f.session), true);
});

test("direct user compactNow bypasses checkpoint economics without a queued model request", async (t) => {
    const f = await candidate(t, {
        request: false,
        compaction: { targetTokens: 100000, cacheReadRatio: 0 },
        scheduling: { summaryInputRatio: 1000 },
    });
    f.session.append("turn/end", { turn: 1, reason: { kind: "completed" } });
    assert.equal(f.engine.hasSummaryRequest(f.session), false);
    assert.ok(await f.engine.compactNow(f.agent, signal()));
    assert.equal(f.calls.length, 1);
});

test("checkpoint status plans are read-only, bounded and account for transcript costs", async (t) => {
    const f = await candidate(t);
    const before = {
        seq: f.session.seq,
        events: JSON.stringify(f.session.snapshotEvents()),
        state: JSON.stringify(f.engine.state(f.session)),
        surface: JSON.stringify(f.session.surface.nodes),
    };
    const first = await f.engine.schedulingStatus(f.agent, undefined, 1);
    const second = await f.engine.schedulingStatus(f.agent, undefined, 1);
    assert.deepEqual(first, second);
    assert.ok(first.plan.selectedTokens > 0);
    assert.ok(first.plan.filterInputTokens > 0);
    assert.ok(first.plan.rebuiltSuffixTokens > 0);
    assert.match(first.estimates, /HEURISTIC/);
    assert.ok(first.plan.markedIds.length <= 1);
    const outcome = await f.ctx.tools.execute({
        name: "context_status",
        arguments: { limit: 1 },
        callId: "read-plan",
        agent: f.agent,
        signal: signal(),
    });
    assert.equal(outcome.isError, false);
    assert.match(outcome.content.map((block) => block.text ?? "").join(""), /scheduling/);
    assert.equal(f.calls.length, 0);
    assert.deepEqual(
        {
            seq: f.session.seq,
            events: JSON.stringify(f.session.snapshotEvents()),
            state: JSON.stringify(f.engine.state(f.session)),
            surface: JSON.stringify(f.session.surface.nodes),
        },
        before,
    );
});

test("checkpoint cost and window decisions remain identical across cold and fork replay", async (t) => {
    const f = await candidate(t, { compaction: { targetTokens: 100000, cacheReadRatio: 0 } });
    assistant(f);
    const live = await f.engine.schedulingStatus(f.agent);
    const seed = JSON.parse(JSON.stringify(f.session.snapshotEvents()));
    const cold = Session.create(f.session.id, seed, f.session.header);
    const fork = f.sessions.fork(f.session);
    for (const session of [cold, fork]) {
        await f.withSessionQuery(session, async () => {
            const status = await f.engine.schedulingStatus({ ...f.agent, session });
            assert.equal(status.reason, "cost_deferred");
            assert.equal(status.plan.currentUnitCost, live.plan.currentUnitCost);
            assert.equal(status.plan.recommendedAtTokens, live.plan.recommendedAtTokens);
            assert.deepEqual(status.selection, live.selection);
        });
    }
    assert.equal(f.calls.length, 0);
});

test("failed scheduled checkpoints preserve evidence and request and suppress unchanged retries", async (t) => {
    let failSummary = true;
    const f = await candidate(t, {
        onStream: () => {
            if (failSummary) throw new Error("isolated scheduled summary failure");
        },
    });
    const before = [...f.session.surface.nodes];
    const receipt = f.session
        .snapshotEvents()
        .find(
            (event) =>
                event.type === "tool/result" &&
                event.data.meta?.dshContextCompression?.kind === "summary",
        );
    assert.equal(receipt.data.meta.dshContextCompression.version, 8);
    await assert.rejects(
        f.engine.compactIfNeeded(f.agent, "pressure", signal()),
        /isolated scheduled summary failure/,
    );
    assert.equal(f.calls.length, 1);
    assert.deepEqual(f.session.surface.nodes, before);
    assert.equal(f.engine.hasSummaryRequest(f.session), true);
    assert.equal(f.engine.state(f.session).summaryRequests.at(-1).status, "failed");
    assert.equal(f.engine.state(f.session).summaryRequests.at(-1).retryable, true);
    assert.equal(
        f.engine.state(f.session).entries.find((entry) => entry.id === f.id).status,
        "available",
    );
    const status = await f.engine.schedulingStatus(f.agent);
    assert.equal(status.reason, "failed_cooldown");
    assert.match(status.failure.error, /isolated scheduled summary failure/);
    for (let attempt = 0; attempt < 3; attempt++)
        assert.equal(await f.engine.compactIfNeeded(f.agent, "pressure", signal()), null);
    assert.equal(f.calls.length, 1);
    const cold = Session.create(
        f.session.id,
        JSON.parse(JSON.stringify(f.session.snapshotEvents())),
        f.session.header,
    );
    const fork = f.sessions.fork(f.session);
    for (const session of [cold, fork]) {
        assert.equal(f.engine.hasSummaryRequest(session), true);
        assert.equal(f.engine.state(session).summaryRequests.at(-1).retryable, true);
        await f.withSessionQuery(session, async () => {
            assert.equal(
                (await f.engine.schedulingStatus({ ...f.agent, session })).reason,
                "failed_cooldown",
            );
            assert.equal(
                await f.engine.compactIfNeeded({ ...f.agent, session }, "pressure", signal()),
                null,
            );
        });
    }
    assert.equal(f.calls.length, 1);
    const cooldown = status.failure.retryAfterSteps;
    assert.ok(Number.isSafeInteger(cooldown) && cooldown > 0);
    for (let step = 0; step < cooldown; step++) {
        assistant(f, `Fresh committed evidence ${step + 1} advances recovery.`);
        const progress = await f.engine.schedulingStatus(f.agent);
        assert.equal(progress.failure.retryAfterSteps, cooldown - step - 1);
        if (step + 1 < cooldown) {
            assert.equal(progress.reason, "failed_cooldown");
            assert.equal(await f.engine.compactIfNeeded(f.agent, "pressure", signal()), null);
            assert.equal(f.calls.length, 1);
        }
    }
    const retryStatus = await f.engine.schedulingStatus(f.agent);
    assert.equal(retryStatus.failure.retryAfterSteps, 0);
    assert.equal(retryStatus.reason, "window_pressure");
    failSummary = false;
    const retrySeed = JSON.parse(JSON.stringify(f.session.snapshotEvents()));
    const retryCold = Session.create(f.session.id, retrySeed, f.session.header);
    const retryFork = f.sessions.fork(f.session);
    retryFork.append("turn/start", { turn: 2 });
    for (const session of [f.session, retryCold, retryFork]) {
        const result = await f.withSessionQuery(session, async () =>
            f.engine.compactIfNeeded({ ...f.agent, session }, "pressure", signal()),
        );
        assert.ok(result);
        assert.equal(session.eventAt(result.endSeq).data.error, undefined);
        const checkpoint = session.eventAt(result.summarySeq + 1);
        assert.equal(checkpoint.type, "user/message");
        assert.equal(checkpoint.data.source.kind, "compact-checkpoint");
        assert.equal(checkpoint.surfaceOp.op, "replace");
        assert.ok(session.surface.nodes.includes(checkpoint.seq));
        assert.ok(result.shadowedSeqs.every((seq) => !session.surface.nodes.includes(seq)));
        assert.equal(f.engine.state(session).summaryRequests.at(-1).status, "applied");
        assert.equal(f.engine.state(session).summaryRequests.at(-1).error, null);
        assert.equal(
            f.engine.state(session).entries.find((entry) => entry.id === f.id).status,
            "summarized",
        );
        assert.equal(f.engine.hasSummaryRequest(session), false);
    }
    assert.equal(f.calls.length, 4);
});

test("obsolete version-4 checkpoint receipts cannot create or revive a request during replay", async (t) => {
    const f = await candidate(t, { request: false, compaction: { auto: false } });
    f.toolRound(
        "context_compact",
        JSON.stringify({
            dshContextCompression: {
                version: 4,
                kind: "summary",
                sessionId: f.session.id,
                ids: [],
                reason: "Obsolete request",
            },
        }),
    );
    assistant(f, "Fresh work cannot authorize an obsolete receipt.");
    const cold = Session.create(
        f.session.id,
        JSON.parse(JSON.stringify(f.session.snapshotEvents())),
        f.session.header,
    );
    const fork = f.sessions.fork(f.session);
    for (const session of [f.session, cold, fork]) {
        assert.equal(f.engine.state(session).summaryRequests.length, 0);
        assert.equal(f.engine.hasSummaryRequest(session), false);
        assert.equal(
            await f.withSessionQuery(session, async () =>
                f.engine.compactIfNeeded({ ...f.agent, session }, "pressure", signal()),
            ),
            null,
        );
    }
    assert.equal(f.calls.length, 0);
});

test("a new useful span is independently eligible after an applied summary and cold replay", async (t) => {
    const f = await candidate(t, { compaction: { targetTokens: 4096 } });
    assistant(f);
    assistant(f, "A second committed work step preserves the current task.");
    assert.ok(await f.engine.compactIfNeeded(f.agent, "pressure", signal()));
    f.appendUser("A new historical span. ".repeat(800));
    assert.equal(
        (await f.invoke("context_compact", { reason: "Second checkpoint" })).isError,
        false,
    );
    f.appendUser("Retain a new current tail. ".repeat(100));
    const current = await f.engine.schedulingStatus(f.agent);
    assert.equal(current.decision, "execute");
    assert.equal(current.reason, "window_pressure");
    const cold = Session.create(
        f.session.id,
        JSON.parse(JSON.stringify(f.session.snapshotEvents())),
        f.session.header,
    );
    const coldStatus = await f.withSessionQuery(cold, async () =>
        f.engine.schedulingStatus({ ...f.agent, session: cold }),
    );
    assert.equal(coldStatus.reason, current.reason);
    assert.deepEqual(coldStatus.selection, current.selection);
    assert.equal(coldStatus.plan.currentUnitCost, current.plan.currentUnitCost);
});

test("real isolated AgentLoop queues an economic request without making a summary call", async (t) => {
    const root = await mkdtemp(join(tmpdir(), "fold-context-test-"));
    const f = await loopFixture(root, {
        compaction: { targetTokens: 12000, cacheReadRatio: 0 },
        scheduling: affordable,
        responses: [
            { blocks: [{ type: "text", text: "Recorded historical evidence." }] },
            call("context_compact", { reason: "Wait for the next economical checkpoint" }),
            { blocks: [{ type: "text", text: "Continued work." }] },
        ],
    });
    t.after(async () => {
        await f.close();
        await assertTestRoot(root);
        await rm(root, { recursive: true, force: true });
    });
    const handle = await f.create();
    await f.followup(handle, "Review this history. ".repeat(1000));
    await f.followup(handle, "Keep this current balanced tail. ".repeat(500));
    assert.equal(f.summaries.length, 0);
    assert.equal(f.engine.hasSummaryRequest(handle.agent.session), true);
    assert.equal((await f.engine.schedulingStatus(handle.agent)).reason, "cost_deferred");
    await f.flush(handle);
});
