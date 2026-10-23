import test from "node:test";
import assert from "node:assert/strict";
import { Context } from "@deepseek-ai/cordis";
import fold from "../lib/index.js";
import { POLICY_GROUPS, normalizePolicyOverrides } from "../lib/domain/settings-catalog.js";
import { selectPolicyOverrides } from "../lib/settings-config.js";
import { resolveFoldCompactionConfig } from "../lib/config.js";
import { resolveSummaryPolicy } from "../lib/domain/summary-policy.js";
import { resolveSchedulingPolicy } from "../lib/domain/scheduler.js";
import { resolveReminderPolicy } from "../lib/domain/reminder.js";
import { fixture } from "./fixture.mjs";

const defaults = () => ({
    compaction: resolveFoldCompactionConfig({}),
    summary: resolveSummaryPolicy(),
    scheduling: resolveSchedulingPolicy(),
    reminders: resolveReminderPolicy(),
});

test("the clean catalog has four groups and ten fields; omitted overrides inherit without materializing defaults", () => {
    const original = defaults();
    const overrides = normalizePolicyOverrides();
    assert.deepEqual(POLICY_GROUPS.map((group) => group.key).sort(), [
        "compaction",
        "reminders",
        "scheduling",
        "summary",
    ]);
    assert.equal(
        POLICY_GROUPS.reduce((count, group) => count + group.fields.length, 0),
        10,
    );
    for (const group of POLICY_GROUPS) {
        assert.deepEqual(overrides[group.key], {});
        for (const field of group.fields) {
            if (field.default !== null)
                assert.deepEqual(original[group.key][field.key], field.default);
        }
    }
    assert.deepEqual(selectPolicyOverrides(original, overrides), original);
    assert.deepEqual(
        POLICY_GROUPS.flatMap((group) =>
            group.fields.filter((field) => field.perModel).map((field) => field.key),
        ),
        ["targetTokens", "cacheReadRatio"],
    );
});

test("field overrides preserve preset siblings, false and zero; empty model arrays explicitly clear inheritance", () => {
    const base = defaults();
    base.compaction = {
        ...base.compaction,
        auto: false,
        targetTokens: 170000,
        modelPolicies: [{ provider: "preset", model: "route", cacheReadRatio: 0.2 }],
    };
    base.summary = { reasoning: "preserve", images: "references" };
    const overrides = normalizePolicyOverrides({
        compaction: { cacheReadRatio: 0 },
        reminders: { enabled: false },
    });
    const selected = selectPolicyOverrides(base, overrides);
    assert.deepEqual(selected.compaction, { ...base.compaction, cacheReadRatio: 0 });
    assert.deepEqual(selected.summary, base.summary);
    assert.equal(selected.reminders.enabled, false);
    assert.deepEqual(overrides.compaction, { cacheReadRatio: 0 });
    const cleared = selectPolicyOverrides(
        base,
        normalizePolicyOverrides({ compaction: { modelPolicies: [] } }),
    );
    assert.deepEqual(cleared.compaction.modelPolicies, []);
    assert.equal(cleared.compaction.targetTokens, 170000);
    selected.compaction.modelPolicies[0].cacheReadRatio = 0.9;
    assert.equal(
        base.compaction.modelPolicies[0].cacheReadRatio,
        0.2,
        "effective snapshots cannot mutate preset arrays",
    );
});

test("profile Config preserves summary models and validates clean field overrides before persistence", async (t) => {
    const ctx = new Context();
    t.after(() => ctx.fiber.dispose());
    const config = fold.Config({
        uiOnly: true,
        summaryModels: [{ provider: "test", model: "summary-fixture" }],
        policyOverrides: { compaction: { targetTokens: 170000 }, reminders: { enabled: false } },
    });
    fold.apply(ctx, config);
    assert.equal(ctx.get("compaction"), undefined);
    assert.equal(ctx.foldContextSettings.current()[0].model, "summary-fixture");
    assert.deepEqual(ctx.foldContextSettings.policies().compaction, { targetTokens: 170000 });
    assert.deepEqual(ctx.foldContextSettings.policies().summary, {});
    for (const policyOverrides of [
        { compaction: { targetTokens: 0 } },
        { compaction: { cacheReadRatio: 1.1 } },
        { summary: { reasoning: "invalid" } },
        { reminders: { enabled: "false" } },
        { compaction: { modelPolicies: [{ provider: "p", model: "m", targetTokens: -1 }] } },
        { compaction: { modelPolicies: [{ provider: "p", model: "m", auto: true }] } },
    ])
        assert.throws(() => fold.Config({ uiOnly: true, policyOverrides }));
});

