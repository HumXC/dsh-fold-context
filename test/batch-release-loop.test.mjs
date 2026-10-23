import test from "node:test";
import assert from "node:assert/strict";
import { Session } from "@deepseek-ai/dsh-session";
import { createAssistantMessage, freezeMessage } from "@deepseek-ai/dsh-llm";
import { commitForcedReleases } from "./release-batch-fixture.mjs";
import { fixture } from "./fixture.mjs";
import { planReleaseBatch } from "../lib/domain/scheduler.js";
import { commitInlineReleases, estimateInlineReleases } from "../lib/integration/inline-release.js";
import { observeSessionCut, withSessionCut } from "../lib/integration/session-cut.js";

const signal = () => new AbortController().signal;
const waiting = {
    cacheTtlMs: 0,
};

async function queued(t, options = {}) {
    const f = await fixture({
        ...options,
        compaction: { auto: false, targetTokens: 100000, cacheReadRatio: 0, ...options.compaction },
        scheduling: { ...waiting, ...options.scheduling },
    });
    t.after(f.close);
    f.session.append("turn/start", { turn: 1 });
    f.appendUser("Investigate the archived evidence.");
    const original = f.toolRound("read_archive", "RELEASED_ARCHIVE_CONTENT ".repeat(2000));
    const id = f.idFor(original);
    const result = await f.invoke("context_release", {
        ids: [Number(id)],
        reason: "Extracted the needed facts",
    });
    assert.equal(result.isError, false);
    f.appendUser("Continue the current task using the extracted facts. ".repeat(600));
    return { ...f, id, original };
}
const entry = (f) => f.engine.state(f.session).entries.find((item) => item.id === f.id);

test("low-pressure marks stay queued and read-only status does not purchase a rebuild", async (t) => {
    const f = await queued(t);
    const before = f.session.seq;
    assert.equal((await f.engine.schedulingStatus(f.agent)).releaseBatch.decision, "wait");
    assert.equal(f.session.seq, before);
    assert.equal(await f.engine.compactIfNeeded(f.agent, "pressure", signal()), null);
    assert.equal(entry(f).status, "queued");
    assert.equal(f.calls.length, 0);
    assert.ok(f.session.surface.nodes.includes(f.original.seq));
});

test("pressure grants a batch, then stops without summary once fresh measurement is below target", async (t) => {
    const f = await queued(t, { compaction: { auto: true, targetTokens: 10000 } });
    const before = f.engine.pressureStatus(f.session).totalTokens;
    f.llm.resolveModelInfo = async () => ({ context: { contextWindow: before } });
    let selected = false;
    const originalRange = f.engine.pressureRange.bind(f.engine);
    f.engine.pressureRange = (...args) => {
        selected = true;
        return originalRange(...args);
    };
    assert.equal(await f.engine.compactIfNeeded(f.agent, "pressure", signal()), null);
    assert.equal(entry(f).status, "released");
    assert.equal(f.calls.length, 0);
    assert.equal(selected, false);
    assert.ok(f.engine.pressureStatus(f.session).totalTokens < 10000);
});

test("remaining pressure builds both range and auxiliary summary from the released surface", async (t) => {
    const f = await queued(t, { compaction: { auto: true, targetTokens: 2048 } });
    f.appendUser("Unmarked historical business evidence. ".repeat(3000));
    f.toolRound("work_on_history", "Extracted the old unmarked evidence.");
    f.appendUser("Protect this latest input.");
    const before = f.engine.pressureStatus(f.session).totalTokens;
    f.llm.resolveModelInfo = async () => ({ context: { contextWindow: Math.ceil(before * 0.55) } });
    const seen = [];
    const originalRange = f.engine.pressureRange.bind(f.engine);
    f.engine.pressureRange = (session, measurement, retain, cut) => {
        seen.push({
            total: measurement.totalTokens,
            nodes: measurement.nodes.map((node) => node.seq),
        });
        return originalRange(session, measurement, retain, cut);
    };
    assert.ok(await f.engine.compactIfNeeded(f.agent, "pressure", signal()));
    assert.ok(f.calls.length > 0);
    assert.ok(seen.length > 0);
    assert.ok(seen[0].total < before);
    assert.equal(seen[0].nodes.includes(f.original.seq), false);
    assert.ok(
        f.calls.every(
            (call) => !JSON.stringify(call.messages).includes("RELEASED_ARCHIVE_CONTENT"),
        ),
    );
});

