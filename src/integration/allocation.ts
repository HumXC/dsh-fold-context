import type { Context } from "@deepseek-ai/cordis";
import { createAllocationNotice } from "./message-labels.js";
import type { ContextCompressionEngine } from "./engine.js";
import { ALLOCATION_SOURCE, planAllocation } from "../domain/numbering.js";
import type { ReminderState } from "../domain/reminder.js";

declare module "../domain/numbering.js" {
    interface AllocationNoticeExtras {
        releaseReminderState?: ReminderState;
    }
}
/** One logged declaration follows the entire input batch; business messages stay untouched. */
export function registerAllocation(ctx: Context, engine: ContextCompressionEngine): void {
    const install = () =>
        ctx.on(
            "agent/pre-step",
            async ({ agent, messages, turn, step, signal }, next) => {
                const decision = await next();
                if (decision.kind !== "enter") return decision;
                const admitted = decision.messages.filter(
                    (message) => message.source.kind !== ALLOCATION_SOURCE,
                );
                if (admitted.length === 0 && (step === 1 || messages.length > 0))
                    return admitted.length === decision.messages.length
                        ? decision
                        : { ...decision, messages: admitted };
                signal.throwIfAborted();
                const reminder = await engine.releaseReminder(agent, signal);
                signal.throwIfAborted();
                const plan = planAllocation(
                    engine.state(agent.session).numbering,
                    admitted,
                    turn,
                    step,
                );
                const notice = createAllocationNotice(plan, reminder);
                return { ...decision, messages: [...admitted, notice] };
            },
            { prepend: true },
        );
    let dispose = install();
    ctx.on("internal/dispatch", (mode, name) => {
        if (mode !== "waterfall" || name !== "agent/pre-step") return;
        dispose();
        dispose = install();
    });
}
