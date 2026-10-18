import test from "node:test";
import assert from "node:assert/strict";
import {
    initialReminderState,
    planReleaseReminder,
    reminderPolicySchema,
    resolveReminderPolicy,
} from "../lib/domain/reminder.js";

function candidate(overrides = {}) {
    return {
        id: "1",
        tool: "read",
        preview: "finished evidence",
        tokens: 16000,
        ageSteps: 2,
        seq: 1,
        ...overrides,
    };
}

function input(overrides = {}) {
    return {
        step: 0,
        candidates: [candidate()],
        previous: initialReminderState(),
        progressSeq: 0,
        pressure: null,
        ...overrides,
    };
}

function ignoredTwice() {
    const first = planReleaseReminder(input());
    const second = planReleaseReminder(input({ step: 6, previous: first.state }));
    const third = planReleaseReminder(input({ step: 18, previous: second.state }));
    assert.equal(third.decision, "remind");
    assert.equal(third.state.ignoredCount, 2);
    return third.state;
}

test("policy exposes the requested defaults and validates finite, bounded overrides", () => {
    assert.deepEqual(resolveReminderPolicy(), {
        enabled: true,
        minAgeSteps: 2,
        largeOutputTokens: 8000,
        backlogTokens: 16000,
        staleTokens: 4000,
        staleSteps: 8,
        pressureRatio: 0.8,
        minIntervalSteps: 6,
        pressureIntervalSteps: 4,
        ignoredBackoffSteps: [12, 24],
        rearmGrowthTokens: 8000,
        maxCandidates: 5,
    });
    const policy = resolveReminderPolicy({ staleSteps: 3, ignoredBackoffSteps: [10, 20, 30] });
    assert.equal(policy.staleSteps, 3);
    assert.ok(Object.isFrozen(policy));
    assert.ok(Object.isFrozen(policy.ignoredBackoffSteps));
    for (const invalid of [
        { pressureRatio: 1.1 },
        { pressureRatio: NaN },
        { backlogTokens: Infinity },
        { minAgeSteps: -1 },
        { staleSteps: 1.5 },
        { maxCandidates: 0 },
        { ignoredBackoffSteps: [] },
        { ignoredBackoffSteps: [24, 12] },
        { ignoredBackoffSteps: [12, 0] },
        { extra: true },
    ]) {
        assert.equal(reminderPolicySchema.safeParse(invalid).success, false);
    }
});

test("cold-start mass triggers at exactly 16000 ready tokens without growth debt", () => {
    const below = planReleaseReminder(input({ candidates: [candidate({ tokens: 15999 })] }));
    assert.equal(below.decision, "wait");
    assert.equal(below.state.lastReminderStep, null);
    const boundary = planReleaseReminder(input());
    assert.equal(boundary.decision, "remind");
    assert.equal(boundary.reason, "backlog");
    assert.equal(boundary.candidateTokens, 16000);
    assert.equal(boundary.state.lastReminderStep, 0);
    assert.equal(boundary.state.tokensAtLastReminder, 16000);
    assert.equal(boundary.state.ignoredCount, 0);
});

test("age and positive token filters precede thresholds and large output is ranking only", () => {
    const plan = planReleaseReminder(
        input({
            candidates: [
                candidate({ id: "young", ageSteps: 1, tokens: 100000 }),
                candidate({ id: "empty", tokens: 0 }),
                candidate({ id: "negative", tokens: -100 }),
                candidate({ id: "nonfinite", tokens: NaN }),
                candidate({ id: "ready", tokens: 8000 }),
            ],
        }),
    );
    assert.equal(plan.decision, "wait");
    assert.equal(plan.candidateTokens, 8000);
    assert.deepEqual(
        plan.candidates.map((item) => item.id),
        ["ready"],
    );
    assert.equal(
        planReleaseReminder(input({ candidates: [candidate({ ageSteps: 1 })] })).reason,
        "empty",
    );
});

