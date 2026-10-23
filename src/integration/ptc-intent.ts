import type { Context } from "@deepseek-ai/cordis";
import { createDeveloperMessage, type ContextFormed } from "@deepseek-ai/dsh-llm";
import type { ContextCompressionEngine } from "./engine.js";
import { intentSchema } from "../domain/ledger.js";
import {
    COMPACT_TOOL,
    PTC_INTENT_SOURCE,
    RECEIPT_KEY,
    RELEASE_TOOL,
    type Intent,
} from "../domain/protocol.js";
import { z } from "zod";

declare module "@deepseek-ai/dsh-llm" {
    interface MessageSourceMap {
        "fold-context-ptc-intent": ContextFormed & {
            kind: typeof PTC_INTENT_SOURCE;
            callId: string;
            rootCallId: string;
            tool: string;
            intent: Intent;
        };
    }
}

/** Commit final structured PTC values before their rendered logs can be spilled. Empty native
 * developer records survive replay and fork, but derive to no model message. */
export function registerPtcIntents(ctx: Context, engine: ContextCompressionEngine) {
    const publicValue = z.object({ [RECEIPT_KEY]: intentSchema.omit({ reason: true }) });
    const argumentsSchema = z.object({ reason: z.string().trim().min(1).max(1000) });
    ctx.on("tools/result", (exec, result) => {
        if (
            exec.parent === undefined ||
            exec.agent === undefined ||
            result.isError ||
            (exec.name !== RELEASE_TOOL && exec.name !== COMPACT_TOOL)
        )
            return;
        // The SDK projects presentationMeta only for model-direct calls. Nested
        // notifications still expose the complete frozen value and dispatched args.
        const parsed = publicValue.safeParse(result.value);
        const args = argumentsSchema.safeParse(exec.arguments);
        if (!parsed.success || !args.success) return;
        const intent = { ...parsed.data[RECEIPT_KEY], reason: args.data.reason };
        if (
            intent.version !== 9 ||
            intent.sessionId !== exec.agent.session.id ||
            (intent.kind === "release") !== (exec.name === RELEASE_TOOL)
        )
            return;
        const step = engine.state(exec.agent.session).currentStep;
        if (step === null) return;
        exec.agent.session.append(
            "developer/message",
            {
                ...step,
                message: createDeveloperMessage({
                    content: [],
                    source: {
                        kind: PTC_INTENT_SOURCE,
                        callId: exec.callId,
                        rootCallId: exec.rootCallId,
                        tool: exec.name,
                        intent,
                    },
                }),
            },
            { surfaceOp: "append" },
        );
    });
}
