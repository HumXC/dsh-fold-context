import test from "node:test";
import assert from "node:assert/strict";
import { Session } from "@deepseek-ai/dsh-session";
import { createAssistantMessage, freezeMessage } from "@deepseek-ai/dsh-llm";
import { commitForcedReleases } from "./release-batch-fixture.mjs";
import { fixture } from "./fixture.mjs";
import { planReleaseBatch } from "../lib/domain/scheduler.js";
import { commitInlineReleases, estimateInlineReleases } from "../lib/integration/inline-release.js";

const signal = () => new AbortController().signal;
const waiting = {
    enabled: true,
    proactive: false,
    releaseMinTokens: 1,
    releaseMaxWaitSteps: 100,
    releaseBacklogRatio: 1,
    cacheTtlMs: 0,
};

async function queued(t, options = {}) {
    const f = await fixture({
        ...options,
        compaction: { auto: false, retainTokens: 32, ...options.compaction },
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
    f.appendUser("Continue the current task using the extracted facts.");
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
    const f = await queued(t, { compaction: { auto: true, thresholdRatio: 0.8 } });
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
    assert.ok(f.engine.pressureStatus(f.session).totalTokens < before * 0.8);
});

test("remaining pressure builds both range and auxiliary summary from the released surface", async (t) => {
    const f = await queued(t, { compaction: { auto: true, thresholdRatio: 0.8 } });
    f.appendUser("Unmarked historical business evidence. ".repeat(3000));
    f.toolRound("work_on_history", "Extracted the old unmarked evidence.");
    f.appendUser("Protect this latest input.");
    const before = f.engine.pressureStatus(f.session).totalTokens;
    f.llm.resolveModelInfo = async () => ({ context: { contextWindow: Math.ceil(before * 0.55) } });
    const seen = [];
    const originalRange = f.engine.pressureRange.bind(f.engine);
    f.engine.pressureRange = (session, measurement, retain) => {
        seen.push({
            total: measurement.totalTokens,
            nodes: measurement.nodes.map((node) => node.seq),
        });
        return originalRange(session, measurement, retain);
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

test("maximum wait is replayable business progress and admits one combined release", async (t) => {
    const f = await queued(t, { scheduling: { releaseMaxWaitSteps: 2 } });
    f.toolRound("work_a", "Completed independent business work.");
    f.toolRound("work_b", "Completed another independent business step.");
    const cold = Session.create(
        f.session.id,
        JSON.parse(JSON.stringify(f.session.snapshotEvents())),
        f.session.header,
    );
    for (const session of [f.session, cold]) {
        const status = await f.engine.schedulingStatus({ ...f.agent, session });
        assert.equal(status.releaseBatch.reason, "max_wait");
        assert.ok(status.releaseBatch.oldestWaitSteps >= 2);
    }
    await f.engine.compactIfNeeded(f.agent, "pressure", signal());
    assert.equal(entry(f).status, "released");
    assert.equal(f.calls.length, 0);
});

test("native replacements reject stale revision permission without side effects", async (t) => {
    const f = await queued(t);
    const estimate = estimateInlineReleases(f.ctx, f.session, f.engine.state(f.session));
    const permit = planReleaseBatch({
        revision: estimate.revision,
        totalTokens: f.engine.pressureStatus(f.session).totalTokens,
        releaseTokens: Math.max(0, estimate.beforeTokens - estimate.afterTokens),
        releaseCount: estimate.replacementCount,
        oldestWaitSteps: 0,
        opportunity: "pressure",
        nowMs: Date.now(),
    });
    f.appendUser("A newer protected input invalidates the old permission.");
    const seq = f.session.seq;
    assert.equal(
        commitInlineReleases(f.ctx, f.session, f.engine.state(f.session), signal(), permit),
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
    assert.ok(f.engine.rebuildEvidence(f.session).independentRebuildTokens > 0);
    await f.engine.compactIfNeeded(f.agent, "pressure", signal());
    assert.equal(entry(f).status, "queued");
    assert.ok(f.session.surface.nodes.includes(f.original.seq));
    assert.equal(f.calls.length, 0);
});

test("a previous inline batch cannot manufacture permission for another pending batch", async (t) => {
    const f = await queued(t);
    const second = f.toolRound("read_second_archive", "SECOND_ARCHIVE_CONTENT ".repeat(2000));
    const secondId = f.idFor(second);
    primaryCacheObservation(f);
    assert.ok(commitForcedReleases(f) > 0);
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
    assert.ok(commitForcedReleases(f) > 0);
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
    const cold = Session.create(
        f.session.id,
        JSON.parse(JSON.stringify(f.session.snapshotEvents())),
        f.session.header,
    );
    for (const session of [f.session, cold]) {
        const evidence = f.engine.rebuildEvidence(session);
        assert.equal(evidence.rebuildStartSeq, null);
        assert.equal(evidence.independentRebuildTokens, 0);
        assert.equal(
            (await f.engine.schedulingStatus({ ...f.agent, session })).releaseBatch.decision,
            "wait",
        );
    }
    await f.engine.compactIfNeeded(f.agent, "pressure", signal());
    assert.equal(
        f.engine.state(f.session).entries.find((item) => item.id === secondId).status,
        "queued",
    );
    assert.ok(f.session.surface.nodes.includes(second.seq));
    assert.equal(f.calls.length, 0);
});
