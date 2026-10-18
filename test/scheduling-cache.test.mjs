import test from "node:test";
import assert from "node:assert/strict";
import { createAssistantMessage } from "@deepseek-ai/dsh-llm";
import { fixture } from "./fixture.mjs";

for (const [cacheReadTokens, cacheState, ratio, basis] of [
    [undefined, "unknown", 0.1, "assumed_cached"],
    [100, "cached", 0.1, "primary_usage"],
    [0, "uncached", 1, "primary_usage"],
]) {
    test(`primary usage maps ${cacheState} cache evidence into scheduling without guessing a hit`, async (t) => {
        const f = await fixture({ compaction: { retainTokens: 256 }, scheduling: {} });
        t.after(f.close);
        f.session.append("turn/start", { turn: 1 });
        for (let step = 0; step < 8; step++)
            f.toolRound("finished_work", "Completed business evidence. ".repeat(128));
        await f.invoke("context_compact", { reason: "Checkpoint the completed evidence." });
        const inputTokens = f.meter.measure(f.session).totalTokens;
        const usage = {
            inputTokens,
            outputTokens: 4,
            ...(cacheReadTokens === undefined ? {} : { cacheReadTokens }),
        };
        f.session.append("step/start", { turn: 1, step: 10 });
        f.session.append(
            "assistant/message",
            {
                turn: 1,
                step: 10,
                message: createAssistantMessage({
                    source: { provider: "test", model: "fixture" },
                    content: [{ type: "text", text: "Completed cache measurement." }],
                }),
                usage,
                stream: [],
            },
            { surfaceOp: "append" },
        );
        f.session.append("step/end", { turn: 1, step: 10 });
        f.advanceSteps(10);
        f.appendUser("Preserve this current task. ".repeat(80));
        const status = await f.engine.schedulingStatus(f.agent);
        assert.equal(status.plan.cacheState, cacheState);
        assert.equal(status.plan.effectiveCacheReadRatio, ratio);
        assert.equal(status.diagnostic.economics.cacheBasis, basis);
        assert.equal(status.plan.cachedPrefixAssumed, cacheState !== "uncached");
        if (cacheState === "uncached") assert.equal(status.plan.initialRebuildPenalty, 0);
        assert.equal(f.calls.length, 0);
    });
}
