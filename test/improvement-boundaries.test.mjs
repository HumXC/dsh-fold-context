import test from "node:test";
import assert from "node:assert/strict";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { planScheduledCompaction } from "../lib/domain/scheduler.js";
import { fixture } from "./fixture.mjs";

const candidate = (extra = {}) => ({
    trigger: "model_request",
    totalTokens: 15000,
    selectedTokens: 10000,
    prefixTokens: 1000,
    headerOverheadTokens: 2000,
    filterInputTokens: 4000,
    stepsSinceSummary: 8,
    targetTokens: 14000,
    safetyTokens: 20000,
    markedIds: [],
    ...extra,
});

test("stable request headers do not enter the changed historical cache suffix", () => {
    const plan = planScheduledCompaction(candidate(), { cacheReadRatio: 1 });
    assert.equal(plan.retainedSurfaceTokens, 2000);
    assert.equal(plan.predictedSummaryTokens, 800);
    assert.equal(plan.rebuiltSuffixTokens, 2800);
    assert.equal(plan.initialRebuildPenalty, 0);
    assert.equal(plan.decision, "execute");
    assert.equal(plan.reason, "window_pressure");
    assert.throws(() => planScheduledCompaction(candidate({ headerOverheadTokens: 5000 })));
});

for (const queued of [false, true]) {
    test(`ordinary image-rich history skips auxiliary planning with ${queued ? "automatic summaries disabled" : "no request or marks"}`, async (t) => {
        const f = await fixture({
            compaction: {
                auto: !queued,
                targetTokens: 100000,
            },
            summaryModels: [{ provider: "test", model: "auxiliary" }],
            scheduling: {},
        });
        t.after(f.close);
        const message = createUserMessage({
            source: { kind: "user" },
            content: [
                { type: "text", text: "Retained evidence. ".repeat(2000) },
                ...Array.from({ length: 4 }, (_, index) => ({
                    type: "image",
                    attachment: {
                        attachmentId: `isolated-image-${index}`,
                        mediaType: "image/png",
                        bytes: 4,
                        width: 1,
                        height: 1,
                    },
                })),
            ],
        });
        f.session.append("user/message", message, { surfaceOp: "append" });
        if (queued) {
            const id = f.engine
                .state(f.session)
                .entries.find((entry) => entry.messageId === message.id).id;
            const outcome = await f.invoke("context_release", {
                ids: [Number(id)],
                reason: "Consumed text",
            });
            assert.equal(outcome.isError, false);
        }
        const original = f.ctx.llm.resolveModelInfo;
        const routes = [];
        f.ctx.llm.resolveModelInfo = async (provider, model, signal) => {
            routes.push({ provider, model });
            assert.notEqual(
                model,
                "auxiliary",
                "no-action steps must not resolve the summary capability",
            );
            return original(provider, model, signal);
        };
        const before = {
            seq: f.session.seq,
            nodes: [...f.session.surface.nodes],
            numbering: structuredClone(f.engine.state(f.session).numbering),
        };
        assert.equal(
            await f.engine.compactIfNeeded(f.agent, "pressure", new AbortController().signal),
            null,
        );
        assert.ok(routes.length > 0, "ordinary checks resolve the primary route");
        assert.ok(
            routes.every((route) => route.provider === "test" && route.model === "fixture"),
            "no-action checks must resolve only the primary route, never an auxiliary model",
        );
        assert.deepEqual(
            {
                seq: f.session.seq,
                nodes: [...f.session.surface.nodes],
                numbering: structuredClone(f.engine.state(f.session).numbering),
            },
            before,
        );
        assert.equal(f.calls.length, 0);
    });
}
