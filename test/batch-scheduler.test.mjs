import test from "node:test";
import assert from "node:assert/strict";
import {
    cacheExpiryEvidence,
    planReleaseBatch,
    planScheduledCompaction,
} from "../lib/domain/scheduler.js";

const cache = Object.freeze({
    routeSignature: "primary-a",
    usageRouteSignature: "primary-a",
    usageAtMs: 1000,
    cacheReadTokens: 4000,
});
const candidate = (patch = {}) => ({
    revision: 42,
    totalTokens: 100000,
    releaseTokens: 3000,
    releaseCount: 2,
    oldestWaitSteps: 0,
    nowMs: 2000,
    cache,
    ...patch,
});

test("marks do not buy an independent rebuild and hot small batches wait", () => {
    const input = Object.freeze(candidate());
    assert.equal(planReleaseBatch(input).reason, "hot_cache");
    assert.equal(planReleaseBatch(input).decision, "wait");
    assert.deepEqual(planReleaseBatch(input), planReleaseBatch(input));
    for (const opportunity of ["summary", "rebuild", "pressure", "overflow"]) {
        const plan = planReleaseBatch(candidate({ opportunity, releaseTokens: 1 }));
        assert.equal(plan.decision, "execute");
        assert.equal(plan.reason, `opportunity_${opportunity}`);
    }
    assert.equal(
        planReleaseBatch(candidate({ opportunity: "pressure", activeCompaction: true })).decision,
        "wait",
    );
    assert.equal(
        planReleaseBatch(candidate({ releaseCount: 0, opportunity: "summary" })).reason,
        "no_releases",
    );
});

test("TTL expiry needs a same-route primary cache HIT and millisecond elapsed time", () => {
    assert.equal(cacheExpiryEvidence(cache, 1999, 1000), false);
    assert.equal(cacheExpiryEvidence(cache, 2000, 1000), true);
    assert.equal(cacheExpiryEvidence(cache, 2000, 0), false);
    assert.equal(cacheExpiryEvidence(cache, 999, 1000), false);
    assert.equal(
        cacheExpiryEvidence({ ...cache, usageRouteSignature: "other" }, 999999, 1000),
        false,
    );
    assert.equal(cacheExpiryEvidence({ ...cache, cacheReadTokens: 0 }, 999999, 1000), false);
    assert.equal(cacheExpiryEvidence(null, 999999, 1000), false);
    assert.equal(planReleaseBatch(candidate(), { cacheTtlMs: 1000 }).reason, "cache_expired");
    assert.equal(
        planReleaseBatch(candidate({ cache: { ...cache, cacheReadTokens: 0 }, nowMs: 999999 }))
            .reason,
        "hot_cache",
    );
});

test("maximum business-step wait and prompt-relative backlog provide bounded fallback", () => {
    assert.equal(planReleaseBatch(candidate({ oldestWaitSteps: 15 })).decision, "wait");
    assert.equal(
        planReleaseBatch(candidate({ oldestWaitSteps: 16, releaseTokens: 1 })).reason,
        "max_wait",
    );
    assert.equal(planReleaseBatch(candidate({ releaseTokens: 14999 })).decision, "wait");
    assert.equal(planReleaseBatch(candidate({ releaseTokens: 15000 })).reason, "backlog_watermark");
    assert.equal(
        planReleaseBatch(candidate({ releaseTokens: 0, oldestWaitSteps: 999 })).decision,
        "wait",
    );
    assert.equal(
        planReleaseBatch(candidate({ releaseTokens: 2047, nowMs: 999999 })).reason,
        "min_release",
    );
});

test("summary always pays auxiliary cost and only independent work offsets rebuild", () => {
    const input = {
        trigger: "model_request",
        totalTokens: 12000,
        selectedTokens: 8000,
        prefixTokens: 1000,
        excludedTokens: 2000,
        stepsSinceSummary: 8,
        markedIds: ["17"],
        cacheState: "cached",
    };
    const hot = planScheduledCompaction(input);
    const miss = planScheduledCompaction({ ...input, cacheState: "uncached" });
    assert.equal(miss.initialRebuildPenalty, hot.initialRebuildPenalty);
    assert.equal(miss.effectiveCacheReadRatio, hot.effectiveCacheReadRatio);
    const partlyPaid = planScheduledCompaction({ ...input, independentRebuildTokens: 1000 });
    const paid = planScheduledCompaction({
        ...input,
        independentRebuildTokens: hot.rebuiltSuffixTokens,
    });
    const expired = planScheduledCompaction({ ...input, cacheExpired: true });
    assert.equal(partlyPaid.initialRebuildPenalty, 2880);
    assert.equal(paid.initialRebuildPenalty, 0);
    assert.equal(expired.initialRebuildPenalty, 0);
    for (const plan of [hot, miss, partlyPaid, paid, expired]) assert.equal(plan.summaryCost, 7200);
    assert.equal(paid.perTurnSaving, hot.perTurnSaving);
    assert.equal(paid.breakEvenTurns, Math.ceil(paid.summaryCost / paid.perTurnSaving));
    assert.throws(() => planScheduledCompaction({ ...input, pendingAlreadyPaid: true }));
});

test("release policies and count inputs reject invalid values", () => {
    for (const patch of [
        { releaseCount: -1 },
        { oldestWaitSteps: 0.5 },
        { releaseTokens: Infinity },
        { revision: -1 },
    ])
        assert.throws(() => planReleaseBatch(candidate(patch)));
    for (const policy of [
        { releaseMaxWaitSteps: 0 },
        { releaseBacklogRatio: 0 },
        { releaseBacklogRatio: 1.1 },
        { cacheTtlMs: -1 },
    ])
        assert.throws(() => planReleaseBatch(candidate(), policy));
});
