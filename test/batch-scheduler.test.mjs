import test from "node:test";
import assert from "node:assert/strict";
import { cacheExpiryEvidence, planReleaseBatch } from "../lib/domain/scheduler.js";
import { estimateInlineReleases } from "../lib/integration/inline-release.js";
import { withSessionCut } from "../lib/integration/session-cut.js";
import { fixture } from "./fixture.mjs";
const cache = {
    routeSignature: "a",
    usageRouteSignature: "a",
    usageAtMs: 1000,
    cacheReadTokens: 4000,
};
const candidate = (patch = {}) => ({
    revision: 42,
    totalTokens: 100000,
    targetTokens: 170000,
    safetyTokens: 220000,
    nowMs: 2000,
    cache,
    candidates: [{ seq: 10, savingTokens: 3000, replacementTokens: 10, suffixTokens: 50000 }],
    ...patch,
});
test("older expensive releases await a checkpoint; recent releases settle promptly", () => {
    assert.equal(planReleaseBatch(candidate()).reason, "await_summary");
    const mixed = planReleaseBatch(
        candidate({
            candidates: [
                { seq: 10, savingTokens: 3000, replacementTokens: 10, suffixTokens: 50000 },
                { seq: 20, savingTokens: 2000, replacementTokens: 10, suffixTokens: 100 },
            ],
        }),
    );
    assert.equal(mixed.decision, "execute");
    assert.deepEqual(mixed.selectedSeqs, [20]);
    assert.equal(mixed.deferredCount, 1);
    assert.equal(mixed.releaseTokens, 2000);
    assert.equal(mixed.rebuildTokens, 110);
});
test("a batch charges the suffix once and deducts already removed bodies", () => {
    const plan = planReleaseBatch(
        candidate({
            opportunity: "pressure",
            candidates: [
                { seq: 10, savingTokens: 3000, replacementTokens: 10, suffixTokens: 3000 },
                { seq: 20, savingTokens: 2000, replacementTokens: 10, suffixTokens: 100 },
            ],
        }),
    );
    assert.equal(plan.releaseTokens, 5000);
    assert.equal(plan.rebuildTokens, 1010);
    assert.deepEqual(plan.selectedSeqs, [20, 10]);
});
test("independent opportunities release older evidence but active transactions protect it", () => {
    for (const opportunity of ["summary", "rebuild", "pressure", "overflow"]) {
        const plan = planReleaseBatch(candidate({ opportunity }));
        assert.equal(plan.decision, "execute");
        assert.equal(plan.reason, "opportunity_" + opportunity);
        assert.equal(
            planReleaseBatch(candidate({ opportunity, activeCompaction: true })).decision,
            "wait",
        );
    }
    assert.equal(planReleaseBatch(candidate({ candidates: [] })).reason, "no_releases");
});
test("zero saving is never committed, even during pressure", () => {
    assert.equal(
        planReleaseBatch(
            candidate({
                opportunity: "pressure",
                candidates: [{ seq: 1, savingTokens: 0, replacementTokens: 10, suffixTokens: 0 }],
            }),
        ).decision,
        "wait",
    );
});
test("mixed batches defer nonpositive replacements even when release is otherwise allowed", () => {
    const candidates = [
        { seq: 2, savingTokens: 0, replacementTokens: 100, suffixTokens: 0 },
        { seq: 1, savingTokens: 20, replacementTokens: 10, suffixTokens: 1 },
    ];
    for (const opportunity of [undefined, "summary", "rebuild", "pressure", "overflow"]) {
        const plan = planReleaseBatch(candidate({ candidates, opportunity }));
        assert.equal(plan.decision, "execute");
        assert.deepEqual(plan.selectedSeqs, [1]);
        assert.equal(plan.releaseCount, 1);
        assert.equal(plan.deferredCount, 1);
        assert.equal(plan.deferredTokens, 0);
        assert.equal(plan.releaseTokens, 20);
        // The skipped newest body stays at its original one token, not its 100-token replacement.
        assert.equal(plan.rebuildTokens, 11);
    }
});
test("skipped replacements stay in suffix costs between profitable batch members", () => {
    const plan = planReleaseBatch(
        candidate({
            opportunity: "pressure",
            candidates: [
                { seq: 10, savingTokens: 90, replacementTokens: 10, suffixTokens: 47 },
                { seq: 20, savingTokens: 0, replacementTokens: 11, suffixTokens: 36 },
                { seq: 30, savingTokens: 30, replacementTokens: 1, suffixTokens: 5 },
                { seq: 40, savingTokens: 0, replacementTokens: 15, suffixTokens: 0 },
            ],
        }),
    );
    assert.deepEqual(plan.selectedSeqs, [30, 10]);
    assert.equal(plan.releaseTokens, 120);
    assert.equal(plan.deferredCount, 2);
    assert.equal(plan.deferredTokens, 0);
    // New selected bodies (10 + 1), unchanged middle body (11), unchanged newest body (5).
    assert.equal(plan.rebuildTokens, 27);
    assert.equal(plan.rebuildCost, 27 * 0.9);
});
test("an unchanged zero-saving suffix can still make a positive replacement uneconomical", () => {
    const plan = planReleaseBatch(
        candidate({
            candidates: [
                { seq: 2, savingTokens: 0, replacementTokens: 100, suffixTokens: 0 },
                { seq: 1, savingTokens: 10, replacementTokens: 10, suffixTokens: 100 },
            ],
        }),
    );
    assert.equal(plan.decision, "wait");
    assert.deepEqual(plan.selectedSeqs, []);
    assert.equal(plan.deferredCount, 2);
    assert.equal(plan.deferredTokens, 10);
});
test("real short tool results do not piggyback negative savings onto a profitable release", async () => {
    const f = await fixture();
    try {
        const profitable = f.toolRound("read", "x".repeat(16));
        const growing = f.toolRound("read", "ok");
        const profitableId = f.idFor(profitable);
        const growingId = f.idFor(growing);
        await f.invoke("context_release", {
            ids: [Number(profitableId), Number(growingId)],
            reason: "Consumed evidence",
        });
        const { estimate, plan } = await withSessionCut(f.ctx, f.session, (cut) => ({
            estimate: estimateInlineReleases(f.ctx, f.session, f.engine.state(f.session), cut),
            plan: f.engine.releasePlan(f.session, cut, "pressure"),
        }));
        const positive = estimate.replacements.filter(
            (item) => item.beforeTokens > item.afterTokens,
        );
        assert.equal(positive.length, 1);
        assert.ok(estimate.beforeTokens < estimate.afterTokens, "replacing both would grow input");
        assert.deepEqual(
            plan.selectedSeqs,
            positive.map((item) => item.seq),
        );
        assert.equal(plan.releaseTokens, positive[0].beforeTokens - positive[0].afterTokens);
        assert.equal(plan.deferredCount, 1);
        assert.equal(
            await f.engine.releaseBatch(f.agent, new AbortController().signal, "pressure"),
            1,
        );
        const entries = f.engine.state(f.session).entries;
        assert.equal(entries.find((entry) => entry.id === profitableId)?.status, "released");
        assert.equal(entries.find((entry) => entry.id === growingId)?.status, "queued");
    } finally {
        await f.close();
    }
});
test("cache expiry requires explicit TTL and a same-route hit", () => {
    assert.equal(cacheExpiryEvidence(cache, 2000, 1000), true);
    assert.equal(cacheExpiryEvidence(cache, 2000, 0), false);
    assert.equal(cacheExpiryEvidence(cache, 1999, 1000), false);
    assert.equal(cacheExpiryEvidence({ ...cache, usageRouteSignature: "b" }, 9000, 1000), false);
    assert.equal(cacheExpiryEvidence({ ...cache, cacheReadTokens: 0 }, 9000, 1000), false);
    assert.equal(planReleaseBatch(candidate(), { cacheTtlMs: 1000 }).reason, "cache_expired");
});
test("cost and window pressure can release an older candidate without an artificial wait counter", () => {
    assert.equal(planReleaseBatch(candidate(), { cacheReadRatio: 1 }).decision, "execute");
    assert.equal(planReleaseBatch(candidate({ totalTokens: 220000 })).decision, "execute");
});
test("invalid identities, estimates and obsolete policy are rejected", () => {
    for (const patch of [
        { revision: -1 },
        { totalTokens: Infinity },
        { candidates: [{ seq: -1, savingTokens: 1, replacementTokens: 1, suffixTokens: 1 }] },
        {
            candidates: [
                { seq: 1, savingTokens: 1, replacementTokens: 1, suffixTokens: 1 },
                { seq: 1, savingTokens: 1, replacementTokens: 1, suffixTokens: 1 },
            ],
        },
    ])
        assert.throws(() => planReleaseBatch(candidate(patch)));
    assert.throws(() => planReleaseBatch(candidate(), { releaseMaxWaitSteps: 16 }));
});
