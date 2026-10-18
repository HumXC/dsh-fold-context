import { randomUUID } from "node:crypto";
import { lstat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { Context } from "@deepseek-ai/cordis";
import { SessionStore, SessionId } from "@deepseek-ai/dsh-session";
import { SessionProjectionRegistry } from "@deepseek-ai/dsh-session-projection";
import { AgentRegistry } from "@deepseek-ai/dsh-agent";
import { AgentLoop } from "@deepseek-ai/dsh-agent-loop";
import { SystemPrompt } from "@deepseek-ai/dsh-system-prompt";
import { ToolRuntime, defineTool } from "@deepseek-ai/dsh-tools";
import {
    LlmRuntime,
    LlmAdapter,
    createUserMessage,
    isAgentLoopRequest,
} from "@deepseek-ai/dsh-llm";
import { TokenMeter } from "@deepseek-ai/dsh-token-meter";
import { InvariantRegistry } from "@deepseek-ai/dsh-invariants";
import { apply as installCompactionInvariants } from "@deepseek-ai/dsh-compaction/invariant";
import JsonlSessionPersistence from "@deepseek-ai/dsh-session-persistence-jsonl";
import { apply as mountCompression } from "../lib/index.js";
import { LocalAttachmentStore } from "@deepseek-ai/dsh-attachment-local";
import { LocalFileSystem } from "@deepseek-ai/dsh-fs-local";
import { LocalSessionQuery } from "./query-fixture.mjs";
import { installPtcStub } from "./ptc-fixture.mjs";

/** Guard every filesystem test before any backend is constructed or directory removed. */
export async function assertTestRoot(root) {
    if (
        resolve(root) !== root ||
        dirname(root) !== resolve(tmpdir()) ||
        !/^fold-context-test-[A-Za-z0-9]+$/.test(basename(root))
    )
        throw new Error("refusing a non-test persistence root");
    const stat = await lstat(root);
    if (!stat.isDirectory() || stat.isSymbolicLink())
        throw new Error("refusing a non-directory test root");
}

/** Full public AgentLoop and real LLM runtime; the only adapter is deterministic and local. */
export async function loopFixture(root, options = {}) {
    await assertTestRoot(root);
    const ctx = new Context();
    const handles = [];
    const requests = [];
    const summaries = [];
    const responses = [...(options.responses ?? [])];
    const sessions = new SessionStore(ctx);
    new SessionProjectionRegistry(ctx);
    new AgentRegistry(ctx);
    new SystemPrompt(ctx, {});
    if (options.ptc !== undefined) installPtcStub(ctx, options.ptc);
    new ToolRuntime(ctx, options.ptc === undefined ? {} : { mode: "both" });
    new InvariantRegistry(ctx);
    if (options.strictSession)
        await (await import("@deepseek-ai/dsh-session/invariant")).apply(ctx);
    await installCompactionInvariants(ctx);
    const query = new LocalSessionQuery(ctx);
    if (options.attachments) {
        new LocalAttachmentStore(ctx, { dshHome: root });
        new LocalFileSystem(ctx, { cwd: root, diffBasisMaxBytes: 10 * 1024 * 1024 });
        const mapper = ctx.fs.processPathFromHostPath.bind(ctx.fs);
        ctx.fs.processPathFromHostPath = (path) => {
            if (!resolve(path).startsWith(`${root}/`))
                throw new Error("attachment fixture path escaped test root");
            return mapper(path);
        };
    }
    const originalCalls = [];
    ctx.on("llm/stream", (request, next) => {
        originalCalls.push({ request, ordinary: isAgentLoopRequest(request) });
        return next();
    });
    const llm = new LlmRuntime(ctx);
    let world;
    class LocalAdapter extends LlmAdapter {
        async resolveModel(provider, model, signal) {
            signal?.throwIfAborted();
            return {
                provider,
                id: model,
                name: "Isolated local mock",
                context: { contextWindow: options.contextWindow ?? 131072 },
                ...(options.inputModalities === undefined
                    ? {}
                    : { inputModalities: options.inputModalities }),
                defaultMaxTokens: 128,
            };
        }
        async *stream(request) {
            request.signal?.throwIfAborted();
            const ordinary = request.purpose !== "compaction";
            (ordinary ? requests : summaries).push(request);
            let response = ordinary ? responses.shift() : undefined;
            if (typeof response === "function") response = await response(request, world);
            await options.onStream?.(request, world, ordinary);
            request.signal?.throwIfAborted();
            if (!ordinary && options.failSummary) throw new Error("isolated summary failure");
            const blocks = response?.blocks ?? [
                {
                    type: "text",
                    text: ordinary
                        ? "Completed isolated work."
                        : "Checkpoint: preserve the user objective and original evidence IDs.",
                },
            ];
            for (let index = 0; index < blocks.length; index += 1) {
                const block = blocks[index];
                yield { type: "block-start", index, blockType: block.type };
                yield { type: "block-end", index, block };
            }
            yield {
                type: "usage",
                usage: { inputTokens: 100, outputTokens: 8, cacheReadTokens: 20 },
            };
            yield {
                type: "finish",
                reason: {
                    kind:
                        response?.finish ??
                        (blocks.some((block) => block.type === "tool-call")
                            ? "tool-calls"
                            : "stop"),
                },
            };
        }
    }
    llm.registerAdapter(["test"], new LocalAdapter());
    new TokenMeter(ctx);
    const persistence = new JsonlSessionPersistence(ctx, {
        root: join(root, "sessions"),
        compression: "none",
    });
    mountCompression(ctx, {
        compaction: {
            auto: options.auto ?? false,
            headroomTokens: 0,
            maxTokens: 128,
            retainTokens: 512,
            thresholdRatio: 0.5,
            compactionRetries: 0,
            ...options.compaction,
        },
        summary: { reasoning: options.reasoning ?? "omit-from-summary" },
        release: { catalogLimit: 32 },
        scheduling: options.scheduling ?? {},
    });
    for (const [name, execute] of Object.entries(options.tools ?? {}))
        ctx.tools.register(
            defineTool({
                name,
                description: "Isolated test tool",
                parameters: {},
                output: {
                    schema: { type: "json" },
                    render: (_args, value) => [
                        {
                            type: "text",
                            text: typeof value === "string" ? value : JSON.stringify(value),
                        },
                    ],
                },
                execute: async (args, exec) => execute(args, exec, world),
            }),
        );
    new AgentLoop(ctx, { agents: [], maxParallelToolCalls: { get: () => 1 } });
    const agentOptions = { provider: "test", model: "mock", maxTokens: 128 };
    world = {
        ctx,
        sessions,
        query,
        persistence,
        engine: ctx.compaction,
        originalCalls,
        attachments: ctx.get("attachments"),
        requests,
        summaries,
        root,
        create: async (extra = {}) => {
            const handle = await ctx.agents.create({
                sessionId: SessionId(randomUUID()),
                meta: { cwd: root },
                agentOptions,
                ...extra,
            });
            handles.push(handle);
            return handle;
        },
        resume: async (sessionId) => {
            const handle = await ctx.agents.resume({ resumeSessionId: sessionId, agentOptions });
            handles.push(handle);
            return handle;
        },
        followup: async (handle, text) => {
            handle.agent.followup(
                createUserMessage({
                    source: { kind: "user" },
                    content: Array.isArray(text) ? text : [{ type: "text", text }],
                }),
            );
            await handle.agent.whenIdle();
            const lastEnd = handle.agent.session
                .snapshotEvents()
                .findLast((event) => event.type === "turn/end");
            if (lastEnd?.data.reason.kind !== "completed")
                throw new Error(
                    `isolated turn did not complete: ${JSON.stringify(lastEnd?.data.reason)}`,
                );
        },
        flush: async (handle) => {
            await ctx.sessions.flush(handle.agent.session);
            await persistence.flush();
        },
        close: async () => {
            try {
                for (const handle of handles) await handle.dispose();
            } finally {
                await ctx.fiber.dispose();
            }
        },
    };
    return world;
}

export function call(name, args = {}, id = randomUUID()) {
    return { blocks: [{ type: "tool-call", id, name, arguments: JSON.stringify(args) }] };
}
