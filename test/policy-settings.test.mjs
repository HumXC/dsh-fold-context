import test from "node:test";
import assert from "node:assert/strict";
import { Context } from "@deepseek-ai/cordis";
import fold from "../lib/index.js";
import { POLICY_GROUPS, normalizePolicyOverrides } from "../lib/domain/settings-catalog.js";
import { selectPolicyOverrides } from "../lib/settings-config.js";
import { resolveFoldCompactionConfig } from "../lib/config.js";
import { resolveReleasePolicy } from "../lib/domain/planner.js";
import { resolveSummaryPolicy } from "../lib/domain/summary-policy.js";
import { resolveSchedulingPolicy } from "../lib/domain/scheduler.js";
import { resolveReminderPolicy } from "../lib/domain/reminder.js";
import { fixture } from "./fixture.mjs";

const defaults = () => ({
    compaction: resolveFoldCompactionConfig({}),
    release: resolveReleasePolicy(),
    summary: resolveSummaryPolicy(),
    scheduling: resolveSchedulingPolicy(),
    reminders: resolveReminderPolicy(),
});

test("the settings catalog covers every runtime policy field and preserves canonical defaults", () => {
    const original = defaults();
    const overrides = normalizePolicyOverrides();
    for (const group of POLICY_GROUPS) {
        const names = group.fields.map((field) => field.key);
        if (group.key === "compaction") names.push("modelPolicies");
        const expected = new Set(Object.keys(original[group.key]));
        if (group.key === "compaction") expected.add("retainTokens");
        assert.deepEqual([...names].sort(), [...expected].sort(), group.key);
        assert.equal(overrides[group.key].enabled, false);
        if (group.key !== "compaction")
            assert.deepEqual(overrides[group.key].values, original[group.key]);
    }
    assert.equal(
        POLICY_GROUPS.reduce((count, group) => count + group.fields.length, 0),
        37,
    );
    assert.deepEqual(resolveFoldCompactionConfig(overrides.compaction.values), original.compaction);
});

test("disabled profile groups preserve each preset and selecting groups clones their values", () => {
    const base = structuredClone(defaults());
    base.compaction.auto = false;
    base.compaction.modelPolicies = [{ provider: "preset", model: "route", retainTokens: 7 }];
    base.release.catalogLimit = 6;
    const overrides = normalizePolicyOverrides({
        release: { enabled: false, values: { catalogLimit: 99 } },
    });
    const inherited = selectPolicyOverrides(base, overrides);
    assert.deepEqual(inherited, base);
    overrides.release.enabled = true;
    overrides.compaction.enabled = true;
    const selected = selectPolicyOverrides(base, overrides);
    assert.equal(selected.release.catalogLimit, 99);
    assert.equal(selected.compaction.auto, true);
    assert.deepEqual(selected.compaction.modelPolicies, []);
    selected.compaction.modelPolicies.push({ provider: "other", model: "route" });
    assert.deepEqual(overrides.compaction.values.modelPolicies, []);
    assert.deepEqual(base.compaction.modelPolicies, [
        { provider: "preset", model: "route", retainTokens: 7 },
    ]);
});

test("profile Config preserves summary models, exposes opt-in groups and validates before persistence", async (t) => {
    const ctx = new Context();
    t.after(() => ctx.fiber.dispose());
    const routes = [{ provider: "test", model: "summary-fixture" }];
    const config = fold.Config({
        uiOnly: true,
        summaryModels: routes,
        policyOverrides: { release: { enabled: true, values: { catalogLimit: 9 } } },
    });
    fold.apply(ctx, config);
    assert.equal(ctx.get("compaction"), undefined);
    assert.equal(ctx.foldContextSettings.current()[0].model, "summary-fixture");
    assert.equal(ctx.foldContextSettings.policies().release.values.catalogLimit, 9);
    assert.equal(ctx.foldContextSettings.policies().compaction.enabled, false);
    for (const policyOverrides of [
        { release: { enabled: true, values: { catalogLimit: 0 } } },
        { reminders: { enabled: true, values: { ignoredBackoffSteps: [20, 10] } } },
        { reminders: { enabled: true, values: { ignoredBackoffSteps: [] } } },
        { summary: { enabled: true, values: { reasoning: "invalid" } } },
        { compaction: { enabled: true, values: { thresholdRatio: 0 } } },
        {
            compaction: {
                enabled: true,
                values: { modelPolicies: [{ provider: "p", model: "m", retainTokens: -1 }] },
            },
        },
    ])
        assert.throws(() => fold.Config({ uiOnly: true, policyOverrides }));
});

