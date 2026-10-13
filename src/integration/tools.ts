import type { Context } from "@deepseek-ai/cordis";
import { defineTool, type ToolRunContext } from "@deepseek-ai/dsh-tools";
import { z } from "zod";
import type { ContextCompressionEngine } from "./engine.js";
import { catalog, planRelease } from "../domain/planner.js";
import { COMPACT_TOOL, RECEIPT_KEY, RELEASE_TOOL, STATUS_TOOL } from "../domain/protocol.js";

const idsSchema = z
    .array(z.string().regex(/^§[1-9]\d*§$/))
    .min(1)
    .max(128);
function actor(exec: ToolRunContext) {
    if (exec.agent === undefined) throw new Error("fold-context tools require an owning agent");
    exec.signal.throwIfAborted();
    return exec.agent;
}
export function registerCompressionTools(ctx: Context, engine: ContextCompressionEngine) {
    ctx.tools.register(
        defineTool({
            name: RELEASE_TOOL,
            description:
                "Mark consumed tool-result bodies for release at the next step boundary. Returns queued/deferred/settled IDs; queued does not mean released. Originals remain in the session log.",
            parameters: {
                ids: {
                    type: "array",
                    items: { type: "string" },
                    required: true,
                    description:
                        "1–128 tool-result IDs such as §7§ from the current session ledger; user/assistant IDs cannot be released.",
                },
                reason: {
                    type: "string",
                    required: true,
                    description: "Why these results are no longer needed; 1–1000 characters.",
                },
            },
            output: {
                schema: { type: "json" },
                render: (_args, value) => [{ type: "text", text: JSON.stringify(value) }],
                presentationMeta: (_args, value) => value,
            },
            execute: async (args, exec) => {
                const agent = actor(exec);
                const ids = idsSchema.parse(args.ids);
                const reason = z.string().trim().min(1).max(1000).parse(args.reason);
                const plan = planRelease(
                    engine.state(agent.session),
                    ids,
                    engine.releasePolicy.protectRecentResults,
                );
                return {
                    ...plan,
                    [RECEIPT_KEY]:
                        plan.accepted && plan.queued.length > 0
                            ? {
                                  version: 2,
                                  kind: "release",
                                  sessionId: agent.session.id,
                                  ids: plan.queued,
                                  reason,
                              }
                            : null,
                };
            },
        }),
    );
    ctx.tools.register(
        defineTool({
            name: COMPACT_TOOL,
            description:
                "Queue official summarization for the next step boundary, even below the pressure threshold. Marked tool-result bodies are omitted first. Summarizes a balanced historical prefix, including unmarked history; retains the latest balanced tail. Returns queued, then inspect the ledger for applied/failed.",
            parameters: {
                reason: {
                    type: "string",
                    required: true,
                    description: "Why a checkpoint is useful now; 1–1000 characters.",
                },
            },
            output: {
                schema: { type: "json" },
                render: (_args, value) => [{ type: "text", text: JSON.stringify(value) }],
                presentationMeta: (_args, value) => value,
            },
            execute: async (args, exec) => {
                const agent = actor(exec);
                const reason = z.string().trim().min(1).max(1000).parse(args.reason);
                const pending = engine
                    .state(agent.session)
                    .summaryRequests.some((request) => request.status === "queued");
                return {
                    status: pending ? "already_queued" : "queued",
                    scope: "official balanced historical prefix; includes unmarked history; latest balanced tail retained",
                    [RECEIPT_KEY]: pending
                        ? null
                        : {
                              version: 2,
                              kind: "summary",
                              sessionId: agent.session.id,
                              ids: [],
                              reason,
                          },
                };
            },
        }),
    );
    ctx.tools.register(
        defineTool({
            name: STATUS_TOOL,
            description:
                "Inspect preallocated §N§ IDs and their reserved/bound/abandoned/summarized bindings, tool-result previews and release states, and the latest summary coverage. Use exact IDs to query omitted entries.",
            parameters: {
                ids: {
                    type: "array",
                    items: { type: "string" },
                    description: "Optional 1–128 exact IDs to inspect.",
                },
                limit: {
                    type: "integer",
                    description:
                        "Maximum returned entries, 1–128; defaults to the configured catalog limit.",
                },
            },
            output: {
                schema: { type: "json" },
                render: (_args, value) => [{ type: "text", text: JSON.stringify(value) }],
            },
            isConcurrencySafe: () => true,
            execute: async (args, exec) => {
                const agent = actor(exec);
                const ids = args.ids === undefined ? undefined : idsSchema.parse(args.ids);
                const limit =
                    args.limit === undefined
                        ? engine.releasePolicy.catalogLimit
                        : z.number().int().min(1).max(128).parse(args.limit);
                const view = catalog(engine.state(agent.session), engine.releasePolicy, limit, ids);
                return {
                    numbers: view.numbers.map((slot) => ({ ...slot })),
                    numbersOmitted: view.numbersOmitted,
                    nextNumber: view.nextNumber,
                    entries: view.entries.map((entry) => ({ ...entry })),
                    omitted: view.omitted,
                    summaryRequests: view.summaryRequests.map((request) => ({ ...request })),
                    lastSummary: view.lastSummary === null ? null : { ...view.lastSummary },
                };
            },
        }),
    );
}
