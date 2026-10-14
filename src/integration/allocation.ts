import type { Context } from "@deepseek-ai/cordis";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import type { ContextCompressionEngine } from "./engine.js";
import { ALLOCATION_SOURCE, planAllocation } from "../domain/numbering.js";
import {
    admissionLedger,
    previousAdmissionLedger,
    type AdmissionLedgerView,
} from "../domain/admission-ledger.js";

declare module "../domain/numbering.js" {
    interface AllocationNoticeExtras {
        ledgerView?: AdmissionLedgerView;
    }
}

/** Append a declaration through the public, persistent step-admission channel. */
export function registerAllocation(ctx: Context, engine: ContextCompressionEngine): void {
    ctx.on("agent/pre-step", async ({ agent, messages, turn, step, signal }, next) => {
        const decision = await next();
        if (
            decision.kind !== "enter" ||
            (decision.messages.length === 0 && (step === 1 || messages.length > 0))
        )
            return decision;
        signal.throwIfAborted();
        const state = engine.state(agent.session);
        const allocation = planAllocation(state.numbering, decision.messages, turn, step);
        const ledger = admissionLedger(
            state,
            engine.releasePolicy,
            previousAdmissionLedger(agent.session),
            [
                ...allocation.inputs.map((input) => input.id),
                ...allocation.attachments.map((item) => item.id),
                allocation.assistantId,
            ],
        );
        const inputs = allocation.inputs.map((input) => input.id).join(", ");
        const declaration = createUserMessage({
            content: [
                {
                    type: "text",
                    text:
                        `Context numbering (this session): ${inputs ? `admitted inputs (in order) ${inputs}; ` : ""}` +
                        `the next assistant message is reserved as ${allocation.assistantId}. ` +
                        `Attachments: ${
                            allocation.attachments
                                .slice(0, 32)
                                .map(
                                    (item) =>
                                        `${item.id} in ${item.ownerId} block ${item.blockIndex}`,
                                )
                                .join(", ") || "none"
                        }${allocation.attachments.length > 32 ? ` (${allocation.attachments.length - 32} more; inspect context_status)` : ""}. ` +
                        "Do not print numbering prefixes. §U/§A/§T identify text and tool pairs; §I/§F identify individual image/file occurrences with the same shared ordinal." +
                        ledger.text,
                },
            ],
            source: {
                kind: ALLOCATION_SOURCE,
                form: "notice",
                summary: `Reserved ${allocation.assistantId} for the next assistant message`,
                allocation,
                ledgerView: ledger.view,
            },
        });
        return { ...decision, messages: [...decision.messages, declaration] };
    });
}
