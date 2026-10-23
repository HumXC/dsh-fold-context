import test from "node:test";
import assert from "node:assert/strict";
import {
    planScheduledCompaction,
    resolveSchedulingPolicy,
    schedulingPolicySchema,
    selectScheduledRange,
} from "../lib/domain/scheduler.js";

function candidate(overrides = {}) {
    return {
        trigger: "backlog",
        totalTokens: 12000,
        targetTokens: 17000,
        safetyTokens: 22000,
        growthTokens: 1000,
        selectedTokens: 8000,
        prefixTokens: 1000,
        excludedTokens: 2000,
        stepsSinceSummary: 8,
        markedIds: ["17"],
        routeSignature: "summary-route-v1",
        ...overrides,
    };
}

function frozenNodes(values) {
    return Object.freeze(values.map(([seq, tokens]) => Object.freeze({ seq, tokens })));
}

test("retention is positional and moves an illegal tool-result boundary back to its call", () => {
    // Surface order can differ from log order after a summary replacement.
    // 9 is a tool call; 10 its result. A cut before 10 would split the pair.
    const nodes = frozenNodes([
        [50, 1000],
        [80, 3500],
        [4, 1500],
        [9, 1200],
        [10, 1200],
        [3, 1600],
    ]);
    const legalCuts = new Set([80, 4, 9, 3]);
    const input = { nodes, retainTokens: 2500, firstSystemSeq: 50, legalCuts };
    const range = selectScheduledRange(input);
    assert.deepEqual(range, { start: 80, end: 4 });
    const endIndex = nodes.findIndex((node) => node.seq === range.end);
    const retained = nodes.slice(endIndex + 1);
    assert.ok(retained.reduce((sum, node) => sum + node.tokens, 0) >= input.retainTokens);
    assert.deepEqual(
        retained.map((node) => node.seq),
        [9, 10, 3],
    );
    assert.deepEqual(
        selectScheduledRange({
            nodes,
            retainTokens: 2500,
            firstSystemSeq: 50,
            legalCutPredicate: (seq) => legalCuts.has(seq),
        }),
        range,
    );
    assert.deepEqual(
        nodes.map((node) => node.seq),
        [50, 80, 4, 9, 10, 3],
    );
});

test("no system head permits node zero; missing legality or mismatched head fails closed", () => {
    const nodes = frozenNodes([
        [90, 1000],
        [2, 1000],
        [7, 1000],
    ]);
    assert.deepEqual(selectScheduledRange({ nodes, retainTokens: 1000, legalCuts: new Set([7]) }), {
        start: 90,
        end: 2,
    });
    assert.equal(selectScheduledRange({ nodes, retainTokens: 1000 }), null);
    assert.equal(selectScheduledRange({ nodes, retainTokens: 1000, legalCuts: new Set() }), null);
    assert.equal(
        selectScheduledRange({
            nodes,
            retainTokens: 1000,
            firstSystemSeq: 2,
            legalCuts: new Set([7]),
        }),
        null,
    );
    assert.equal(
        selectScheduledRange({
            nodes,
            retainTokens: 1000,
            legalCuts: new Set([7]),
            legalCutPredicate: () => false,
        }),
        null,
    );
    assert.equal(
        selectScheduledRange({ nodes, retainTokens: 3000, legalCuts: new Set([7]) }),
        null,
    );
    assert.equal(
        selectScheduledRange({ nodes: [], retainTokens: 1000, legalCuts: new Set() }),
        null,
    );
    assert.deepEqual(
        selectScheduledRange({
            nodes: frozenNodes([
                [0, 100],
                [2, 1000],
                [3, 0],
            ]),
            retainTokens: 0,
            firstSystemSeq: 0,
            legalCuts: new Set([3]),
        }),
        { start: 2, end: 2 },
    );
    assert.equal(
        selectScheduledRange({
            nodes: [{ seq: 1, tokens: 0 }],
            retainTokens: 1,
            legalCuts: new Set([1]),
        }),
        null,
    );
});

test("selector rejects unsafe identities and budgets instead of guessing a range", () => {
    const valid = {
        nodes: [
            { seq: 1, tokens: 1000 },
            { seq: 2, tokens: 1000 },
        ],
        retainTokens: 1000,
        legalCuts: new Set([2]),
    };
    for (const retainTokens of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
        assert.throws(() => selectScheduledRange({ ...valid, retainTokens }), RangeError);
    }
    for (const seq of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
        assert.throws(
            () => selectScheduledRange({ ...valid, nodes: [{ seq, tokens: 10 }] }),
            RangeError,
        );
    }
    assert.throws(
        () => selectScheduledRange({ ...valid, nodes: [{ seq: 1, tokens: -1 }] }),
        RangeError,
    );
    assert.throws(
        () =>
            selectScheduledRange({
                ...valid,
                nodes: [
                    { seq: 1, tokens: 10 },
                    { seq: 1, tokens: 20 },
                ],
            }),
        /duplicate surface seq/,
    );
    assert.throws(
        () =>
            selectScheduledRange({
                ...valid,
                nodes: [
                    { seq: 1, tokens: Number.MAX_SAFE_INTEGER },
                    { seq: 2, tokens: 1 },
                ],
            }),
        /surfaceTokens/,
    );
});

