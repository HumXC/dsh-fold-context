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

test("historical cache misses keep conservative future costs unless independent work is proved", () => {
    const unknown = planScheduledCompaction(candidate());
    const cached = planScheduledCompaction(candidate({ cacheState: "cached" }));
    const miss = planScheduledCompaction(candidate({ cacheState: "uncached" }));
    assert.equal(unknown.heuristic, "HEURISTIC");
    assert.equal(unknown.cachedPrefixAssumed, true);
    assert.equal(unknown.breakEvenTurns, cached.breakEvenTurns);
    assert.equal(cached.predictedSummaryTokens, 1200);
    assert.equal(cached.retainedSurfaceTokens, 3000);
    assert.equal(cached.rebuiltSuffixTokens, 4200);
    assert.equal(cached.initialRebuildPenalty, 3780);
    assert.equal(cached.summaryCost, 7200);
    assert.equal(cached.perTurnSaving, 680);
    assert.equal(cached.breakEvenTurns, 17);
    assert.equal(cached.reason, "eligible");
    assert.equal(planScheduledCompaction(candidate(), { paybackTurns: 8 }).reason, "not_paid_back");
    assert.equal(miss.cachedPrefixAssumed, true);
    assert.equal(miss.effectiveCacheReadRatio, 0.1);
    assert.equal(miss.initialRebuildPenalty, cached.initialRebuildPenalty);
    assert.equal(miss.breakEvenTurns, cached.breakEvenTurns);
    const independentlyPaid = planScheduledCompaction(
        candidate({ independentRebuildTokens: 4200 }),
    );
    assert.equal(independentlyPaid.initialRebuildPenalty, 0);
    assert.equal(independentlyPaid.summaryCost, cached.summaryCost);
    assert.equal(independentlyPaid.breakEvenTurns, 11);
    const moreExpensiveReads = planScheduledCompaction(candidate(), { cacheReadRatio: 0.5 });
    assert.ok(cached.breakEvenTurns > moreExpensiveReads.breakEvenTurns);
    const override = planScheduledCompaction(candidate({ effectiveCacheReadRatio: 1 }));
    assert.equal(override.initialRebuildPenalty, 0);
    assert.equal(override.breakEvenTurns, 2);
});
test("a covering summary saves the full unmarked span as well as excluded marks", () => {
    const plan = planScheduledCompaction(
        candidate({
            excludedTokens: 100,
            cacheState: "uncached",
        }),
    );
    assert.equal(plan.filterInputTokens, 7900);
    assert.equal(plan.predictedSummaryTokens, 1580);
    assert.equal(plan.netSavingTokens, 6420);
    assert.ok(plan.netSavingTokens > plan.excludedTokens);
    assert.equal(plan.reason, "eligible");
    const filtered = planScheduledCompaction(
        candidate({ filterInputTokens: 2500, headerOverheadTokens: 100 }),
        { paybackTurns: 8 },
    );
    assert.equal(filtered.predictedSummaryTokens, 500);
    assert.equal(filtered.rebuiltSuffixTokens, 3500);
    assert.equal(filtered.summaryCost, 3000);
    assert.equal(filtered.breakEvenTurns, 9);
    assert.equal(filtered.reason, "not_paid_back");
    assert.equal(
        planScheduledCompaction(candidate({ filterInputTokens: 2500, headerOverheadTokens: 100 }), {
            paybackTurns: 9,
        }).reason,
        "eligible",
    );
});

test("tiny explicit requests and summaries that grow the prompt wait despite cheap input", () => {
    const tiny = planScheduledCompaction(
        candidate({
            trigger: "model_request",
            selectedTokens: 1000,
            excludedTokens: 1000,
            markedIds: [],
            cacheState: "uncached",
        }),
    );
    assert.equal(tiny.reason, "min_savings");
    assert.equal(tiny.decision, "wait");
    const growing = planScheduledCompaction(candidate({ cacheState: "uncached" }), {
        expectedSummaryRatio: 1.5,
        minSavingsTokens: 0,
        minSavingsRatio: 0,
    });
    assert.equal(growing.predictedSummaryTokens, 9000);
    assert.equal(growing.netSavingTokens, 0);
    assert.equal(growing.breakEvenTurns, null);
    assert.equal(growing.reason, "min_savings");
    const noReadSaving = planScheduledCompaction(candidate(), { cacheReadRatio: 0 });
    assert.equal(noReadSaving.breakEvenTurns, null);
    assert.equal(noReadSaving.reason, "not_paid_back");
});

test("interval, marks, and global savings ratio gate real boundary cases", () => {
    const beforeInterval = planScheduledCompaction(
        candidate({ cacheState: "uncached", stepsSinceSummary: 7 }),
    );
    assert.equal(beforeInterval.reason, "min_interval");
    assert.equal(planScheduledCompaction(candidate({ cacheState: "uncached" })).reason, "eligible");
    assert.equal(planScheduledCompaction(candidate({ markedIds: [] })).reason, "no_marks");
    assert.equal(
        planScheduledCompaction(
            candidate({ trigger: "model_request", markedIds: [], cacheState: "uncached" }),
        ).reason,
        "eligible",
    );
    const fraction = planScheduledCompaction(
        candidate({
            totalTokens: 50000,
            cacheState: "uncached",
        }),
    );
    assert.equal(fraction.netSavingTokens, 6800);
    assert.equal(fraction.reason, "min_ratio");
    const atMinimum = candidate({
        trigger: "model_request",
        totalTokens: 10240,
        selectedTokens: 2560,
        excludedTokens: 0,
        cacheState: "uncached",
        effectiveCacheReadRatio: 1,
    });
    assert.equal(planScheduledCompaction(atMinimum).netSavingTokens, 2048);
    assert.equal(planScheduledCompaction(atMinimum).savingsRatio, 0.2);
    assert.equal(planScheduledCompaction(atMinimum).reason, "eligible");
    assert.equal(
        planScheduledCompaction({ ...atMinimum, selectedTokens: 2559 }).reason,
        "min_savings",
    );
});

