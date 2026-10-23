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
    targetTokens: 17000,
    safetyTokens: 24000,
    growthTokens: 500,
    ...overrides,
});

test("normalized cycle costs replace configured request horizons", () => {
    const policy = resolveSchedulingPolicy();
    assert.deepEqual(Object.keys(policy).sort(), [
        "cacheReadRatio",
        "cacheTtlMs",
        "summaryInputRatio",
        "summaryOutputRatio",
    ]);
    const plan = planScheduledCompaction(candidate());
    assert.ok(Number.isFinite(plan.currentUnitCost));
    assert.ok(plan.bestUnitCost <= plan.currentUnitCost);
    assert.ok(plan.recommendedAtTokens >= plan.postReleaseTokens);
    assert.ok(plan.recommendedAtTokens <= plan.latestStartTokens);
    assert.equal(plan.confidence, "observed_growth");
    const later = planScheduledCompaction(candidate({ stepsSinceSummary: 100000 }));
    assert.deepEqual(later, plan, "elapsed steps cannot manufacture economic savings");
});

test("more expensive cache never pushes the bounded execution deadline later", () => {
    let lastDeadline = Infinity;
    for (const cacheReadRatio of [0, 0.01, 0.1, 0.5, 0.9, 1]) {
        const plan = planScheduledCompaction(candidate(), { cacheReadRatio });
        assert.ok(plan.latestStartTokens <= lastDeadline);
        lastDeadline = plan.latestStartTokens;
        assert.equal(plan.effectiveCacheReadRatio, cacheReadRatio);
        assert.equal(plan.initialRebuildPenalty, plan.rebuiltSuffixTokens * (1 - cacheReadRatio));
    }
});

test("pressure urgency grows monotonically and safety overrides adverse costs", () => {
    let urgency = -1;
    let executed = false;
    for (const totalTokens of [17000, 18000, 20000, 22000, 23500, 24000]) {
        const plan = planScheduledCompaction(
            candidate({ totalTokens, selectedTokens: totalTokens - 4000 }),
            {
                cacheReadRatio: 0,
                summaryInputRatio: 1000,
            },
        );
        assert.ok(plan.urgency >= urgency);
        urgency = plan.urgency;
        if (executed) assert.equal(plan.decision, "execute");
        executed ||= plan.decision === "execute";
        if (totalTokens >= 23500) assert.equal(plan.reason, "safety_pressure");
    }
    assert.equal(executed, true);
});

test("inline release is discounted from summary gains without charging the summary twice", () => {
    const baseline = planScheduledCompaction(candidate());
    const released = planScheduledCompaction(
        candidate({ inlineReleaseTokens: 4000, postReleaseTokens: 8000 }),
    );
    assert.equal(baseline.netSavingTokens, 6800);
    assert.equal(released.netSavingTokens, 2800);
    assert.equal(released.summaryCost, baseline.summaryCost);
    assert.equal(released.summaryCost, 7200);
    assert.equal(released.predictedAfterTokens, 5200);
    const entire = planScheduledCompaction(candidate({ inlineReleaseTokens: 8000 }));
    assert.equal(entire.netSavingTokens, 0);
    assert.equal(entire.reason, "no_savings");
});

test("stable request envelope is preserved and actual summary cache share discounts input only", () => {
    const base = candidate({ totalTokens: 15000, headerOverheadTokens: 3000 });
    const independent = planScheduledCompaction(base, {
        cacheReadRatio: 0.1,
        summaryOutputRatio: 2,
    });
    const shared = planScheduledCompaction(
        { ...base, summaryCacheShare: 1 },
        { cacheReadRatio: 0.1, summaryOutputRatio: 2 },
    );
    assert.equal(independent.rebuiltSuffixTokens, 4200);
    assert.equal(independent.initialRebuildPenalty, 3780);
    assert.equal(independent.summaryCost, 6000 + 1200 * 2);
    assert.ok(Math.abs(shared.summaryCost - (600 + 1200 * 2)) < 1e-9);
    assert.equal(shared.initialRebuildPenalty, independent.initialRebuildPenalty);
    const expired = planScheduledCompaction({ ...base, cacheExpired: true });
    assert.equal(expired.initialRebuildPenalty, 0);
    assert.equal(expired.summaryCost, 7200);
});

test("an observed cache miss is diagnostic, not proof that future caching is free", () => {
    const { cacheState: hit, ...cached } = planScheduledCompaction(
        candidate({ cacheState: "cached" }),
    );
    const { cacheState: miss, ...uncached } = planScheduledCompaction(
        candidate({ cacheState: "uncached" }),
    );
    assert.equal(hit, "cached");
    assert.equal(miss, "uncached");
    assert.ok(uncached.initialRebuildPenalty > 0);
    assert.deepEqual(uncached, cached);
});

async function history(t, scheduling = {}, compaction = {}) {
    const f = await fixture({ compaction: { targetTokens: 4096, ...compaction }, scheduling });
    t.after(f.close);
    f.session.append("turn/start", { turn: 1 });
    for (let step = 0; step < 8; step++)
        f.toolRound("completed_work", "Evidence and conclusions of completed work. ".repeat(128));
    await f.invoke("context_compact", { reason: "Preserve conclusions from completed work." });
    f.appendUser(
        "Keep the complete active task requirements. ".repeat(
            Math.max(200, Math.ceil((compaction.targetTokens ?? 4096) / 40)),
        ),
    );
    return f;
}

test("expensive cache admits a real checkpoint at the configured target", async (t) => {
    const f = await history(t, {}, { cacheReadRatio: 1 });
    const status = await f.engine.schedulingStatus(f.agent);
    assert.equal(status.reason, "window_pressure");
    assert.equal(status.plan.effectiveCacheReadRatio, 1);
    assert.ok(status.plan.totalTokens >= status.plan.targetTokens);
    assert.ok(await f.engine.compactIfNeeded(f.agent, "pressure", new AbortController().signal));
    assert.equal(f.calls.length, 1);
    assert.equal(f.engine.hasSummaryRequest(f.session), false);
});

test("cheap cache below the target preserves queued intent without changing the surface", async (t) => {
    const f = await history(t, {}, { cacheReadRatio: 0, targetTokens: 100000 });
    const status = await f.engine.schedulingStatus(f.agent);
    assert.equal(status.reason, "cost_deferred");
    assert.match(status.diagnostic.summary, /later checkpoint/);
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
    test(`${trigger} recovery bypasses zero cache savings and large summary costs`, async (t) => {
        const f = await history(
            t,
            { summaryInputRatio: 1000 },
            { cacheReadRatio: 0, auto: trigger === "pressure", targetTokens: 2048 },
        );
        f.llm.resolveModelInfo = async () => ({ context: { contextWindow: 4096 } });
        assert.ok(await f.engine.compactIfNeeded(f.agent, trigger, new AbortController().signal));
        assert.equal(f.calls.length, 1);
    });
}
