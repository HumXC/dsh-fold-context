import test from "node:test";
import assert from "node:assert/strict";
import { planScheduledCompaction, resolveSchedulingPolicy } from "../lib/domain/scheduler.js";
import { fixture } from "./fixture.mjs";

const candidate = (overrides = {}) => ({
    trigger: "model_request",
    totalTokens: 12000,
    selectedTokens: 8000,
    prefixTokens: 1000,
    filterInputTokens: 6000,
    stepsSinceSummary: 8,
    markedIds: [],
    ...overrides,
});

test("default long-session horizon keeps realistic cached costs and rejects expensive tails", () => {
    const policy = resolveSchedulingPolicy();
    assert.equal(policy.paybackTurns, 24);
    assert.equal(policy.cacheReadRatio, 0.1);
    for (const cacheState of ["unknown", "cached"]) {
        const plan = planScheduledCompaction(candidate({ cacheState, filterInputTokens: 8000 }));
        assert.equal(plan.breakEvenTurns, 22);
        assert.equal(plan.reason, "eligible");
        assert.equal(plan.effectiveCacheReadRatio, 0.1);
    }
    const expensive = planScheduledCompaction(
        candidate({ totalTokens: 21000, filterInputTokens: 8000 }),
    );
    assert.equal(expensive.breakEvenTurns, 35);
    assert.equal(expensive.reason, "not_paid_back");
});

test("configured payback horizons have exact boundaries and elapsed steps do not create savings", () => {
    for (const stepsSinceSummary of [8, 100]) {
        for (const [input, before, boundary] of [
            [6000, 16, 17],
            [8000, 21, 22],
        ]) {
            const value = candidate({ filterInputTokens: input, stepsSinceSummary });
            assert.equal(
                planScheduledCompaction(value, { paybackTurns: before }).reason,
                "not_paid_back",
            );
            assert.equal(
                planScheduledCompaction(value, { paybackTurns: boundary }).reason,
                "eligible",
            );
        }
        assert.equal(
            planScheduledCompaction(candidate({ filterInputTokens: 2000, stepsSinceSummary }), {
                paybackTurns: 8,
            }).reason,
            "eligible",
        );
        assert.equal(
            planScheduledCompaction(candidate({ filterInputTokens: 2500, stepsSinceSummary }), {
                paybackTurns: 8,
            }).reason,
            "not_paid_back",
        );
    }
});

async function history(t, scheduling = {}, compaction = {}) {
    const f = await fixture({ compaction: { retainTokens: 256, ...compaction }, scheduling });
    t.after(f.close);
    f.session.append("turn/start", { turn: 1 });
    for (let step = 0; step < 8; step++) {
        f.toolRound("completed_work", "Evidence and conclusions of completed work. ".repeat(128));
    }
    await f.invoke("context_compact", { reason: "Preserve conclusions from completed work." });
    f.appendUser("Keep the complete active task requirements. ".repeat(80));
    return f;
}

test("the default economic policy executes a real low-pressure checkpoint without cheap-cost overrides", async (t) => {
    const f = await history(t);
    const status = await f.engine.schedulingStatus(f.agent);
    assert.equal(status.reason, "eligible");
    assert.equal(status.plan.cacheState, "unknown");
    assert.equal(status.plan.effectiveCacheReadRatio, 0.1);
    assert.ok(status.plan.breakEvenTurns > 8 && status.plan.breakEvenTurns <= 24);
    assert.ok(status.pressure.totalTokens < status.pressure.thresholdTokens);
    assert.ok(await f.engine.compactIfNeeded(f.agent, "pressure", new AbortController().signal));
    assert.equal(f.calls.length, 1);
    assert.equal(f.engine.hasSummaryRequest(f.session), false);
});

test("an explicit short horizon preserves queued intent rather than silently forcing a checkpoint", async (t) => {
    const f = await history(t, { paybackTurns: 8 });
    const status = await f.engine.schedulingStatus(f.agent);
    assert.equal(status.reason, "not_paid_back");
    assert.match(status.diagnostic.summary, /future primary requests.*8/);
    const surface = [...f.session.surface.nodes];
    assert.equal(
        await f.engine.compactIfNeeded(f.agent, "pressure", new AbortController().signal),
        null,
    );
    assert.deepEqual(f.session.surface.nodes, surface);
    assert.equal(f.engine.hasSummaryRequest(f.session), true);
    assert.equal(f.calls.length, 0);
});

for (const trigger of ["pressure", "context-overflow"]) {
    test(`${trigger} recovery bypasses zero cache savings, large summary costs and an unmet interval`, async (t) => {
        const f = await history(
            t,
            { cacheReadRatio: 0, summaryInputRatio: 1000, minIntervalSteps: 10000 },
            { auto: trigger === "pressure" },
        );
        if (trigger === "pressure") {
            f.llm.resolveModelInfo = async () => ({ context: { contextWindow: 4096 } });
        }
        assert.ok(await f.engine.compactIfNeeded(f.agent, trigger, new AbortController().signal));
        assert.equal(f.calls.length, 1);
    });
}
