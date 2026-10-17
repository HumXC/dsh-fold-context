import type { Context } from "@deepseek-ai/cordis";
import { defineTool, type ToolRunContext } from "@deepseek-ai/dsh-tools";
import { z } from "zod";
import type { ContextCompressionEngine } from "./engine.js";
import { catalog, planRelease } from "../domain/planner.js";
import {
    COMPACT_TOOL,
    RECEIPT_KEY,
    RELEASE_TOOL,
    STATUS_TOOL,
    ID_INPUT_PATTERN,
    normalizeId,
} from "../domain/protocol.js";

const idsSchema = z
    .array(z.string().max(20).regex(ID_INPUT_PATTERN).transform(normalizeId))
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
                "Release consumed tool-result bodies or individual attachments without a summary. Returns queued/settled IDs; applied releases leave recoverable numbered placeholders. User and assistant conversation text is preserved.",
            parameters: {
                ids: {
                    type: "array",
                    items: { type: "string" },
                    required: true,
                    description:
                        "1–128 session IDs: §T9§ for a result body, §I10§ or §F11§ for one attachment. An R suffix before the closing delimiter means already released; both forms are accepted.",
                },
                reason: {
                    type: "string",
                    required: true,
                    description: "Why this content is no longer needed; 1–1000 characters.",
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
                const plan = planRelease(engine.state(agent.session), ids);
                return {
                    ...plan,
                    [RECEIPT_KEY]:
                        plan.accepted &&
                        plan.queued.some(
                            (id) =>
                                engine.state(agent.session).entries.find((entry) => entry.id === id)
                                    ?.status === "available",
                        )
                            ? {
                                  version: 6,
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
                "Queue a checkpoint request for a step boundary. Scheduling may wait for interval, savings and estimated payback; context_status reports the gate. A covering summary omits eligible marks, replaces the full historical prefix and retains the latest balanced tail.",
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
                const pending = engine.hasSummaryRequest(agent.session);
                return {
                    status: pending ? "already_queued" : "queued",
                    scope: "official balanced historical prefix; includes unmarked history; latest balanced tail retained",
                    [RECEIPT_KEY]: pending
                        ? null
                        : {
                              version: engine.schedulingPolicy.enabled ? 5 : 4,
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
                "Inspect numbered content, release states, summary coverage and receipts. Also reports the current read-only scheduling plan, estimated savings, preserved head, rebuild suffix, and wait/failure reason; query exact IDs or an owner ID for attachments.",
            parameters: {
                ids: {
                    type: "array",
                    items: { type: "string" },
                    description:
                        "Optional 1–128 session IDs; ordinary IDs and released R aliases are accepted.",
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
                const reminder = await engine.releaseReminder(agent, exec.signal);
                const view = catalog(
                    engine.state(agent.session),
                    engine.releasePolicy,
                    limit,
                    ids,
                    engine.summaryPolicy,
                );
                return {
                    scheduling: await engine.schedulingStatus(agent, exec.signal, limit),
                    reminders: {
                        ...reminder,
                        state: { ...reminder.state },
                        candidates: reminder.candidates.map((candidate) => ({ ...candidate })),
                        policy: { ...engine.reminderPolicy },
                    },
                    summaryPolicy: view.summaryPolicy,
                    attachments: view.attachments,
                    attachmentsOmitted: view.attachmentsOmitted,
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