test("legacy root fields, wrappers and removed settings fail without migration or silent defaults", () => {
    for (const legacy of ["compaction", "release", "summary", "scheduling", "reminders"])
        assert.throws(() => fold.Config({ [legacy]: {} }), legacy);
    for (const overrides of [
        { release: {} },
        { compaction: { enabled: true, values: {} } },
        { compaction: { thresholdRatio: 0.8 } },
        { scheduling: { paybackTurns: 24 } },
        { scheduling: { releaseMaxWaitSteps: 16 } },
        { reminders: { ignoredBackoffSteps: [12, 24] } },
    ]) {
        assert.throws(() => normalizePolicyOverrides(overrides));
        assert.throws(() => fold.Config({ policyOverrides: overrides }));
        assert.throws(() => fold.Config({ policy: overrides }));
    }
});

test("all field types and numeric boundaries share strict Host validation", () => {
    for (const group of POLICY_GROUPS)
        for (const field of group.fields) {
            const bad =
                field.type === "boolean"
                    ? ["false", 0, null]
                    : field.type === "enum"
                      ? ["invalid", 1, null]
                      : [
                            null,
                            "1",
                            NaN,
                            Infinity,
                            ...(field.min === undefined ? [] : [field.min - 1]),
                            ...(field.max === undefined ? [] : [field.max + 1]),
                            ...(field.type === "integer" ? [1.5] : []),
                        ];
            for (const value of bad) {
                const overrides = { [group.key]: { [field.key]: value } };
                assert.throws(
                    () => normalizePolicyOverrides(overrides),
                    `${group.key}.${field.key}: ${String(value)}`,
                );
                assert.throws(() => fold.Config({ policyOverrides: overrides }));
            }
        }
    for (const value of [null, [], false])
        assert.throws(() => normalizePolicyOverrides({ compaction: value }));
    const model = normalizePolicyOverrides({
        compaction: {
            modelPolicies: [{ provider: "p", model: "m", cacheReadRatio: 0, targetTokens: 170000 }],
        },
    });
    assert.deepEqual(model.compaction.modelPolicies, [
        { provider: "p", model: "m", targetTokens: 170000, cacheReadRatio: 0 },
    ]);
    model.compaction.modelPolicies.push({ provider: "p", model: "m" });
    assert.throws(() => normalizePolicyOverrides(model), /modelPolicies/);
});

test("profile changes become effective at the next decision boundary instead of requiring a new engine", async (t) => {
    const profile = {
        summaryModels: [{ provider: "test", model: "summary-fixture" }],
        policyOverrides: normalizePolicyOverrides({
            compaction: { auto: false, summaryMaxTokens: 333 },
            summary: { reasoning: "preserve", images: "references" },
            reminders: { enabled: false },
        }),
    };
    const f = await fixture({ profileSettings: profile });
    t.after(f.close);
    assert.deepEqual(f.engine.summaryPolicy, { reasoning: "preserve", images: "references" });
    assert.equal(f.engine.reminderPolicy.enabled, false);
    profile.policyOverrides.summary.reasoning = "omit-from-summary";
    profile.policyOverrides.reminders.enabled = true;
    assert.equal(
        f.engine.summaryPolicy.reasoning,
        "preserve",
        "configuration stays stable between boundaries",
    );
    await f.engine.compactIfNeeded(f.agent, "pressure", new AbortController().signal);
    assert.equal(f.engine.summaryPolicy.reasoning, "omit-from-summary");
    assert.equal(f.engine.reminderPolicy.enabled, true);
    assert.equal(f.ctx.foldContextSettings.policies().summary.reasoning, "omit-from-summary");
});