test("overflow with insufficient release still enters native summary recovery", async (t) => {
    const f = await queued(t);
    f.appendUser("Other unmarked evidence that overflow recovery can summarize. ".repeat(3000));
    f.appendUser("Keep this latest input.");
    f.llm.resolveModelInfo = async () => ({ context: { contextWindow: 4096 } });
    assert.ok(await f.engine.compactIfNeeded(f.agent, "context-overflow", signal()));
    assert.equal(entry(f).status, "released");
    assert.ok(f.calls.length > 0);
    assert.ok(
        f.calls.every(
            (call) => !JSON.stringify(call.messages).includes("RELEASED_ARCHIVE_CONTENT"),
        ),
    );
});

test("recent replacements execute consistently after cold replay without a wait horizon", async (t) => {
    const f = await queued(t, { compaction: { cacheReadRatio: 1 } });
    f.toolRound("work_a", "Completed independent business work.");
    f.toolRound("work_b", "Completed another independent business step.");
    const cold = Session.create(
        f.session.id,
        JSON.parse(JSON.stringify(f.session.snapshotEvents())),
        f.session.header,
    );
    for (const session of [f.session, cold]) {
        await f.withSessionQuery(session, async () => {
            const status = await f.engine.schedulingStatus({ ...f.agent, session });
            assert.equal(status.releaseBatch.reason, "economical_release");
            assert.ok(status.releaseBatch.releaseTokens > 0);
            assert.equal(status.releaseBatch.deferredCount, 0);
        });
    }
    await f.engine.compactIfNeeded(f.agent, "pressure", signal());
    assert.equal(entry(f).status, "released");
    assert.equal(f.calls.length, 0);
});

test("native replacements reject stale revision permission without side effects", async (t) => {
    const f = await queued(t);
    const cut = await observeSessionCut(f.ctx, f.session);
    t.after(() => cut[Symbol.dispose]());
    const estimate = estimateInlineReleases(f.ctx, f.session, f.engine.state(f.session), cut);
    const permit = planReleaseBatch({
        revision: estimate.revision,
        totalTokens: f.engine.pressureStatus(f.session).totalTokens,
        candidates: estimate.replacements.map((item) => ({
            seq: item.seq,
            savingTokens: item.releasableTokens,
            replacementTokens: item.afterTokens,
            suffixTokens: 0,
        })),
        opportunity: "pressure",
        nowMs: Date.now(),
    });
    f.appendUser("A newer protected input invalidates the old permission.");
    const seq = f.session.seq;
    assert.equal(
        commitInlineReleases(f.ctx, f.session, f.engine.state(f.session), signal(), permit, cut),
        0,
    );
    assert.equal(f.session.seq, seq);
    assert.equal(entry(f).status, "queued");
});

function primaryCacheObservation(f) {
    const route = f.session.requestHeader().config;
    f.session.append("step/start", { turn: 1, step: 99 });
    const observation = f.session.append(
        "assistant/message",
        {
            turn: 1,
            step: 99,
            stream: [],
            message: createAssistantMessage({
                source: { provider: route.provider, model: route.model },
                content: [
                    { type: "text", text: "Primary request completed using the current cache." },
                ],
            }),
            usage: {
                inputTokens: f.meter.measure(f.session).totalTokens,
                outputTokens: 1,
                cacheReadTokens: 1000,
            },
        },
        { surfaceOp: "append" },
    );
    f.session.append("step/end", { turn: 1, step: 99 });
    return observation;
}

test("a real primary cache HIT permits the idle TTL batch on the same route", async (t) => {
    const f = await queued(t, { scheduling: { cacheTtlMs: 1000 } });
    const observation = primaryCacheObservation(f);
    const now = Date.now;
    Date.now = () => observation.time + 1000;
    try {
        const status = await f.engine.schedulingStatus(f.agent);
        assert.equal(status.releaseBatch.reason, "cache_expired");
        await f.engine.compactIfNeeded(f.agent, "pressure", signal());
        assert.equal(entry(f).status, "released");
        assert.equal(f.calls.length, 0);
    } finally {
        Date.now = now;
    }
});

test("an independent replacement later in the prompt does not authorize an earlier release", async (t) => {
    const f = await queued(t);
    const victim = f.appendUser("Later native history row. ".repeat(100));
    primaryCacheObservation(f);
    f.session.append(
        "user/message",
        freezeMessage({
            ...victim.data,
            content: [{ type: "text", text: "Later native history row shortened." }],
        }),
        {
            sourceEventSeqs: [victim.seq],
            surfaceOp: { op: "replace", startSeq: victim.seq, endSeq: victim.seq },
        },
    );
    const evidence = await withSessionCut(f.ctx, f.session, (cut) =>
        f.engine.rebuildEvidence(f.session, cut),
    );
    assert.ok(evidence.independentRebuildTokens > 0);
    await f.engine.compactIfNeeded(f.agent, "pressure", signal());
    assert.equal(entry(f).status, "queued");
    assert.ok(f.session.surface.nodes.includes(f.original.seq));
    assert.equal(f.calls.length, 0);
});

