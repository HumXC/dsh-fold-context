import test from "node:test";
import assert from "node:assert/strict";
import { Context } from "@deepseek-ai/cordis";
import { createAssistantMessage, LlmError } from "@deepseek-ai/dsh-llm";
import { Config, apply } from "../lib/index.js";
import { resolveSummaryModels, summaryCandidates } from "../lib/domain/summary-models.js";
import { fixture } from "./fixture.mjs";

const route = { provider: "test", model: "fixture" };
const model = (name, extra = {}) => ({ provider: "test", model: name, ...extra });
const evidence = (f) => {
    f.appendUser("Keep the requested implementation and exact evidence. ".repeat(500));
    f.toolRound("read", "Important source evidence. ".repeat(500));
    f.appendUser("Continue the next stage.");
};
const compact = (f, signal = new AbortController().signal) => f.engine.compactNow(f.agent, signal);
const failureText = (error) => `${error.message} ${error.cause ? failureText(error.cause) : ""}`;
test("session matches are stably promoted only within the configured list", () => {
    const list = resolveSummaryModels([model("deepseek"), model("fixture"), model("other")]);
    assert.ok(list.every((item) => item.preferWhenSessionMatches));
    assert.deepEqual(
        summaryCandidates(list, route).map((item) => item.model),
        ["fixture", "deepseek", "other"],
    );
    list[1].preferWhenSessionMatches = false;
    assert.deepEqual(
        summaryCandidates(list, route).map((item) => item.model),
        ["deepseek", "fixture", "other"],
    );
    assert.deepEqual(
        summaryCandidates(list, { provider: "another", model: "fixture" }).map(
            (item) => item.model,
        ),
        ["deepseek", "fixture", "other"],
    );
    assert.equal(summaryCandidates([], route)[0].model, "fixture");
    assert.doesNotThrow(() => resolveSummaryModels([model("a"), model("a")]));
    assert.doesNotThrow(() =>
        resolveSummaryModels([
            model("a", { reasoningEffort: "low" }),
            model("a", { reasoningEffort: "high" }),
        ]),
    );
});

test("fold owns its Config schema and the profile settings owner never mounts compaction", async (t) => {
    const ctx = new Context();
    t.after(() => ctx.fiber.dispose());
    const config = Config({ uiOnly: true, summaryModels: [model("fixture")] });
    apply(ctx, config);
    assert.equal(ctx.get("compaction"), undefined);
    assert.deepEqual(ctx.foldContextSettings.current(), resolveSummaryModels([model("fixture")]));
    const schema = JSON.stringify(Config.toJSON());
    assert.ok(schema.includes("summaryModels"));
    assert.ok(!schema.includes("summarizationProvider"));
    assert.ok(!schema.includes("summarizationModel"));
});

test("matching and nonmatching summaries use independent projected requests without adding dialogue", async (t) => {
    for (const target of ["fixture", "different"]) {
        await t.test(target, async (t) => {
            const f = await fixture({ summaryModels: [model(target)] });
            t.after(f.close);
            f.session.append("request/header", {
                header: { config: { ...route, maxTokens: 1024, reasoningEffort: "high" } },
                reason: "changed",
            });
            const user = f.appendUser("Preserve the active objective. ".repeat(600));
            f.session.append("step/start", { turn: 1, step: 1 });
            const assistant = createAssistantMessage({
                source: { ...route, replayState: { response: { signed: "native-signature" } } },
                content: [
                    { type: "reasoning", text: "Private historical reasoning." },
                    { type: "text", text: "Verified conclusion. ".repeat(300) },
                ],
            });
            const originalAssistant = f.session.append(
                "assistant/message",
                { turn: 1, step: 1, message: assistant, stream: [] },
                { surfaceOp: "append" },
            );
            f.session.append("step/end", { turn: 1, step: 1 });
            f.appendUser("Keep working.");
            const beforeDialogue = f.session
                .snapshotEvents()
                .filter((event) =>
                    ["assistant/message", "user/message"].includes(event.type),
                ).length;
            assert.ok(await compact(f));
            assert.equal(f.calls.length, 1);
            const request = f.calls[0];
            assert.equal(request.model, target);
            assert.equal(Object.hasOwn(request, "reasoningEffort"), false);
            assert.equal(Object.hasOwn(request, "sessionId"), false);
            assert.equal(request.purpose, "compaction");
            assert.equal(
                request.messages.some(
                    (message) => message.id === user.data.id || message.id === assistant.id,
                ),
                false,
            );
            const projected = JSON.stringify(request.messages);
            assert.ok(projected.includes("Preserve the active objective."));
            assert.ok(projected.includes("Verified conclusion."));
            assert.ok(!projected.includes("Private historical reasoning."));
            assert.ok(!projected.includes("native-signature"));
            assert.deepEqual(f.session.eventAt(originalAssistant.seq).data.message, assistant);
            const dialogue = f.session
                .snapshotEvents()
                .filter((event) => ["assistant/message", "user/message"].includes(event.type));
            assert.equal(
                dialogue.length,
                beforeDialogue + 1,
                "only the committed checkpoint enters dialogue",
            );
            assert.ok(
                !dialogue.some((event) =>
                    JSON.stringify(event.data).includes("Create a concise checkpoint"),
                ),
            );
            assert.equal(
                f.engine.state(f.session).lastSummary.projection.reasoning,
                "omit-from-summary",
            );
        });
    }
});

