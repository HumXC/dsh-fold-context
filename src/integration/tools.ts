import type { Context } from "@deepseek-ai/cordis";
import { defineTool, type ToolRunContext } from "@deepseek-ai/dsh-tools";
import { z } from "zod";
import type { ContextCompressionEngine } from "./engine.js";
import { registerPtcIntents } from "./ptc-intent.js";
import { catalog, planRelease } from "../domain/planner.js";
import { optionalItems, optionalParameter } from "./tool-arguments.js";
import {
    COMPACT_TOOL,
    RECEIPT_KEY,
    RELEASE_TOOL,
    STATUS_TOOL,
    idArgumentSchema,
} from "../domain/protocol.js";

const idsSchema = z.array(idArgumentSchema).min(1).max(128);
function intentMetadata(args: unknown, value: unknown) {
    const result = z.record(z.string(), z.json()).parse(value);
    const receipt = result[RECEIPT_KEY];
    return {
        ...result,
        [RECEIPT_KEY]:
            receipt == null
                ? null
                : {
                      ...z.record(z.string(), z.json()).parse(receipt),
                      reason: z.object({ reason: z.string().trim().min(1).max(1000) }).parse(args)
                          .reason,
                  },
    };
}
function actor(exec: ToolRunContext, engine?: ContextCompressionEngine) {
    if (exec.agent === undefined) throw new Error("fold-context tools require an owning agent");
    exec.signal.throwIfAborted();
    if (
        engine !== undefined &&
        exec.parent !== undefined &&
        engine.state(exec.agent.session).currentStep === null
    )
        throw new Error("fold-context PTC tools require an open agent step");
    return exec.agent;
}
export function registerCompressionTools(ctx: Context, engine: ContextCompressionEngine) {
    registerPtcIntents(ctx, engine);
    ctx.tools.register(
        defineTool({
            name: RELEASE_TOOL,
            description:
                "Queue consumed tool-result bodies or individual attachments for batch release. Returns queued/settled IDs; applied releases leave recoverable placeholders.",
            parameters: {
                ids: {
                    type: "array",
                    items: { type: "integer" },
                    required: true,
                    description:
                        "1–128 positive safe-integer session numbers, for example [9, 10]. Use a tool-result number for its body or an attachment number for that occurrence.",
                },
                reason: {
                    type: "string",
                    required: true,
                    description:
                        "Why this content is no longer needed; 1–1000 characters after trimming.",
                },
            },
            output: {
                schema: { type: "json" },
                render: (_args, value) => [{ type: "text", text: JSON.stringify(value) }],
                presentationMeta: intentMetadata,
            },
            execute: async (args, exec) => {
                const agent = actor(exec, engine);
                const ids = idsSchema.parse(args.ids);
                z.string().trim().min(1).max(1000).parse(args.reason);
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
                                  version: exec.parent === undefined ? 8 : 9,
                                  kind: "release",
                                  sessionId: agent.session.id,
                                  ids: plan.queued,
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
                "Queue a checkpoint request for a safe step boundary. Timing depends on target window, relative cache cost and safety; context_status explains waiting. A covering summary absorbs eligible marks and retains a balanced recent tail.",
            parameters: {
                reason: {
                    type: "string",
                    required: true,
                    description:
                        "Why a checkpoint is useful now; 1–1000 characters after trimming.",
                },
            },
            output: {
                schema: { type: "json" },
                render: (_args, value) => [{ type: "text", text: JSON.stringify(value) }],
                presentationMeta: intentMetadata,
            },
            execute: async (args, exec) => {
                const agent = actor(exec, engine);
                z.string().trim().min(1).max(1000).parse(args.reason);
                const pending = engine.hasSummaryRequest(agent.session);
                return {
                    status: pending ? "already_queued" : "queued",
                    scope: "official balanced historical prefix; includes unmarked history; latest balanced tail retained",
                    [RECEIPT_KEY]: pending
                        ? null
                        : {
                              version: exec.parent === undefined ? 8 : 9,
                              kind: "summary",
                              sessionId: agent.session.id,
                              ids: [],
                          },
                };
            },
        }),
    );
    ctx.tools.register(
        defineTool({
            name: STATUS_TOOL,
            description:
                "Inspect numbered content, releases and summary coverage. Reports waiting reasons, target and safety windows, cost estimates, protected input and pressure verification. Query exact IDs or an owner ID for attachments.",
            parameters: {
                ids: optionalParameter(
                    { type: "array", items: { type: "integer" } },
                    "1–128 positive safe-integer session numbers; omit/null/[] inspects the bounded catalog.",
                ),
                limit: optionalParameter(
                    { type: "integer" },
                    "Maximum entries, 1–128; omit/null uses the configured catalog limit.",
                ),
            },
            output: {
                schema: { type: "json" },
                render: (_args, value) => [{ type: "text", text: JSON.stringify(value) }],
            },
            isConcurrencySafe: () => true,
            execute: async (args, exec) => {
                const agent = actor(exec);
                const requestedIds = optionalItems(args.ids);
                const ids = requestedIds === undefined ? undefined : idsSchema.parse(requestedIds);
                const limit = z
                    .number()
                    .int()
                    .min(1)
                    .max(128)
                    .parse(args.limit ?? engine.releasePolicy.catalogLimit);
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
                    summaryPreparation: engine.sessionSummaryStatus(agent.session),
                    lastSummary: view.lastSummary === null ? null : { ...view.lastSummary },
                };
            },
        }),
    );
}
