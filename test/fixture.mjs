import { Context } from "@deepseek-ai/cordis";
import { SessionStore } from "@deepseek-ai/dsh-session";
import { SessionProjectionRegistry } from "@deepseek-ai/dsh-session-projection";
import { TokenMeter } from "@deepseek-ai/dsh-token-meter";
import { ToolRuntime } from "@deepseek-ai/dsh-tools";
import { SystemPrompt } from "@deepseek-ai/dsh-system-prompt";
import { InvariantRegistry } from "@deepseek-ai/dsh-invariants";
import { apply as installCompactionInvariants } from "@deepseek-ai/dsh-compaction/invariant";
import {
    createAssistantMessage,
    createToolResultMessage,
    createUserMessage,
} from "@deepseek-ai/dsh-llm";
import { apply as mountCompression } from "../lib/index.js";

/** Fresh Cordis world, RAM sessions and mock stream only: no network, storage backend, profile or Web. */
export async function fixture(options = {}) {
    const ctx = new Context();
    const sessions = new SessionStore(ctx);
    new SessionProjectionRegistry(ctx);
    const meter = new TokenMeter(ctx);
    const calls = [];
    const llm = {
        imageRequestPricing: () => undefined,
        fileRequestText: () => {
            throw new Error("unexpected attachment resolution in test");
        },
        resolveModelInfo: async () => ({
            context: { contextWindow: 131072 },
            defaultMaxTokens: 1024,
        }),
        async *stream(input) {
            calls.push(input);
            await options.onStream?.(input);
            yield { type: "block-start", index: 0, blockType: "text" };
            yield {
                type: "block-end",
                index: 0,
                block: {
                    type: "text",
                    text: options.summary ?? "Checkpoint: continue the requested work.",
                },
            };
            yield {
                type: "usage",
                usage: { inputTokens: 100, outputTokens: 8, cacheReadTokens: 20 },
            };
            yield { type: "finish", reason: { kind: options.finish ?? "stop" } };
        },
    };
    ctx.provide("llm", llm);
    new InvariantRegistry(ctx);
    await installCompactionInvariants(ctx);
    new SystemPrompt(ctx, {});
    new ToolRuntime(ctx);
    mountCompression(ctx, {
        compaction: { auto: false, headroomTokens: 0, maxTokens: 1024 },
        release: { protectRecentResults: options.protect ?? 0 },
    });
    const engine = ctx.compaction;
    const session = sessions.create();
    session.append("request/header", {
        header: { config: { provider: "test", model: "fixture", maxTokens: 1024 } },
        reason: "initial",
    });
    const agent = {
        session,
        options: { provider: "test", model: "fixture" },
        runMaintenance: (task) => task(new AbortController().signal),
    };
    let flushes = 0;
    ctx.on("session/flush", () => {
        flushes += 1;
    });
    const appendUser = (text) =>
        session.append(
            "user/message",
            createUserMessage({ content: [{ type: "text", text }], source: { kind: "user" } }),
            { surfaceOp: "append" },
        );
    let steps = 0;
    function toolRound(name, content, callId = `call-${session.seq}`) {
        const step = ++steps;
        session.append("step/start", { turn: 1, step });
        const assistant = createAssistantMessage({
            source: { provider: "test", model: "fixture" },
            content: [{ type: "tool-call", id: callId, name, arguments: "{}" }],
        });
        session.append(
            "assistant/message",
            { turn: 1, step, message: assistant, stream: [] },
            { surfaceOp: "append" },
        );
        session.append("tool/call", { turn: 1, step, callId, name, arguments: "{}" });
        const result = session.append(
            "tool/result",
            {
                turn: 1,
                step,
                message: createToolResultMessage({
                    callId,
                    content: [{ type: "text", text: content }],
                    isError: false,
                }),
            },
            { surfaceOp: "append" },
        );
        session.append("step/end", { turn: 1, step });
        return result;
    }
    async function invoke(name, args) {
        const step = ++steps;
        const callId = `control-${session.seq}`;
        session.append("step/start", { turn: 1, step });
        session.append(
            "assistant/message",
            {
                turn: 1,
                step,
                message: createAssistantMessage({
                    source: { provider: "test", model: "fixture" },
                    content: [
                        { type: "tool-call", id: callId, name, arguments: JSON.stringify(args) },
                    ],
                }),
                stream: [],
            },
            { surfaceOp: "append" },
        );
        session.append("tool/call", {
            turn: 1,
            step,
            callId,
            name,
            arguments: JSON.stringify(args),
        });
        const outcome = await ctx.tools.execute({
            name,
            arguments: args,
            callId,
            agent,
            signal: new AbortController().signal,
        });
        session.append(
            "tool/result",
            {
                turn: 1,
                step,
                message: createToolResultMessage({
                    callId,
                    content: outcome.content,
                    isError: outcome.isError,
                }),
                ...(outcome.meta === undefined ? {} : { meta: outcome.meta }),
            },
            { surfaceOp: "append" },
        );
        session.append("step/end", { turn: 1, step });
        return outcome;
    }
    const idFor = (event) => {
        const slot = engine
            .state(session)
            .numbering.slots.find((slot) => slot.sourceSeq === event.seq);
        if (slot === undefined) throw new Error("test event has no numbered binding");
        return slot.id;
    };
    return {
        ctx,
        engine,
        sessions,
        session,
        agent,
        meter,
        calls,
        llm,
        appendUser,
        toolRound,
        invoke,
        idFor,
        advanceSteps: (step) => {
            steps = Math.max(steps, step);
        },
        flushes: () => flushes,
        close: () => ctx.fiber.dispose(),
    };
}
