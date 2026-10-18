import test from "node:test";
import assert from "node:assert/strict";
import { planPressureBudget } from "../lib/domain/pressure-budget.js";
import { fixture } from "./fixture.mjs";

const policy = { thresholdRatio: 0.8, retainRatio: 0.16 };
const signal = () => new AbortController().signal;

test("window budgets cover tiny, DeepSeek and maximum safe capacities", () => {
    for (const [window, threshold, retain] of [
        [1, 1, 0],
        [2, 1, 0],
        [1024, 819, 163],
        [252000, 201600, 40320],
        [322000, 257600, 51520],
        [1000000, 800000, 160000],
    ]) {
        assert.deepEqual(planPressureBudget(window, policy), { threshold, retain });
    }
    const maximum = planPressureBudget(Number.MAX_SAFE_INTEGER, policy);
    assert.ok(Number.isSafeInteger(maximum.threshold));
    assert.ok(Number.isSafeInteger(maximum.retain));
    assert.ok(maximum.retain < maximum.threshold);
    assert.ok(maximum.threshold <= Number.MAX_SAFE_INTEGER);
});

test("window budgets stay ordered and bounded across ratios and tail targets", () => {
    const windows = [1, 2, 3, 16, 1024, 65536, 252000, 322000, 1000000, Number.MAX_SAFE_INTEGER];
    for (const thresholdRatio of [Number.MIN_VALUE, 0.001, 0.5, 0.8, 1]) {
        for (const retainTokens of [undefined, 0, 512, Number.MAX_SAFE_INTEGER]) {
            let previousThreshold = 0;
            for (const window of windows) {
                const budget = planPressureBudget(window, {
                    ...policy,
                    thresholdRatio,
                    retainTokens,
                });
                assert.ok(Number.isSafeInteger(budget.threshold));
                assert.ok(Number.isSafeInteger(budget.retain));
                assert.ok(0 <= budget.retain && budget.retain < budget.threshold);
                assert.ok(budget.threshold >= previousThreshold && budget.threshold <= window);
                previousThreshold = budget.threshold;
            }
        }
    }
    assert.deepEqual(planPressureBudget(1024, { ...policy, retainTokens: 10000 }), {
        threshold: 819,
        retain: 818,
    });
});

test("missing and invalid windows remain unavailable", () => {
    for (const window of [undefined, 0, -1, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1])
        assert.equal(planPressureBudget(window, policy), null);
});

for (const window of [1024, 4096, 252000, 322000, 1000000]) {
    test(`automatic compaction uses a ${window}-token window despite large output limits`, async (t) => {
        const f = await fixture({ compaction: { auto: true, headroomTokens: 65536 } });
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
        const threshold = Math.floor(window * policy.thresholdRatio);
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

test("model tail policies override defaults and oversized tails are clipped", async (t) => {
    const cases = [
        { global: { retainTokens: 700 }, override: { retainRatio: 0.1 }, expected: 102 },
        { global: { retainRatio: 0.16 }, override: { retainTokens: 10000 }, expected: 818 },
        { global: { retainTokens: 10000 }, override: {}, expected: 818 },
        { global: { retainRatio: 0.16 }, override: { retainTokens: 123 }, expected: 123 },
    ];
    for (const { global, override, expected } of cases) {
        const f = await fixture({
            compaction: {
                auto: true,
                ...global,
                modelPolicies: [{ provider: "test", model: "fixture", ...override }],
            },
        });
        t.after(f.close);
        f.llm.resolveModelInfo = async () => ({ context: { contextWindow: 1024 } });
        assert.equal((await f.engine.pressureBudget(f.agent, signal())).retain, expected);
    }
});
