import test from "node:test";
import assert from "node:assert/strict";
import { Config } from "../lib/index.js";
import { planScheduledCompaction, resolveSchedulingPolicy } from "../lib/domain/scheduler.js";
import { fixture } from "./fixture.mjs";

const candidate = {
    trigger: "model_request",
    totalTokens: 12000,
    selectedTokens: 8000,
    prefixTokens: 1000,
    filterInputTokens: 8000,
    stepsSinceSummary: 8,
    markedIds: [],
};

test("public scheduling defaults preserve the domain policy and admit a 22-request payback", () => {
    for (const input of [{}, { scheduling: {} }]) {
        const config = Config(input);
        assert.deepEqual(config.scheduling, resolveSchedulingPolicy());
        assert.equal(config.scheduling.paybackTurns, 24);
        assert.equal(config.scheduling.cacheReadRatio, 0.1);
        const plan = planScheduledCompaction(candidate, config.scheduling);
        assert.equal(plan.breakEvenTurns, 22);
        assert.equal(plan.reason, "eligible");
    }
});

for (const scheduling of [null, {}, { cacheReadRatio: 0.1 }]) {
    test(`Cordis mounting applies the default horizon with ${JSON.stringify(scheduling)}`, async (t) => {
        const f = await fixture({ scheduling });
        t.after(f.close);
        assert.deepEqual(f.engine.schedulingPolicy, resolveSchedulingPolicy());
        assert.equal(f.engine.schedulingPolicy.paybackTurns, 24);
        assert.equal(
            planScheduledCompaction(candidate, f.engine.schedulingPolicy).reason,
            "eligible",
        );
    });
}

test("Cordis mounting preserves an explicit short horizon and its economic gate", async (t) => {
    const f = await fixture({ scheduling: { paybackTurns: 8 } });
    t.after(f.close);
    assert.equal(f.engine.schedulingPolicy.paybackTurns, 8);
    assert.equal(f.engine.schedulingPolicy.cacheReadRatio, 0.1);
    assert.equal(
        planScheduledCompaction(candidate, f.engine.schedulingPolicy).reason,
        "not_paid_back",
    );
});