test("stale trigger requires 4000 tokens continuously for eight business steps", () => {
    const candidates = [candidate({ tokens: 4000 })];
    const first = planReleaseReminder(input({ step: 10, candidates }));
    assert.equal(first.state.backlogSinceStep, 10);
    const early = planReleaseReminder(input({ step: 17, candidates, previous: first.state }));
    assert.equal(early.decision, "wait");
    assert.equal(early.state.lastReminderStep, null);
    const stale = planReleaseReminder(input({ step: 18, candidates, previous: early.state }));
    assert.equal(stale.decision, "remind");
    assert.equal(stale.reason, "stale");
    const dipped = planReleaseReminder(
        input({ step: 17, candidates: [candidate({ tokens: 3999 })], previous: first.state }),
    );
    assert.equal(dipped.state.backlogSinceStep, null);
    const restarted = planReleaseReminder(input({ step: 18, candidates, previous: dipped.state }));
    assert.equal(restarted.decision, "wait");
    assert.equal(restarted.state.backlogSinceStep, 18);
    assert.equal(
        planReleaseReminder(input({ step: 26, candidates, previous: restarted.state })).reason,
        "stale",
    );
});

test("pressure uses the official-threshold ratio and the 4000-token floor", () => {
    const candidates = [candidate({ tokens: 4000 })];
    assert.equal(planReleaseReminder(input({ candidates, pressure: 0.799999 })).decision, "wait");
    assert.equal(planReleaseReminder(input({ candidates, pressure: null })).decision, "wait");
    const boundary = planReleaseReminder(input({ candidates, pressure: 0.8 }));
    assert.equal(boundary.decision, "remind");
    assert.equal(boundary.reason, "pressure");
    assert.equal(
        planReleaseReminder(input({ candidates: [candidate({ tokens: 3999 })], pressure: 2 }))
            .decision,
        "wait",
    );
    assert.equal(
        planReleaseReminder(input({ candidates, pressure: 0.7 }), { pressureRatio: 0.7 }).decision,
        "remind",
    );
});

test("normal cooldown is six steps and pressure cooldown is four", () => {
    const first = planReleaseReminder(input());
    const early = planReleaseReminder(input({ step: 5, previous: first.state }));
    assert.equal(early.reason, "min_interval");
    assert.equal(early.state.lastReminderStep, 0);
    assert.equal(early.state.ignoredCount, 0);
    assert.equal(planReleaseReminder(input({ step: 6, previous: early.state })).decision, "remind");
    const candidates = [candidate({ tokens: 4000 })];
    const pressure = planReleaseReminder(input({ candidates, pressure: 0.8 }));
    assert.equal(
        planReleaseReminder(input({ step: 3, candidates, pressure: 0.8, previous: pressure.state }))
            .reason,
        "min_interval",
    );
    assert.equal(
        planReleaseReminder(input({ step: 4, candidates, pressure: 0.8, previous: pressure.state }))
            .decision,
        "remind",
    );
});

test("ignored reminders back off to twelve then twenty-four steps without wait-call inflation", () => {
    const first = planReleaseReminder(input());
    const duplicate = planReleaseReminder(input({ previous: first.state }));
    assert.equal(duplicate.decision, "wait");
    assert.deepEqual(duplicate.state, first.state);
    const second = planReleaseReminder(input({ step: 6, previous: first.state }));
    assert.equal(second.state.ignoredCount, 1);
    let previous = second.state;
    for (let step = 7; step < 18; step++) {
        const waiting = planReleaseReminder(input({ step, previous }));
        assert.equal(waiting.reason, "ignored_backoff");
        assert.equal(waiting.state.ignoredCount, 1);
        assert.equal(waiting.state.lastReminderStep, 6);
        previous = waiting.state;
    }
    const third = planReleaseReminder(input({ step: 18, previous }));
    assert.equal(third.state.ignoredCount, 2);
    assert.equal(planReleaseReminder(input({ step: 41, previous: third.state })).decision, "wait");
    const fourth = planReleaseReminder(input({ step: 42, previous: third.state }));
    assert.equal(fourth.state.ignoredCount, 3);
    const later = planReleaseReminder(input({ step: 66, previous: fourth.state }));
    assert.equal(later.decision, "remind");
    assert.equal(later.state.ignoredCount, 3);
    assert.equal(planReleaseReminder(input({ step: 89, previous: later.state })).decision, "wait");
});

