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
    enabled: true,
    minIntervalSteps: 0,
    minSavingsTokens: 0,
    minSavingsRatio: 0,
    expectedSummaryRatio: 0.05,
    paybackTurns: 32,
    cacheReadRatio: 1,
    summaryInputRatio: 0.01,
    summaryOutputRatio: 0.01,
};

async function candidate(
    t,
    { scheduling = {}, compaction = {}, request = true, mark = true, ...options } = {},
) {
    const f = await fixture({
        ...options,
        scheduling: { ...affordable, ...scheduling },
        compaction: { retainTokens: 256, ...compaction },
    });
    t.after(f.close);
    f.session.append("turn/start", { turn: 1 });
    const original = f.appendUser("Historical evidence that can be released. ".repeat(600));
    const id = f.idFor(original);
    if (mark)
        assert.equal(
            (await f.invoke("context_release", { ids: [id], reason: "Evidence extracted" }))
                .isError,
            false,
        );
    if (request)
        assert.equal(
            (await f.invoke("context_compact", { reason: "Checkpoint when economically ready" }))
                .isError,
            false,
        );
    f.appendUser("Keep this current balanced tail. ".repeat(80));
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

test("enabled model requests below pressure wait for interval and preserve intent", async (t) => {
    const f = await candidate(t, { scheduling: { minIntervalSteps: 100 } });
    const status = await f.engine.schedulingStatus(f.agent);
    assert.equal(status.reason, "min_interval");
    assert.equal(status.decision, "wait");
    assert.equal(await f.engine.compactIfNeeded(f.agent, "pressure", signal()), null);
    assert.equal(f.calls.length, 0);
    assert.equal(f.engine.hasSummaryRequest(f.session), true);
    assert.equal(
        f.engine.state(f.session).entries.find((entry) => entry.id === f.id).status,
        "queued",
    );
});

test("enabled model requests below pressure pass through the savings gate", async (t) => {
    const f = await candidate(t, { scheduling: { minSavingsTokens: 1000000 } });
    assert.equal((await f.engine.schedulingStatus(f.agent)).reason, "min_savings");
    assert.equal(await f.engine.compactIfNeeded(f.agent, "pressure", signal()), null);
    assert.equal(f.calls.length, 0);
    assert.equal(f.engine.hasSummaryRequest(f.session), true);
});

test("eligible requests summarize the full unmarked span through official transactions", async (t) => {
    const f = await candidate(t, { mark: false });
    const status = await f.engine.schedulingStatus(f.agent);
    assert.equal(status.reason, "eligible");
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

test("backlog alone proactively summarizes only when auto and proactive are enabled", async (t) => {
    const on = await candidate(t, { request: false, compaction: { auto: true } });
    assert.equal((await on.engine.schedulingStatus(on.agent)).reason, "eligible");
    assert.ok(await on.engine.compactIfNeeded(on.agent, "pressure", signal()));
    assert.equal(on.calls.length, 1);
    const off = await candidate(t, { request: false });
    assert.equal((await off.engine.schedulingStatus(off.agent)).reason, "disabled");
    assert.equal(await off.engine.compactIfNeeded(off.agent, "pressure", signal()), null);
    assert.equal(off.calls.length, 0);
    const noProactive = await candidate(t, {
        request: false,
        compaction: { auto: true },
        scheduling: { proactive: false },
    });
    assert.equal((await noProactive.engine.schedulingStatus(noProactive.agent)).reason, "disabled");
    assert.equal(
        await noProactive.engine.compactIfNeeded(noProactive.agent, "pressure", signal()),
        null,
    );
});

test("official pressure and overflow bypass interval and savings gates", async (t) => {
    const pressure = await candidate(t, {
        request: false,
        compaction: { auto: true, thresholdRatio: 0.5 },
        scheduling: { minIntervalSteps: 100, minSavingsTokens: 1000000 },
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
        scheduling: { proactive: false, minIntervalSteps: 100, minSavingsTokens: 1000000 },
    });
    assert.ok(await overflow.engine.compactIfNeeded(overflow.agent, "context-overflow", signal()));
    assert.equal(overflow.calls.length, 1);
});

test("disabled scheduling preserves legacy forced model-request behavior", async (t) => {
    const f = await candidate(t, {
        scheduling: { enabled: false, minIntervalSteps: 100, minSavingsTokens: 1000000 },
    });
    assert.equal((await f.engine.schedulingStatus(f.agent)).reason, "legacy_request");
    assert.ok(await f.engine.compactIfNeeded(f.agent, "pressure", signal()));
    assert.equal(f.calls.length, 1);
});

test("direct user compactNow bypasses economics and has no scheduling override", async (t) => {
    const f = await candidate(t, {
        request: false,
        scheduling: { minIntervalSteps: 100, minSavingsTokens: 1000000 },
    });
    f.session.append("turn/end", { turn: 1, reason: { kind: "completed" } });
    assert.equal(Object.hasOwn(Object.getPrototypeOf(f.engine), "compactNow"), false);
    assert.ok(await f.engine.compactNow(f.agent, signal()));
    assert.equal(f.calls.length, 1);
});

test("status plans are read-only, bounded, and include filtered transcript costs", async (t) => {
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
    assert.ok(first.plan.selectedTokens > first.plan.filterInputTokens);
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

test("interval counts committed assistant slots consistently across cold and fork replay", async (t) => {
    const f = await candidate(t, { scheduling: { minIntervalSteps: 100 } });
    assistant(f);
    const live = await f.engine.schedulingStatus(f.agent);
    const seed = JSON.parse(JSON.stringify(f.session.snapshotEvents()));
    const cold = Session.create(f.session.id, seed, f.session.header);
    const fork = f.sessions.fork(f.session);
    for (const session of [cold, fork]) {
        const status = await f.engine.schedulingStatus({ ...f.agent, session });
        assert.equal(status.reason, "min_interval");
        assert.equal(status.plan.stepsSinceSummary, live.plan.stepsSinceSummary);
        assert.deepEqual(status.selection, live.selection);
    }
    assert.equal(f.calls.length, 0);
});

test("failed scheduled transactions preserve marks and request and suppress unchanged retries", async (t) => {
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
    assert.equal(receipt.data.meta.dshContextCompression.version, 5);
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
        "queued",
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
        assert.equal(
            (await f.engine.schedulingStatus({ ...f.agent, session })).reason,
            "failed_cooldown",
        );
        assert.equal(
            await f.engine.compactIfNeeded({ ...f.agent, session }, "pressure", signal()),
            null,
        );
    }
    assert.equal(f.calls.length, 1);
    assistant(f, "Fresh committed evidence allows the next retry.");
    const retryStatus = await f.engine.schedulingStatus(f.agent);
    assert.equal(retryStatus.failure.retryAfterSteps, 0);
    assert.equal(retryStatus.reason, "eligible");
    failSummary = false;
    const retrySeed = JSON.parse(JSON.stringify(f.session.snapshotEvents()));
    const retryCold = Session.create(f.session.id, retrySeed, f.session.header);
    const retryFork = f.sessions.fork(f.session);
    retryFork.append("turn/start", { turn: 2 });
    for (const session of [f.session, retryCold, retryFork]) {
        const result = await f.engine.compactIfNeeded(
            { ...f.agent, session },
            "pressure",
            signal(),
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
            "released",
        );
        assert.equal(f.engine.hasSummaryRequest(session), false);
    }
    assert.equal(f.calls.length, 4);
});

test("legacy version-4 failed requests remain terminal after fresh work and replay", async (t) => {
    const f = await candidate(t, {
        scheduling: { enabled: false },
        onStream: () => {
            throw new Error("isolated legacy summary failure");
        },
    });
    const receipt = f.session
        .snapshotEvents()
        .find(
            (event) =>
                event.type === "tool/result" &&
                event.data.meta?.dshContextCompression?.kind === "summary",
        );
    assert.equal(receipt.data.meta.dshContextCompression.version, 4);
    await assert.rejects(
        f.engine.compactIfNeeded(f.agent, "pressure", signal()),
        /isolated legacy summary failure/,
    );
    assistant(f, "Fresh work must not revive a terminal legacy request.");
    const cold = Session.create(
        f.session.id,
        JSON.parse(JSON.stringify(f.session.snapshotEvents())),
        f.session.header,
    );
    const fork = f.sessions.fork(f.session);
    for (const session of [f.session, cold, fork]) {
        const request = f.engine.state(session).summaryRequests.at(-1);
        assert.equal(request.status, "failed");
        assert.equal(request.retryable, false);
        assert.match(request.error, /isolated legacy summary failure/);
        assert.equal(f.engine.hasSummaryRequest(session), false);
        assert.equal(
            await f.engine.compactIfNeeded({ ...f.agent, session }, "pressure", signal()),
            null,
        );
    }
    assert.equal(f.calls.length, 1);
});

test("scheduled interval follows the latest applied summary after replay", async (t) => {
    const f = await candidate(t, { scheduling: { minIntervalSteps: 3 } });
    assistant(f);
    assert.ok(await f.engine.compactIfNeeded(f.agent, "pressure", signal()));
    f.appendUser("A new historical span. ".repeat(800));
    assert.equal(
        (await f.invoke("context_compact", { reason: "Second checkpoint" })).isError,
        false,
    );
    f.appendUser("Retain a new current tail. ".repeat(100));
    const current = await f.engine.schedulingStatus(f.agent);
    assert.equal(current.reason, "min_interval");
    assert.equal(current.plan.stepsSinceSummary, 1);
    const cold = Session.create(
        f.session.id,
        JSON.parse(JSON.stringify(f.session.snapshotEvents())),
        f.session.header,
    );
    assert.equal(
        (await f.engine.schedulingStatus({ ...f.agent, session: cold })).plan.stepsSinceSummary,
        1,
    );
});

test("real isolated AgentLoop queues an economic request without making a summary call", async (t) => {
    const root = await mkdtemp(join(tmpdir(), "fold-context-test-"));
    const f = await loopFixture(root, {
        scheduling: { ...affordable, minIntervalSteps: 100 },
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
    await f.followup(handle, "Keep this current balanced tail. ".repeat(100));
    assert.equal(f.summaries.length, 0);
    assert.equal(f.engine.hasSummaryRequest(handle.agent.session), true);
    assert.equal((await f.engine.schedulingStatus(handle.agent)).reason, "min_interval");
    await f.flush(handle);
});