test("all numeric field boundaries, types and enum values share strict Host validation", () => {
    for (const group of POLICY_GROUPS) {
        for (const field of group.fields) {
            const bad =
                field.type === "boolean"
                    ? ["false", 0, null]
                    : field.type === "enum"
                      ? ["invalid", 1, null]
                      : field.type === "steps"
                        ? [[], [2, 1], [0], Array(17).fill(1)]
                        : [
                              null,
                              "1",
                              NaN,
                              Infinity,
                              ...(field.min === undefined
                                  ? []
                                  : [field.min === Number.MIN_VALUE ? 0 : field.min - 1]),
                              ...(field.max === undefined ? [] : [field.max + 1]),
                              ...(field.type === "integer" ? [1.5] : []),
                          ];
            for (const value of bad)
                assert.throws(
                    () =>
                        normalizePolicyOverrides({
                            [group.key]: { enabled: true, values: { [field.key]: value } },
                        }),
                    `${group.key}.${field.key}: ${String(value)}`,
                );
        }
    }
    assert.throws(() =>
        normalizePolicyOverrides({
            compaction: {
                enabled: true,
                values: { modelPolicies: [{ provider: "p", model: "m", auto: true }] },
            },
        }),
    );
    const model = normalizePolicyOverrides({
        compaction: {
            enabled: true,
            values: {
                modelPolicies: [
                    { provider: "p", model: "m", retainTokens: 0, thresholdRatio: 0.9 },
                ],
            },
        },
    });
    assert.deepEqual(model.compaction.values.modelPolicies, [
        { provider: "p", model: "m", retainTokens: 0, thresholdRatio: 0.9 },
    ]);
});

test("new engines capture profile policy once while summary model selection remains live", async (t) => {
    const profile = {
        summaryModels: [{ provider: "test", model: "summary-fixture" }],
        policyOverrides: normalizePolicyOverrides({
            compaction: {
                enabled: true,
                values: { auto: false, headroomTokens: 0, maxTokens: 333 },
            },
            release: { enabled: true, values: { catalogLimit: 2 } },
            summary: { enabled: true, values: { reasoning: "preserve", images: "references" } },
            reminders: { enabled: true, values: { enabled: false } },
        }),
    };
    const first = await fixture({ profileSettings: profile });
    t.after(first.close);
    assert.equal(first.engine.releasePolicy.catalogLimit, 2);
    assert.deepEqual(first.engine.summaryPolicy, { reasoning: "preserve", images: "references" });
    assert.equal(first.engine.reminderPolicy.enabled, false);
    profile.policyOverrides.summary.values.reasoning = "omit-from-summary";
    profile.policyOverrides.release.values.catalogLimit = 5;
    const second = await fixture({ profileSettings: profile });
    t.after(second.close);
    assert.equal(second.engine.releasePolicy.catalogLimit, 5);
    assert.equal(second.engine.summaryPolicy.reasoning, "omit-from-summary");
    assert.equal(first.engine.releasePolicy.catalogLimit, 2);
    assert.equal(first.engine.summaryPolicy.reasoning, "preserve");
    assert.equal(first.ctx.foldContextSettings.policies().release.values.catalogLimit, 5);
});