test("pressure cannot bypass ignored-reminder backoff", () => {
    const previous = ignoredTwice();
    assert.equal(
        planReleaseReminder(input({ step: 22, pressure: 1, previous })).reason,
        "ignored_backoff",
    );
    assert.equal(
        planReleaseReminder(input({ step: 42, pressure: 1, previous })).decision,
        "remind",
    );
});

test("only a larger semantic progress sequence resets ignored state, while preserving cooldown", () => {
    const previous = ignoredTwice();
    const progressed = planReleaseReminder(input({ step: 19, previous, progressSeq: 7 }));
    assert.equal(progressed.decision, "wait");
    assert.equal(progressed.state.ignoredCount, 0);
    assert.equal(progressed.state.lastFingerprint, null);
    assert.equal(progressed.state.lastReminderStep, 18);
    assert.equal(progressed.state.lastProgressSeq, 7);
    const repeated = planReleaseReminder(
        input({ step: 23, previous: progressed.state, progressSeq: 7 }),
    );
    assert.equal(repeated.decision, "wait");
    const next = planReleaseReminder(input({ step: 24, previous: repeated.state, progressSeq: 7 }));
    assert.equal(next.decision, "remind");
    assert.equal(next.state.ignoredCount, 0);
    const noOp = planReleaseReminder(input({ step: 30, previous: next.state, progressSeq: 7 }));
    assert.equal(noOp.state.ignoredCount, 1);
    assert.equal(
        planReleaseReminder(input({ step: 36, previous: noOp.state, progressSeq: 7 })).reason,
        "ignored_backoff",
    );
    const older = planReleaseReminder(input({ step: 36, previous: noOp.state, progressSeq: 6 }));
    assert.equal(older.state.lastProgressSeq, 7);
    assert.equal(older.reason, "ignored_backoff");
});

test("eight thousand new candidate tokens rearms backoff but still requires the ordinary interval", () => {
    const previous = ignoredTwice();
    assert.equal(
        planReleaseReminder(
            input({ step: 24, previous, candidates: [candidate({ tokens: 23999 })] }),
        ).reason,
        "ignored_backoff",
    );
    const candidates = [candidate({ tokens: 24000 })];
    const early = planReleaseReminder(input({ step: 22, previous, candidates, pressure: 1 }));
    assert.equal(early.decision, "wait");
    assert.equal(early.state.ignoredCount, 0);
    assert.equal(early.state.lastReminderStep, 18);
    const boundary = planReleaseReminder(
        input({ step: 24, previous: early.state, candidates, pressure: 1 }),
    );
    assert.equal(boundary.decision, "remind");
    assert.equal(boundary.state.ignoredCount, 0);
    assert.equal(boundary.state.tokensAtLastReminder, 24000);
});

test("candidate identity churn without growth or semantic progress does not rearm", () => {
    const previous = ignoredTwice();
    const changed = planReleaseReminder(
        input({ step: 24, previous, candidates: [candidate({ id: "999", seq: 999 })] }),
    );
    assert.equal(changed.reason, "ignored_backoff");
    assert.equal(changed.state.ignoredCount, 2);
    assert.equal(changed.state.lastFingerprint, previous.lastFingerprint);
});

test("empty pool resets backlog but preserves reminder history and cooldown", () => {
    const first = planReleaseReminder(input());
    const empty = planReleaseReminder(input({ step: 1, previous: first.state, candidates: [] }));
    assert.equal(empty.reason, "empty");
    assert.equal(empty.candidateTokens, 0);
    assert.deepEqual(empty.candidates, []);
    assert.deepEqual(empty.state, { ...first.state, backlogSinceStep: null });
    assert.equal(
        planReleaseReminder(input({ step: 2, previous: empty.state })).reason,
        "min_interval",
    );
    const backedOff = ignoredTwice();
    const gap = planReleaseReminder(input({ step: 19, previous: backedOff, candidates: [] }));
    assert.equal(
        planReleaseReminder(input({ step: 24, previous: gap.state })).reason,
        "ignored_backoff",
    );
});

