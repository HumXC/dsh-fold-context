import test from "node:test";
import assert from "node:assert/strict";
import { Config } from "../lib/index.js";
import { resolveSchedulingPolicy } from "../lib/domain/scheduler.js";
import { fixture } from "./fixture.mjs";

test("public policy exposes only window, relative cost and reminder controls", () => {
    for (const input of [{}, { policy: {} }]) {
        const config = Config(input);
        assert.deepEqual(Object.keys(config.policy).sort(), [
            "compaction",
            "reminders",
            "scheduling",
            "summary",
        ]);
        assert.equal(config.policy.compaction.cacheReadRatio, 0.1);
        assert.deepEqual(config.policy.reminders, { enabled: true });
        assert.deepEqual(Object.keys(config.policy.scheduling).sort(), [
            "cacheTtlMs",
            "summaryInputRatio",
            "summaryOutputRatio",
        ]);
        assert.equal(config.policy.scheduling.cacheTtlMs, 0);
        assert.equal(Object.hasOwn(config, "scheduling"), false);
        assert.equal(Object.hasOwn(config.policy.compaction, "retainTokens"), false);
    }
});

for (const scheduling of [null, {}]) {
    test(`Cordis mounting resolves internal relative costs with ${JSON.stringify(scheduling)}`, async (t) => {
        const f = await fixture({ scheduling });
        t.after(f.close);
        assert.deepEqual(f.engine.schedulingPolicy, resolveSchedulingPolicy());
        assert.equal(Object.hasOwn(f.engine.schedulingPolicy, "paybackTurns"), false);
    });
}

test("compaction cache ratio is authoritative when mounting the scheduling engine", async (t) => {
    const f = await fixture({
        compaction: { cacheReadRatio: 0.35, targetTokens: 17000 },
        scheduling: { summaryInputRatio: 0.2, summaryOutputRatio: 2, cacheTtlMs: 60000 },
    });
    t.after(f.close);
    f.session.append("turn/start", { turn: 1 });
    f.appendUser("Historical work. ".repeat(5000));
    await f.invoke("context_compact", { reason: "Inspect effective cost policy" });
    f.appendUser("Protected current task. ".repeat(1200));
    const status = await f.engine.schedulingStatus(f.agent);
    assert.equal(status.plan.effectiveCacheReadRatio, 0.35);
    assert.equal(f.engine.schedulingPolicy.summaryInputRatio, 0.2);
    assert.equal(f.engine.schedulingPolicy.summaryOutputRatio, 2);
    assert.equal(f.engine.schedulingPolicy.cacheTtlMs, 60000);
});

for (const invalid of [
    { compaction: { auto: true } },
    { scheduling: { paybackTurns: 24 } },
    { policy: { compaction: { retainTokens: 512 } } },
    { policy: { scheduling: { paybackTurns: 24 } } },
    { policy: { scheduling: { cacheReadRatio: 0.5 } } },
    { policy: { reminders: { minAgeSteps: 2 } } },
]) {
    test(`removed public configuration is rejected: ${JSON.stringify(invalid)}`, () => {
        assert.throws(() => Config(invalid));
    });
}