test("normalized costs preserve the unchanged prefix and credit only independent rebuild", () => {
    const hot = planScheduledCompaction(candidate());
    assert.equal(hot.predictedSummaryTokens, 1200);
    assert.equal(hot.retainedSurfaceTokens, 3000);
    assert.equal(hot.rebuiltSuffixTokens, 4200);
    assert.equal(hot.initialRebuildPenalty, 3780);
    assert.equal(hot.summaryCost, 7200);
    const miss = planScheduledCompaction(candidate({ cacheState: "uncached" }));
    assert.equal(miss.initialRebuildPenalty, hot.initialRebuildPenalty);
    const paid = planScheduledCompaction(candidate({ independentRebuildTokens: 4200 }));
    assert.equal(paid.initialRebuildPenalty, 0);
    assert.equal(paid.summaryCost, hot.summaryCost);
    const fixed = planScheduledCompaction(candidate({ totalTokens: 52000, prefixTokens: 41000 }));
    assert.equal(
        fixed.rebuiltSuffixTokens,
        hot.rebuiltSuffixTokens,
        "stable prefix is never charged as rebuilt",
    );
});
test("summary input cache is accounted separately from future primary cache reads", () => {
    const independent = planScheduledCompaction(candidate());
    const shared = planScheduledCompaction(candidate({ summaryCacheShare: 1 }));
    assert.equal(shared.summaryCost, 1800);
    assert.ok(shared.summaryCost < independent.summaryCost);
});
test("window pressure overrides economics without any model force mode", () => {
    for (const cacheReadRatio of [0, 0.01, 0.1, 0.5, 1]) {
        const plan = planScheduledCompaction(
            candidate({ totalTokens: 21500, auto: false, markedIds: [] }),
            { cacheReadRatio },
        );
        assert.equal(plan.decision, "execute");
        assert.equal(plan.reason, "safety_pressure");
    }
    assert.equal(
        planScheduledCompaction(candidate({ forceSafety: "overflow", auto: false })).reason,
        "safety_overflow",
    );
    assert.equal(
        planScheduledCompaction(
            candidate({ selectedTokens: 0, excludedTokens: 0, forceSafety: "overflow" }),
        ).reason,
        "no_selection",
    );
});
test("cache costs monotonically tighten the latest permitted start", () => {
    let previous = Infinity;
    for (let index = 0; index <= 100; index++) {
        const plan = planScheduledCompaction(candidate(), { cacheReadRatio: index / 100 });
        assert.ok(plan.latestStartTokens <= previous);
        assert.ok(plan.latestStartTokens >= plan.targetTokens);
        assert.ok(plan.latestStartTokens < plan.safetyTokens);
        previous = plan.latestStartTokens;
    }
});
test("explicit request is an intent, not an economic override", () => {
    const request = candidate({ trigger: "model_request", auto: false, markedIds: [] });
    const freeCache = planScheduledCompaction(request, { cacheReadRatio: 0 });
    assert.equal(freeCache.decision, "wait");
    assert.equal(freeCache.reason, "cost_deferred");
    assert.equal(planScheduledCompaction(candidate({ auto: false })).reason, "disabled");
    assert.equal(planScheduledCompaction(candidate({ markedIds: [] })).reason, "no_request");
});
test("zero or negative predicted savings cannot manufacture eligibility", () => {
    const plan = planScheduledCompaction(candidate({ filterInputTokens: 50000, summaryRatio: 1 }));
    assert.equal(plan.netSavingTokens, 0);
    assert.equal(plan.reason, "no_savings");
    assert.equal(plan.decision, "wait");
});
test("removed knobs and malformed inputs are rejected", () => {
    assert.ok(Object.isFrozen(resolveSchedulingPolicy()));
    for (const value of [
        { paybackTurns: 24 },
        { minIntervalSteps: 0 },
        { releaseMaxWaitSteps: 1 },
        { cacheReadRatio: 1.1 },
        { cacheTtlMs: -1 },
        { summaryOutputRatio: Infinity },
    ]) {
        assert.equal(schedulingPolicySchema.safeParse(value).success, false);
        assert.throws(() => resolveSchedulingPolicy(value));
    }
    for (const value of [
        { totalTokens: Infinity },
        { selectedTokens: -1 },
        { selectedTokens: 12000 },
        { excludedTokens: 8001 },
        { safetyTokens: 17000 },
        { growthTokens: 0 },
        { summaryCacheShare: 2 },
    ])
        assert.throws(() => planScheduledCompaction(candidate(value)));
});
test("plans are deterministic finite JSON and do not mutate caller state", () => {
    const input = Object.freeze(candidate({ markedIds: Object.freeze(["17", "3", "17"]) }));
    const before = JSON.stringify(input);
    const plan = planScheduledCompaction(input);
    assert.deepEqual(plan, planScheduledCompaction(input));
    assert.deepEqual(JSON.parse(JSON.stringify(plan)), plan);
    assert.equal(JSON.stringify(input), before);
    assert.deepEqual(plan.markedIds, ["17", "3"]);
    for (const value of Object.values(plan))
        if (typeof value === "number") assert.ok(Number.isFinite(value) && value >= 0);
});