test("a disabled match priority respects list order and explicit summary effort", async (t) => {
    const f = await fixture({
        summaryModels: [
            model("first", { reasoningEffort: "low" }),
            model("fixture", { preferWhenSessionMatches: false }),
        ],
    });
    t.after(f.close);
    f.llm.resolveModelInfo = async () => ({
        context: { contextWindow: 131072 },
        reasoning: { efforts: [{ id: "low", name: "Low" }] },
    });
    evidence(f);
    await compact(f);
    assert.equal(f.calls[0].model, "first");
    assert.equal(f.calls[0].reasoningEffort, "low");
});

test("terminal provider failure discards partial output and commits only the next candidate", async (t) => {
    const f = await fixture({ summaryModels: [model("first"), model("second")] });
    t.after(f.close);
    const stream = f.llm.stream;
    f.llm.stream = async function* (input) {
        if (input.model !== "first") {
            yield* stream(input);
            return;
        }
        f.calls.push(input);
        yield { type: "block-start", index: 0, blockType: "text" };
        yield { type: "block-end", index: 0, block: { type: "text", text: "UNCOMMITTED_PARTIAL" } };
        yield {
            type: "finish",
            reason: { kind: "error", failure: { code: "RATE_LIMIT", message: "Provider busy" } },
        };
    };
    evidence(f);
    const result = await compact(f);
    assert.deepEqual(
        f.calls.map((request) => request.model),
        ["first", "second"],
    );
    const summaries = f.session
        .snapshotEvents()
        .filter((event) => event.type === "compaction/summary");
    assert.equal(summaries.length, 1);
    assert.equal(summaries[0].data.model, "second");
    assert.ok(!JSON.stringify(summaries[0]).includes("UNCOMMITTED_PARTIAL"));
    assert.equal(summaries[0].seq, result.summarySeq);
});

test("an unavailable route and provider-confirmed context overflow advance to a usable candidate", async (t) => {
    const f = await fixture({ summaryModels: [model("missing"), model("tiny"), model("working")] });
    t.after(f.close);
    const resolve = f.llm.resolveModelInfo;
    f.llm.resolveModelInfo = async (provider, name, signal) => {
        if (name === "missing") throw new LlmError("route unavailable", "NO_ADAPTER");
        if (name === "tiny") return { context: { contextWindow: 64 } };
        return resolve(provider, name, signal);
    };
    const stream = f.llm.stream;
    f.llm.stream = async function* (input) {
        if (input.model !== "tiny") {
            yield* stream(input);
            return;
        }
        f.calls.push(input);
        yield {
            type: "finish",
            reason: {
                kind: "error",
                failure: {
                    code: "CONTEXT_WINDOW_EXCEEDED",
                    message: "Input exceeds provider window",
                },
            },
        };
    };
    evidence(f);
    await compact(f);
    assert.deepEqual(
        f.calls.map((request) => request.model),
        ["tiny", "working"],
    );
});

