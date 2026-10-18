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

test("inline release is discounted from summary gains while the filtered summary is charged once", () => {
    const baseline = planScheduledCompaction(candidate());
    const discounted = planScheduledCompaction(candidate({ inlineReleaseTokens: 4000 }));
    assert.equal(baseline.inlineReleaseTokens, 0);
    assert.equal(baseline.postReleaseTokens, 12000);
    assert.equal(baseline.netSavingTokens, 6800);
    assert.equal(discounted.inlineReleaseTokens, 4000);
    assert.equal(discounted.netSavingTokens, 2800);
    assert.equal(discounted.reason, "not_paid_back");
    assert.equal(discounted.filterInputTokens, baseline.filterInputTokens);
    assert.equal(discounted.predictedSummaryTokens, baseline.predictedSummaryTokens);
    assert.equal(discounted.summaryCost, baseline.summaryCost);
    assert.equal(discounted.summaryCost, 6000 + 1200);
    const entirelyReleased = planScheduledCompaction(candidate({ inlineReleaseTokens: 8000 }));
    assert.equal(entirelyReleased.netSavingTokens, 0);
    assert.equal(entirelyReleased.reason, "min_savings");
    assert.equal(entirelyReleased.summaryCost, baseline.summaryCost);
});

test("the ratio gate uses the prompt remaining after release without changing summary cost", () => {
    const policy = { minSavingsRatio: 0.5, paybackTurns: 96 };
    const before = planScheduledCompaction(candidate({ inlineReleaseTokens: 2000 }), policy);
    const after = planScheduledCompaction(
        candidate({ inlineReleaseTokens: 2000, postReleaseTokens: 6000 }),
        policy,
    );
    assert.equal(before.netSavingTokens, 4800);
    assert.equal(before.savingsRatio, 0.4);
    assert.equal(before.reason, "min_ratio");
    assert.equal(after.postReleaseTokens, 6000);
    assert.equal(after.savingsRatio, 0.8);
    assert.equal(after.reason, "eligible");
    assert.equal(after.summaryCost, before.summaryCost);
    assert.equal(after.breakEvenTurns, before.breakEvenTurns);
});

test("an observed cache miss remains diagnostic and does not waive future rebuild or summary costs", () => {
    const { cacheState: cachedState, ...cached } = planScheduledCompaction(
        candidate({ cacheState: "cached" }),
    );
    const { cacheState: uncachedState, ...uncached } = planScheduledCompaction(
        candidate({ cacheState: "uncached" }),
    );
    assert.equal(cachedState, "cached");
    assert.equal(uncachedState, "uncached");
    assert.ok(uncached.initialRebuildPenalty > 0);
    assert.ok(uncached.summaryCost > 0);
    assert.deepEqual(uncached, cached);
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