test("automatic switches preserve explicit requests and safety overrides", () => {
    const ready = candidate({ cacheState: "uncached", auto: false });
    assert.equal(planScheduledCompaction(ready).reason, "disabled");
    assert.equal(
        planScheduledCompaction({ ...ready, trigger: "model_request" }).reason,
        "eligible",
    );
    assert.equal(planScheduledCompaction(candidate(), { proactive: false }).reason, "disabled");
    assert.equal(planScheduledCompaction({ ...ready, forceSafety: "pressure" }).reason, "disabled");
    const overflow = planScheduledCompaction({
        ...ready,
        stepsSinceSummary: 0,
        forceSafety: "overflow",
    });
    assert.equal(overflow.decision, "execute");
    assert.equal(overflow.reason, "safety_overflow");
    const pressure = planScheduledCompaction(
        candidate({ stepsSinceSummary: 0, forceSafety: "pressure" }),
    );
    assert.equal(pressure.reason, "safety_pressure");
    assert.equal(pressure.decision, "execute");
    const disabled = planScheduledCompaction(
        candidate({
            trigger: "model_request",
            selectedTokens: 1,
            excludedTokens: 0,
            stepsSinceSummary: 0,
            markedIds: [],
            auto: false,
        }),
        { enabled: false },
    );
    assert.equal(disabled.reason, "disabled");
    assert.equal(disabled.decision, "wait");
    assert.equal(planScheduledCompaction(candidate(), { enabled: false }).reason, "disabled");
    assert.equal(
        planScheduledCompaction(
            candidate({ selectedTokens: 0, excludedTokens: 0, forceSafety: "overflow" }),
        ).reason,
        "no_selection",
    );
});

test("policy and estimates reject nonfinite, unsafe, and incoherent values", () => {
    const defaults = resolveSchedulingPolicy();
    assert.equal(defaults.minIntervalSteps, 8);
    assert.equal(defaults.minSavingsTokens, 2048);
    assert.equal(defaults.cacheReadRatio, 0.1);
    assert.ok(Object.isFrozen(defaults));
    for (const value of [
        { minIntervalSteps: 0.5 },
        { minSavingsTokens: -1 },
        { expectedSummaryRatio: Infinity },
        { paybackTurns: 0 },
        { paybackTurns: Number.MAX_SAFE_INTEGER + 1 },
        { minSavingsRatio: 1.1 },
        { cacheReadRatio: NaN },
        { summaryOutputRatio: -1 },
        { enabled: "true" },
        { unexpected: true },
    ]) {
        assert.equal(schedulingPolicySchema.safeParse(value).success, false);
        assert.throws(() => resolveSchedulingPolicy(value));
    }
    for (const value of [
        { totalTokens: Infinity },
        { selectedTokens: -1 },
        { prefixTokens: 12001 },
        { selectedTokens: 11500 },
        { excludedTokens: 8001 },
        { stepsSinceSummary: 0.5 },
        { filterInputTokens: Number.MAX_SAFE_INTEGER + 1 },
        { effectiveCacheReadRatio: 1.1 },
        { markedIds: [""] },
        { cacheState: "hit-confirmed-by-guess" },
    ]) {
        assert.throws(() => planScheduledCompaction(candidate(value)));
    }
    assert.throws(
        () =>
            planScheduledCompaction(candidate(), { expectedSummaryRatio: Number.MAX_SAFE_INTEGER }),
        /summary prediction/,
    );
    assert.throws(
        () => planScheduledCompaction(candidate(), { summaryInputRatio: Number.MAX_SAFE_INTEGER }),
        /summaryCost/,
    );
    assert.throws(
        () => planScheduledCompaction(candidate({ headerOverheadTokens: Number.MAX_SAFE_INTEGER })),
        /header overhead exceed totalTokens/,
    );
    const unrepresentablePayback = planScheduledCompaction(
        candidate({ effectiveCacheReadRatio: Number.MIN_VALUE }),
    );
    assert.equal(unrepresentablePayback.breakEvenTurns, null);
    assert.equal(unrepresentablePayback.reason, "not_paid_back");
});

test("plans are deterministic finite JSON and leave frozen caller inputs unchanged", () => {
    const input = Object.freeze(candidate({ markedIds: Object.freeze(["17", "3", "17"]) }));
    const before = JSON.stringify(input);
    const policy = resolveSchedulingPolicy({ paybackTurns: 20 });
    const first = planScheduledCompaction(input, policy);
    const second = planScheduledCompaction(input, policy);
    assert.deepEqual(first, second);
    assert.deepEqual(JSON.parse(JSON.stringify(first)), first);
    assert.equal(JSON.stringify(input), before);
    assert.deepEqual(first.markedIds, ["17", "3"]);
    assert.equal(first.routeSignature, "summary-route-v1");
    for (const value of Object.values(first)) {
        if (typeof value === "number") assert.ok(Number.isFinite(value) && value >= 0);
    }
});