test("a previous inline batch cannot manufacture permission for another pending batch", async (t) => {
    const f = await queued(t);
    const second = f.toolRound("read_second_archive", "SECOND_ARCHIVE_CONTENT ".repeat(2000));
    const secondId = f.idFor(second);
    f.appendUser("Later retained business evidence. ".repeat(1000));
    primaryCacheObservation(f);
    assert.ok((await commitForcedReleases(f)) > 0);
    assert.equal(entry(f).status, "released");
    const marked = await f.invoke("context_release", {
        ids: [Number(secondId)],
        reason: "Second archive consumed",
    });
    assert.equal(marked.isError, false);
    await f.engine.compactIfNeeded(f.agent, "pressure", signal());
    assert.equal(
        f.engine.state(f.session).entries.find((item) => item.id === secondId).status,
        "queued",
    );
    assert.ok(f.session.surface.nodes.includes(second.seq));
    assert.equal(f.calls.length, 0);
});

test("native release-control cleanup cannot purchase another batch or rebuild credit on replay", async (t) => {
    const f = await queued(t);
    primaryCacheObservation(f);
    assert.ok((await commitForcedReleases(f)) > 0);
    assert.equal(entry(f).status, "released");
    f.advanceSteps(100);
    f.session.append("step/start", { turn: 1, step: 100 });
    await f.ctx.waterfall(
        "agent/request",
        { agent: f.agent, turn: 1, step: 100, signal: signal() },
        async () => ({ provider: "test", model: "fixture" }),
    );
    f.session.append("step/end", { turn: 1, step: 100 });
    assert.ok(
        f.session
            .snapshotEvents()
            .some(
                (event) =>
                    event.type === "developer/message" &&
                    event.data.message.source.kind === "fold-context-release-cleanup",
            ),
    );
    const second = f.toolRound("read_second_archive", "SECOND_QUEUED_ARCHIVE ".repeat(2000));
    const secondId = f.idFor(second);
    await f.invoke("context_release", {
        ids: [Number(secondId)],
        reason: "Second archive consumed",
    });
    f.appendUser("Later retained task evidence. ".repeat(1000));
    const cold = Session.create(
        f.session.id,
        JSON.parse(JSON.stringify(f.session.snapshotEvents())),
        f.session.header,
    );
    for (const session of [f.session, cold]) {
        await f.withSessionQuery(session, async () => {
            const evidence = await withSessionCut(f.ctx, session, (cut) =>
                f.engine.rebuildEvidence(session, cut),
            );
            assert.equal(evidence.rebuildStartSeq, null);
            assert.equal(evidence.independentRebuildTokens, 0);
            assert.equal(
                (await f.engine.schedulingStatus({ ...f.agent, session })).releaseBatch.decision,
                "wait",
            );
        });
    }
    await f.engine.compactIfNeeded(f.agent, "pressure", signal());
    assert.equal(
        f.engine.state(f.session).entries.find((item) => item.id === secondId).status,
        "queued",
    );
    assert.ok(f.session.surface.nodes.includes(second.seq));
    assert.equal(f.calls.length, 0);
});

test("a deferred old replacement does not hold back a cheap recent release", async (t) => {
    const f = await queued(t);
    const recent = f.toolRound("read_recent", "RECENT_CONSUMED_RESULT ".repeat(400));
    const recentId = f.idFor(recent);
    const outcome = await f.invoke("context_release", {
        ids: [Number(recentId)],
        reason: "The recent result has been consumed",
    });
    assert.equal(outcome.isError, false);
    f.appendUser("Continue the current task.");
    const before = await f.engine.schedulingStatus(f.agent);
    assert.equal(before.releaseBatch.decision, "execute");
    assert.ok(before.releaseBatch.deferredCount > 0);
    assert.ok(before.releaseBatch.selectedSeqs.includes(recent.seq));
    assert.equal(before.releaseBatch.selectedSeqs.includes(f.original.seq), false);
    assert.equal(await f.engine.compactIfNeeded(f.agent, "pressure", signal()), null);
    assert.equal(entry(f).status, "queued");
    assert.equal(
        f.engine.state(f.session).entries.find((item) => item.id === recentId).status,
        "released",
    );
    assert.ok(f.session.surface.nodes.includes(f.original.seq));
    assert.equal(f.session.surface.nodes.includes(recent.seq), false);
    assert.equal(f.calls.length, 0);
});
