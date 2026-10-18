import test from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./fixture.mjs";
import { describeScheduling } from "../lib/domain/scheduling-diagnostics.js";
import { planScheduledCompaction, resolveSchedulingPolicy } from "../lib/domain/scheduler.js";

const signal = () => new AbortController().signal;

for (const [context, reason] of [
    [undefined, "missing_capacity"],
    [{ contextWindow: 0 }, "invalid_capacity"],
    [{ contextWindow: Infinity }, "invalid_capacity"],
]) {
    test(`unavailable pressure reports ${reason} without changing the session`, async (t) => {
        const f = await fixture({ scheduling: {} });
        t.after(f.close);
        f.llm.resolveModelInfo = async () => ({ context });
        const before = JSON.stringify(f.session.snapshotEvents());
        const status = await f.engine.schedulingStatus(f.agent, signal());
        assert.equal(status.reason, reason);
        assert.ok(status.diagnostic.summary.length > 20);
        assert.ok(status.diagnostic.nextAction.length > 20);
        assert.equal(status.limits, null);
        assert.equal(status.pressure.thresholdTokens, null);
        assert.equal(JSON.stringify(f.session.snapshotEvents()), before);
    });
}

test("metadata failures preserve backlog inspection and do not expose provider errors", async (t) => {
    const f = await fixture({ compaction: { auto: true }, scheduling: {} });
    t.after(f.close);
    f.llm.resolveModelInfo = async () => {
        throw new Error("private-provider-detail-sentinel");
    };
    const before = f.session.seq;
    const status = await f.engine.schedulingStatus(f.agent, signal());
    assert.equal(status.reason, "metadata_unavailable");
    assert.doesNotMatch(JSON.stringify(status), /private-provider-detail-sentinel/);
    assert.equal((await f.engine.releaseReminder(f.agent, signal())).thresholdTokens, null);
    assert.equal(await f.engine.compactIfNeeded(f.agent, "pressure", signal()), null);
    assert.equal(f.session.seq, before);
    assert.equal(f.calls.length, 0);
});

test("metadata cancellation remains cancellation rather than a scheduling wait", async (t) => {
    const f = await fixture({ scheduling: {} });
    t.after(f.close);
    const controller = new AbortController();
    f.llm.resolveModelInfo = async () => {
        controller.abort();
        throw new Error("metadata lookup interrupted");
    };
    await assert.rejects(f.engine.schedulingStatus(f.agent, controller.signal), {
        name: "AbortError",
    });
    f.llm.resolveModelInfo = async () => {
        throw new DOMException("cancelled", "AbortError");
    };
    await assert.rejects(f.engine.schedulingStatus(f.agent, signal()), { name: "AbortError" });
});

test("fixed request overhead explains an unreachable pressure target", async (t) => {
    const f = await fixture({ compaction: { auto: true }, scheduling: {} });
    t.after(f.close);
    f.llm.resolveModelInfo = async () => ({ context: { contextWindow: 1024 } });
    f.session.append("request/header", {
        header: {
            config: { provider: "test", model: "fixture", maxTokens: 256000 },
            tools: [
                {
                    name: "large_definition",
                    description: "Preserved tool definition. ".repeat(500),
                    parameters: {},
                },
            ],
        },
        reason: "initial",
    });
    const tail = f.appendUser("Keep the current task.");
    const status = await f.engine.schedulingStatus(f.agent, signal());
    assert.ok(status.limits.headerOverheadTokens >= status.limits.thresholdTokens);
    assert.equal(status.diagnostic.constraints[0].code, "fixed_overhead");
    assert.ok(status.limits.minimumPromptTokens <= status.pressure.totalTokens);
    assert.ok(f.session.surface.nodes.includes(tail.seq));
    assert.equal(f.calls.length, 0);
});

