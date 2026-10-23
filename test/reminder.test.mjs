import test from "node:test";
import assert from "node:assert/strict";
import {
    initialReminderState,
    planReleaseReminder,
    reminderPolicySchema,
    resolveReminderPolicy,
} from "../lib/domain/reminder.js";
const candidate = (overrides = {}) => ({
    id: "1",
    tool: "read",
    preview: "consumed evidence",
    tokens: 16000,
    ageSteps: 2,
    seq: 1,
    ...overrides,
});
const input = (overrides = {}) => ({
    step: 0,
    candidates: [candidate()],
    previous: initialReminderState(),
    progressSeq: 0,
    pressure: null,
    ...overrides,
});

test("only advisory enablement is public policy; removed knobs are rejected", () => {
    assert.deepEqual(resolveReminderPolicy(), { enabled: true });
    assert.ok(Object.isFrozen(resolveReminderPolicy()));
    for (const invalid of [
        { backlogTokens: 1 },
        { minAgeSteps: 0 },
        { maxCandidates: 2 },
        { enabled: 1 },
    ])
        assert.equal(reminderPolicySchema.safeParse(invalid).success, false);
});
test("ready evidence remains age-gated and invalid/nonpositive estimates are excluded", () => {
    const plan = planReleaseReminder(
        input({
            candidates: [
                candidate({ id: "young", ageSteps: 1 }),
                candidate({ id: "zero", tokens: 0 }),
                candidate({ id: "negative", tokens: -1 }),
                candidate({ id: "nan", tokens: NaN }),
            ],
        }),
    );
    assert.equal(plan.reason, "empty");
    assert.equal(plan.candidateTokens, 0);
    assert.deepEqual(plan.candidates, []);
});
test("a large ready pool can prompt review without knowing model capacity", () => {
    const plan = planReleaseReminder(input());
    assert.equal(plan.reason, "backlog");
    assert.equal(plan.decision, "remind");
    assert.equal(plan.state.ignoredCount, 0);
});
test("small unchanged backlog never becomes urgent just because time passes", () => {
    const candidates = [candidate({ tokens: 1000 })];
    const first = planReleaseReminder(input({ candidates }));
    const later = planReleaseReminder(input({ candidates, step: 100000, previous: first.state }));
    assert.equal(later.reason, "below_threshold");
    assert.equal(later.state.lastReminderStep, null);
});
test("benefit and suffix position prefer recent cheap releases, without authorizing them", () => {
    const recent = candidate({ id: "recent", tokens: 4000, suffixTokens: 20 });
    const old = candidate({ id: "old", tokens: 6000, suffixTokens: 100000 });
    const plan = planReleaseReminder(input({ candidates: [old, recent] }));
    assert.equal(plan.reason, "benefit");
    assert.equal(plan.candidates[0].id, "recent");
    assert.equal(planReleaseReminder(input({ candidates: [old] })).decision, "wait");
    assert.equal(
        planReleaseReminder(input({ candidates: [recent], cacheReadRatio: 0 })).decision,
        "wait",
    );
    assert.equal(
        planReleaseReminder(input({ candidates: [old], cacheReadRatio: 1 })).decision,
        "remind",
    );
});
test("pressure and pool thresholds scale to the soft target", () => {
    const candidates = [candidate({ tokens: 1000 })];
    assert.equal(
        planReleaseReminder(input({ candidates, targetTokens: 10000, pressure: 0.5 })).decision,
        "wait",
    );
    assert.equal(
        planReleaseReminder(input({ candidates, targetTokens: 10000, pressure: 1 })).reason,
        "pressure",
    );
    assert.equal(
        planReleaseReminder(input({ candidates, targetTokens: 200000, pressure: 1 })).decision,
        "wait",
    );
    assert.equal(
        planReleaseReminder(
            input({ candidates: [candidate({ tokens: 3000 })], targetTokens: 40000 }),
        ).reason,
        "backlog",
    );
});
test("identical reminders and ID churn never rearm from elapsed time", () => {
    const first = planReleaseReminder(input());
    for (const step of [0, 4, 100, 100000]) {
        const next = planReleaseReminder(input({ step, previous: first.state }));
        assert.equal(next.reason, "unchanged");
        assert.deepEqual(next.state, first.state);
    }
    const churn = planReleaseReminder(
        input({ step: 100, previous: first.state, candidates: [candidate({ id: "different" })] }),
    );
    assert.equal(churn.reason, "unchanged");
    assert.equal(churn.state.ignoredCount, 0);
});
test("pressure escalation rearms once and oscillation does not repeat a notified band", () => {
    const first = planReleaseReminder(input());
    const early = planReleaseReminder(input({ step: 1, previous: first.state, pressure: 1 }));
    assert.equal(early.reason, "min_interval");
    const urgent = planReleaseReminder(input({ step: 4, previous: early.state, pressure: 1 }));
    assert.equal(urgent.reason, "pressure");
    assert.equal(urgent.state.ignoredCount, 1);
    const lower = planReleaseReminder(input({ step: 100, previous: urgent.state, pressure: 0.5 }));
    assert.equal(lower.reason, "unchanged");
    assert.equal(
        planReleaseReminder(input({ step: 200, previous: lower.state, pressure: 1 })).reason,
        "unchanged",
    );
});
test("meaningful growth rearms with bounded backoff; previews do not inflate ignores", () => {
    let state = planReleaseReminder(input()).state;
    let tokens = 16000;
    for (let index = 0; index < 6; index++) {
        tokens *= 2;
        const pending = planReleaseReminder(
            input({
                step: state.lastReminderStep + 1,
                previous: state,
                candidates: [candidate({ tokens })],
            }),
        );
        assert.equal(pending.decision, "wait");
        assert.equal(pending.state.ignoredCount, state.ignoredCount);
        const next = planReleaseReminder(
            input({
                step: state.lastReminderStep + 24,
                previous: pending.state,
                candidates: [candidate({ tokens })],
            }),
        );
        assert.equal(next.decision, "remind");
        assert.equal(next.state.ignoredCount, Math.min(index + 1, 3));
        state = next.state;
    }
});
test("only semantic progress resets outstanding state and still observes admission spacing", () => {
    const first = planReleaseReminder(input());
    const progressed = planReleaseReminder(
        input({ step: 1, previous: first.state, progressSeq: 7 }),
    );
    assert.equal(progressed.reason, "min_interval");
    assert.equal(progressed.state.lastFingerprint, null);
    assert.equal(progressed.state.lastProgressSeq, 7);
    const next = planReleaseReminder(
        input({ step: 4, previous: progressed.state, progressSeq: 7 }),
    );
    assert.equal(next.decision, "remind");
    assert.equal(next.state.ignoredCount, 0);
    for (const progressSeq of [6, 7])
        assert.equal(
            planReleaseReminder(input({ step: 100, previous: next.state, progressSeq })).reason,
            "unchanged",
        );
});
test("empty, disabled and active-compaction states preserve outstanding history", () => {
    const first = planReleaseReminder(input());
    const empty = planReleaseReminder(input({ step: 10, previous: first.state, candidates: [] }));
    assert.equal(empty.reason, "empty");
    assert.equal(empty.state.backlogSinceStep, null);
    assert.equal(
        planReleaseReminder(input({ step: 100, previous: empty.state })).reason,
        "unchanged",
    );
    assert.equal(planReleaseReminder(input(), { enabled: false }).reason, "disabled");
    const active = planReleaseReminder(input({ activeCompaction: true }));
    assert.equal(active.reason, "active_compaction");
    assert.equal(active.state.lastReminderStep, null);
});
test("ranking is deterministic, output bounded, canonical digest covers the entire pool", () => {
    const candidates = Array.from({ length: 1000 }, (_, i) =>
        candidate({ id: String(i + 1), seq: i, tokens: 100 }),
    );
    const plan = planReleaseReminder(input({ candidates }));
    assert.equal(plan.candidates.length, 5);
    assert.equal(plan.candidateTokens, 100000);
    assert.equal(plan.state.lastFingerprint.length, 64);
    assert.equal(
        planReleaseReminder(
            input({
                candidates: [...candidates].reverse().map((c) => ({ ...c, preview: "changed" })),
            }),
        ).state.lastFingerprint,
        plan.state.lastFingerprint,
    );
    const changed = candidates.map((c, i) => (i === 0 ? { ...c, id: "new" } : c));
    assert.notEqual(
        planReleaseReminder(input({ candidates: changed })).state.lastFingerprint,
        plan.state.lastFingerprint,
    );
    assert.ok(JSON.stringify(plan.state).length < 300);
    assert.deepEqual(JSON.parse(JSON.stringify(plan.state)), plan.state);
});
test("planner leaves frozen inputs untouched", () => {
    const previous = Object.freeze(initialReminderState());
    const candidates = Object.freeze([Object.freeze(candidate())]);
    const value = Object.freeze(input({ previous, candidates }));
    const config = Object.freeze({ enabled: true });
    const before = JSON.stringify(value);
    assert.deepEqual(planReleaseReminder(value, config), planReleaseReminder(value, config));
    assert.equal(JSON.stringify(value), before);
});
test("invalid clocks, estimates, pressure and duplicate identities fail explicitly", () => {
    for (const step of [-1, 0.5, Infinity, Number.MAX_SAFE_INTEGER + 1])
        assert.throws(() => planReleaseReminder(input({ step })), RangeError);
    for (const pressure of [-1, NaN, Infinity])
        assert.throws(() => planReleaseReminder(input({ pressure })), RangeError);
    for (const targetTokens of [0, -1, Infinity, 0.5])
        assert.throws(() => planReleaseReminder(input({ targetTokens })), RangeError);
    for (const cacheReadRatio of [-1, 2, NaN])
        assert.throws(() => planReleaseReminder(input({ cacheReadRatio })), RangeError);
    assert.throws(
        () => planReleaseReminder(input({ candidates: [candidate({ suffixTokens: -1 })] })),
        RangeError,
    );
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
