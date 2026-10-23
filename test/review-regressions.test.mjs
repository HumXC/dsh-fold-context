import test from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./fixture.mjs";

const signal = () => new AbortController().signal;

for (const auto of [false, true]) {
    test(`release that removes safety pressure returns to ordinary scheduling (auto=${auto})`, async () => {
        const f = await fixture({ compaction: { auto, targetTokens: 1000, cacheReadRatio: 0 } });
        try {
            f.llm.resolveModelInfo = async () => ({ context: { contextWindow: 3000 } });
            f.session.append("turn/start", { turn: 1 });
            f.appendUser("Prior objective. ".repeat(80));
            f.toolRound("read", "Prior evidence. ".repeat(80));
            f.appendUser("Current task. ".repeat(80));
            const original = f.engine.measurement.bind(f.engine);
            let total = 2100;
            let attempts = 0;
            f.engine.measurement = (session) => ({ ...original(session), totalTokens: total });
            f.engine.observedGrowth = () => 1;
            // Control only the reduction, retaining the real boundary/planner execution.
            f.engine.releaseBatch = async () => {
                total = 1500;
                return 1;
            };
            f.engine.compactSelectedRange = async () => {
                attempts++;
                return null;
            };
            await f.engine.compactIfNeeded(f.agent, "pressure", signal());
            const status = await f.engine.schedulingStatus(f.agent);
            assert.equal(total, 1500);
            assert.equal(status.decision, "wait");
            assert.equal(attempts, 0);
        } finally {
            await f.close();
        }
    });
}

async function summaryWorld({ native = true, driver = true, window = 131072, fails = false } = {}) {
    const f = await fixture({
        compaction: { auto: false, targetTokens: 100000 },
        summaryModels: [{ provider: "test", model: "fixture", useSessionAgent: native }],
    });
    if (driver) Object.assign(f.agent, { steer() {}, inject() {}, whenIdle() {} });
    f.llm.prepareCall = async (config) => {
        if (fails) throw new Error("model unavailable");
        return { config, context: { contextWindow: window } };
    };
    f.session.append("turn/start", { turn: 1 });
    f.appendUser("Historical objective. ".repeat(800));
    f.toolRound("read", "Source evidence. ".repeat(1600));
    f.appendUser("Protected current work. ".repeat(8000));
    await f.invoke("context_compact", { reason: "Preserve completed work." });
    const original = f.engine.measurement.bind(f.engine);
    // A controlled, matching primary-cache baseline for cost comparison.
    f.engine.measurement = (session) => ({ ...original(session), usageSeq: session.seq });
    f.engine.cacheEvidence = () => ({
        routeSignature: JSON.stringify(["test", "fixture"]),
        usageRouteSignature: JSON.stringify(["test", "fixture"]),
        usageAtMs: Date.now(),
        cacheReadTokens: original(f.session).totalTokens,
    });
    return f;
}

test("native preference cannot discount independent fallback for missing driver, failed preparation or headroom", async () => {
    let expected;
    for (const options of [
        { native: false },
        { driver: false },
        { window: 1000 },
        { fails: true },
    ]) {
        const f = await summaryWorld(options);
        try {
            const seq = f.session.seq;
            const header = f.session.requestHeader();
            const status = await f.engine.schedulingStatus(f.agent);
            assert.equal(status.summaryInput.execution, "independent");
            assert.equal(f.session.seq, seq);
            assert.equal(f.session.requestHeader(), header);
            assert.equal(f.engine.hasSessionSummaryWork(f.session), false);
            assert.equal(f.calls.length, 0);
            if (expected === undefined) expected = status.plan.summaryCost;
            assert.equal(status.plan.summaryCost, expected);
            await f.engine.compactSelectedRange(
                status.selection.start,
                status.selection.end,
                f.agent,
                signal(),
            );
            assert.equal(f.calls.length, 1);
            assert.equal(f.calls[0].sessionId, undefined);
        } finally {
            await f.close();
        }
    }
});

test("admitted session summary prices the complete tail and uncached instruction without starting preparation", async () => {
    const f = await summaryWorld();
    try {
        const seq = f.session.seq;
        const header = f.session.requestHeader();
        const measured = f.engine.measurement(f.session);
        const status = await f.engine.schedulingStatus(f.agent);
        assert.equal(status.summaryInput.execution, "session");
        assert.ok(
            status.summaryInput.totalTokens >
                Math.max(measured.totalTokens, measured.surfaceTokens),
        );
        assert.ok(status.summaryInput.framingTokens > 0);
        assert.ok(status.summaryInput.totalTokens > status.plan.selectedTokens);
        assert.ok(
            status.plan.summaryCost <
                status.summaryInput.totalTokens + status.plan.predictedSummaryTokens,
        );
        assert.equal(f.session.seq, seq);
        assert.equal(f.session.requestHeader(), header);
        assert.equal(f.engine.hasSessionSummaryWork(f.session), false);
        assert.equal(f.calls.length, 0);
        const admitted = await f.engine.sessionSummaries.prepare(
            f.agent,
            status.selection,
            signal(),
        );
        assert.ok(admitted);
        assert.equal(f.engine.hasSessionSummaryWork(f.session), true);
    } finally {
        await f.close();
    }
});