test("protected current input is diagnosed without summarizing away the task", async (t) => {
    const f = await fixture({ compaction: { auto: true, retainTokens: 1 }, scheduling: {} });
    t.after(f.close);
    f.llm.resolveModelInfo = async () => ({ context: { contextWindow: 1024 } });
    const tail = f.appendUser("Current task requirements must remain. ".repeat(300));
    const status = await f.engine.schedulingStatus(f.agent, signal());
    assert.equal(status.reason, "no_selection");
    assert.equal(status.diagnostic.constraints[0].code, "protected_input");
    assert.ok(status.limits.protectedTailTokens >= status.limits.thresholdTokens);
    assert.equal(await f.engine.compactIfNeeded(f.agent, "pressure", signal()), null);
    assert.ok(f.session.surface.nodes.includes(tail.seq));
    assert.equal(f.calls.length, 0);
});

test("an atomic old step retained by the tail budget has an explicit no-selection explanation", async (t) => {
    const f = await fixture({ compaction: { auto: true }, scheduling: {} });
    t.after(f.close);
    f.llm.resolveModelInfo = async () => ({ context: { contextWindow: 4096 } });
    f.session.append("turn/start", { turn: 1 });
    f.toolRound("older_work", "Completed older work. ".repeat(1024));
    const tail = f.appendUser("Keep the active task.");
    const status = await f.engine.schedulingStatus(f.agent, signal());
    assert.equal(status.reason, "no_selection");
    assert.match(status.diagnostic.summary, /balanced historical prefix.*retention/);
    assert.ok(status.limits.retentionTokens > status.limits.protectedTailTokens);
    assert.equal(status.diagnostic.constraints.length, 0);
    assert.ok(f.session.surface.nodes.includes(tail.seq));
});

test("summary input breakdown and protected lower bound conserve token estimates", async (t) => {
    const f = await fixture({ compaction: { retainTokens: 32 }, scheduling: {} });
    t.after(f.close);
    f.session.append("turn/start", { turn: 1 });
    f.toolRound("older_work", "Business evidence. ".repeat(900));
    f.appendUser("Keep this complete active task. ".repeat(30));
    const before = JSON.stringify(f.session.snapshotEvents());
    const status = await f.engine.schedulingStatus(f.agent, signal());
    const input = status.summaryInput;
    assert.ok(input.historyTokens > 0);
    assert.equal(
        input.totalTokens,
        input.historyTokens + input.systemTokens + input.toolsTokens + input.framingTokens,
    );
    assert.equal(status.plan.filterInputTokens, input.totalTokens);
    assert.equal(
        status.limits.minimumPromptTokens,
        status.limits.headerOverheadTokens +
            status.limits.systemHeadTokens +
            status.limits.protectedTailTokens,
    );
    assert.ok(status.limits.minimumPromptTokens <= status.plan.totalTokens);
    assert.deepEqual(await f.engine.schedulingStatus(f.agent, signal()), status);
    assert.equal(JSON.stringify(f.session.snapshotEvents()), before);
    assert.equal(f.calls.length, 0);
});

test("payback diagnostics compare future requests and cost assumptions rather than elapsed steps", () => {
    const policy = resolveSchedulingPolicy({ paybackTurns: 8 });
    const value = {
        trigger: "backlog",
        totalTokens: 12000,
        selectedTokens: 8000,
        prefixTokens: 1000,
        excludedTokens: 2000,
        stepsSinceSummary: 100,
        markedIds: ["T1"],
    };
    const plan = planScheduledCompaction(value, policy);
    const diagnostic = describeScheduling(
        { reason: plan.reason, plan, limits: null, retryAfterSteps: 0 },
        policy,
    );
    assert.equal(plan.reason, "not_paid_back");
    assert.match(diagnostic.summary, /17 future primary requests.*8/);
    assert.match(diagnostic.nextAction, /waiting alone does not accumulate/);
    assert.equal(diagnostic.economics.upfrontCost, 10980);
    assert.equal(diagnostic.economics.expectedSaving, 5440);
    assert.equal(diagnostic.economics.cacheBasis, "assumed_cached");
    const noSaving = planScheduledCompaction(value, { ...policy, cacheReadRatio: 0 });
    assert.match(
        describeScheduling(
            { reason: noSaving.reason, plan: noSaving, limits: null, retryAfterSteps: 0 },
            policy,
        ).summary,
        /no finite estimated payback/,
    );
});