test("cancellation and consumer errors stop the candidate list without a summary commit", async (t) => {
    for (const cancelled of [false, true]) {
        const controller = new AbortController();
        const f = await fixture({
            summaryModels: [model("first"), model("second")],
            onStream: () => {
                if (cancelled) controller.abort(new Error("user stopped summary"));
                else throw new Error("consumer invariant failed");
            },
        });
        t.after(f.close);
        evidence(f);
        await assert.rejects(compact(f, controller.signal), (error) => {
            assert.match(failureText(error), cancelled ? /user stopped/ : /consumer invariant/);
            return true;
        });
        assert.equal(f.calls.length, 1);
        assert.equal(
            f.session.snapshotEvents().filter((event) => event.type === "compaction/summary")
                .length,
            0,
        );
        assert.equal(f.engine.state(f.session).activeStart, null);
    }
});

test("all candidates failing preserves history and reports every model", async (t) => {
    const f = await fixture({
        summaryModels: [model("first"), model("second")],
        finish: "max-tokens",
    });
    t.after(f.close);
    evidence(f);
    const surface = [...f.session.surface.nodes];
    await assert.rejects(compact(f), (error) => {
        assert.match(failureText(error), /first.*second/);
        return true;
    });
    assert.deepEqual(f.session.surface.nodes, surface);
    assert.equal(f.engine.state(f.session).activeStart, null);
});

test("existing engines read the profile owner's latest snapshot at each summary", async (t) => {
    const f = await fixture();
    t.after(f.close);
    let current = resolveSummaryModels([model("first")]);
    const owner = f.ctx.plugin({
        apply(ctx) {
            apply(ctx, { uiOnly: true, summaryModels: { get: () => current } });
        },
    });
    await owner.await();
    evidence(f);
    await compact(f);
    assert.equal(f.calls[0].model, "first");
    current = resolveSummaryModels([model("second")]);
    evidence(f);
    await compact(f);
    assert.equal(f.calls.at(-1).model, "second");
});

test("following the session uses ordinary projection and model defaults", async (t) => {
    const f = await fixture({ summaryModels: [] });
    t.after(f.close);
    f.session.append("request/header", {
        header: { config: { ...route, maxTokens: 1024, reasoningEffort: "high" } },
        reason: "changed",
    });
    f.appendUser("Preserve the user goal. ".repeat(600));
    const result = f.toolRound("read", "DISCARD_NATIVE_SECRET ".repeat(600));
    f.toolRound("grep", "Keep this evidence. ".repeat(600));
    await f.invoke("context_release", {
        ids: [Number(f.idFor(result))],
        reason: "Consumed evidence",
    });
    f.appendUser("Next phase.");
    await compact(f);
    assert.equal(f.calls[0].model, "fixture");
    assert.equal(Object.hasOwn(f.calls[0], "sessionId"), false);
    assert.equal(Object.hasOwn(f.calls[0], "reasoningEffort"), false);
    assert.ok(!JSON.stringify(f.calls[0].messages).includes("DISCARD_NATIVE_SECRET"));
    assert.equal(f.engine.state(f.session).lastSummary.projection.reasoning, "omit-from-summary");
});

test("same-model fallback uses ordinary projection when its priority switch is off", async (t) => {
    const f = await fixture({
        summaryModels: [model("missing"), model("fixture", { preferWhenSessionMatches: false })],
    });
    t.after(f.close);
    const resolve = f.llm.resolveModelInfo;
    f.llm.resolveModelInfo = async (provider, name, signal) => {
        if (name === "missing") throw new LlmError("Unavailable", "NO_ADAPTER");
        return resolve(provider, name, signal);
    };
    const user = f.appendUser("Preserve the active task. ".repeat(600));
    f.toolRound("read", "Verified task evidence. ".repeat(600));
    f.appendUser("Continue.");
    await compact(f);
    assert.equal(f.calls[0].model, "fixture");
    assert.equal(Object.hasOwn(f.calls[0], "sessionId"), false);
    assert.equal(
        f.calls[0].messages.some((message) => message.id === user.data.id),
        false,
    );
    assert.ok(JSON.stringify(f.calls[0].messages).includes("Preserve the active task."));
    assert.equal(f.engine.state(f.session).lastSummary.projection.reasoning, "omit-from-summary");
});
