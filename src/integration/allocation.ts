import type { Context } from "@deepseek-ai/cordis";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import type { ContextCompressionEngine } from "./engine.js";
import { ALLOCATION_SOURCE, planAllocation } from "../domain/numbering.js";

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
        const allocation = planAllocation(
            engine.state(agent.session).numbering,
            decision.messages,
            turn,
            step,
        );
        const inputs = allocation.inputs.map((input) => input.id).join(", ");
        const declaration = createUserMessage({
            content: [
                {
                    type: "text",
                    text:
                        `Context numbering (this session): ${inputs ? `admitted inputs (in order) ${inputs}; ` : ""}` +
                        `the next assistant message is reserved as ${allocation.assistantId}. ` +
                        "Do not print numbering prefixes. Only tool-result IDs in the release ledger are releasable.",
                },
            ],
            source: {
                kind: ALLOCATION_SOURCE,
                form: "notice",
                summary: `Reserved ${allocation.assistantId} for the next assistant message`,
                allocation,
            },
        });
        return { ...decision, messages: [...decision.messages, declaration] };
    });
}
