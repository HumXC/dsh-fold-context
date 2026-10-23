import test from "node:test";
import assert from "node:assert/strict";
import { planPressureBudget } from "../lib/domain/pressure-budget.js";
import { fixture } from "./fixture.mjs";
const signal = () => new AbortController().signal;
test("target and safety remain ordered across model sizes and overrides", () => {
    for (const window of [4, 16, 1024, 4096, 252000, 1000000, Number.MAX_SAFE_INTEGER]) {
        for (const targetTokens of [undefined, 1, 170000, Number.MAX_SAFE_INTEGER]) {
            const plan = planPressureBudget(window, { targetTokens });
            assert.ok(plan.retain >= 0 && plan.retain < plan.threshold);
            assert.ok(plan.threshold < plan.safety && plan.safety < window);
            assert.ok(Number.isSafeInteger(plan.threshold) && Number.isSafeInteger(plan.safety));
            if (targetTokens !== undefined && targetTokens < plan.safety)
                assert.equal(plan.threshold, targetTokens);
        }
    }
});
test("252k with a 170k preference has a separate safety boundary", () => {
    const plan = planPressureBudget(252000, { targetTokens: 170000 });
    assert.equal(plan.threshold, 170000);
    assert.equal(plan.safety, 226800);
    assert.equal(plan.targetClamped, false);
    assert.equal(planPressureBudget(252000, { targetTokens: 300000 }).targetClamped, true);
});
test("invalid capacity and impossible tiny windows cannot invent room", () => {
    for (const window of [
        undefined,
        0,
        1,
        2,
        3,
        -1,
        NaN,
        Infinity,
        1.5,
        Number.MAX_SAFE_INTEGER + 1,
    ])
        assert.equal(planPressureBudget(window), null);
    for (const targetTokens of [0, -1, Infinity, 1.5])
        assert.throws(() => planPressureBudget(252000, { targetTokens }));
});
for (const window of [1024, 4096, 252000, 322000, 1000000]) {
    test(`automatic compaction uses a ${window}-token window despite large output limits`, async (t) => {
        const f = await fixture({ compaction: { auto: true, summaryMaxTokens: 1024 } });
        t.after(f.close);
        f.llm.resolveModelInfo = async () => ({
            context: { contextWindow: window },
            defaultMaxTokens: 256000,
        });
        f.session.append("request/header", {
            header: { config: { provider: "test", model: "fixture", maxTokens: 256000 } },
            reason: "initial",
        });
        f.session.append("turn/start", { turn: 1 });
        f.toolRound(
            "Earlier task evidence.",
            "Completed older work. ".repeat(Math.ceil(window / 4)),
        );
        const tail = f.appendUser(
            "Preserve the current user task and continue working. ".repeat(Math.ceil(window / 64)),
        );
        const before = f.meter.measure(f.session).totalTokens;
        const threshold = planPressureBudget(window, { summaryMaxTokens: 1024 }).threshold;
        assert.ok(before > threshold);
        assert.equal(
            (await f.engine.schedulingStatus(f.agent, signal())).pressure.thresholdTokens,
            threshold,
        );
        assert.equal(
            (await f.engine.releaseReminder(f.agent, signal())).thresholdTokens,
            threshold,
        );
        assert.ok(await f.engine.compactIfNeeded(f.agent, "pressure", signal()));
        assert.equal(f.calls.length, 1, "pressure runs without a model request or manual command");
        assert.ok(f.session.surface.nodes.includes(tail.seq));
        assert.ok(f.meter.measure(f.session).totalTokens < threshold);
        assert.equal(f.session.requestHeader().config.maxTokens, 256000);
        assert.equal(await f.engine.compactIfNeeded(f.agent, "pressure", signal()), null);
        assert.equal(f.calls.length, 1);
    });
}

test("per-model target overrides the global target without changing primary output", async (t) => {
    const f = await fixture({
        compaction: {
            targetTokens: 50000,
            modelPolicies: [{ provider: "test", model: "fixture", targetTokens: 17000 }],
        },
    });
    t.after(f.close);
    assert.equal((await f.engine.pressureBudget(f.agent, signal())).threshold, 17000);
    assert.equal(f.session.requestHeader().config.maxTokens, 1024);
});
