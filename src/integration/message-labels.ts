import { createUserMessage, type UserMessage } from "@deepseek-ai/dsh-llm";
import { ALLOCATION_SOURCE, type AllocationPlan } from "../domain/numbering.js";
import { allocationNoticeText } from "../domain/allocation-notice.js";
import type { ReleaseReminderPlan } from "../domain/reminder.js";

/** Native construction keeps producer metadata separate from the rendered declaration. */
export function createAllocationNotice(
    plan: AllocationPlan,
    reminder: ReleaseReminderPlan,
): UserMessage {
    return createUserMessage({
        content: [
            {
                type: "text",
                text: allocationNoticeText(
                    plan,
                    reminder.decision === "remind"
                        ? reminder.candidates.map((item) => item.id)
                        : [],
                ),
            },
        ],
        source: {
            kind: ALLOCATION_SOURCE,
            form: "notice",
            summary: "Context allocation",
            allocation: plan,
            releaseReminderState: reminder.state,
        },
    });
}