test("disabled and active compaction never emit reminders or advance lastReminderStep", () => {
    const disabled = planReleaseReminder(input(), { enabled: false });
    assert.equal(disabled.reason, "disabled");
    assert.equal(disabled.state.lastReminderStep, null);
    const active = planReleaseReminder(input({ activeCompaction: true }));
    assert.equal(active.reason, "active_compaction");
    assert.equal(active.state.lastReminderStep, null);
    assert.equal(
        planReleaseReminder(input({ step: 1, previous: active.state })).decision,
        "remind",
    );
});

test("ranking prefers reclaim then newer sequence and caps suggestions without capping totals", () => {
    const candidates = [
        candidate({ id: "older", tokens: 8000, seq: 1 }),
        candidate({ id: "small", tokens: 1000, seq: 9 }),
        candidate({ id: "newer", tokens: 8000, seq: 5 }),
        candidate({ id: "largest", tokens: 9000, seq: 0 }),
        candidate({ id: "tie-b", tokens: 8000, seq: 5 }),
        candidate({ id: "tie-a", tokens: 8000, seq: 5 }),
    ];
    const result = planReleaseReminder(input({ candidates }), { maxCandidates: 3 });
    assert.equal(result.candidateTokens, 42000);
    assert.deepEqual(
        result.candidates.map((item) => item.id),
        ["largest", "newer", "tie-a"],
    );
    assert.deepEqual(
        planReleaseReminder(input({ candidates: [...candidates].reverse() }), { maxCandidates: 3 }),
        result,
    );
});

test("fingerprints use canonical IDs of the full ready pool, bounded independently of pool size", () => {
    const candidates = Array.from({ length: 1000 }, (_, index) =>
        candidate({ id: String(index + 1), seq: index, tokens: 100 }),
    );
    const original = planReleaseReminder(input({ candidates }));
    assert.equal(original.candidates.length, 5);
    assert.equal(original.state.lastFingerprint.length, 64);
    const reordered = planReleaseReminder(
        input({
            candidates: [...candidates].reverse().map((item) => ({ ...item, preview: "changed" })),
        }),
        { maxCandidates: 1 },
    );
    assert.equal(reordered.state.lastFingerprint, original.state.lastFingerprint);
    const changed = planReleaseReminder(
        input({
            candidates: candidates.map((item, index) =>
                index === 0 ? { ...item, id: "new" } : item,
            ),
        }),
    );
    assert.notEqual(changed.state.lastFingerprint, original.state.lastFingerprint);
    assert.ok(JSON.stringify(original.state).length < 300);
    assert.deepEqual(JSON.parse(JSON.stringify(original.state)), original.state);
});

test("planner is deterministic and leaves frozen input, policy and previous state unchanged", () => {
    const previous = Object.freeze(initialReminderState());
    const candidates = Object.freeze([Object.freeze(candidate())]);
    const value = Object.freeze(input({ previous, candidates }));
    const config = Object.freeze({ ignoredBackoffSteps: Object.freeze([12, 24]) });
    const before = JSON.stringify({ value, config });
    const first = planReleaseReminder(value, config);
    assert.deepEqual(planReleaseReminder(value, config), first);
    assert.notEqual(first.state, previous);
    assert.notEqual(first.candidates, candidates);
    assert.equal(JSON.stringify({ value, config }), before);
    assert.notEqual(initialReminderState(), initialReminderState());
});

test("unsafe clocks, duplicate ready identities and overflowing totals fail explicitly", () => {
    for (const step of [-1, 0.5, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
        assert.throws(() => planReleaseReminder(input({ step })), RangeError);
    }
    for (const pressure of [-1, NaN, Infinity]) {
        assert.throws(() => planReleaseReminder(input({ pressure })), RangeError);
    }
    assert.throws(
        () => planReleaseReminder(input({ candidates: [candidate(), candidate()] })),
        /unique/,
    );
    assert.throws(
        () =>
            planReleaseReminder(
                input({
                    candidates: [
                        candidate({ tokens: Number.MAX_SAFE_INTEGER }),
                        candidate({ id: "2", tokens: 1 }),
                    ],
                }),
            ),
        /candidateTokens/,
    );
});
