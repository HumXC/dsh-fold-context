import type { AllocationPlan } from "./numbering.js";

/** Rendering is presentation only; provenance always comes from the source metadata. */
export function allocationNoticeText(
    plan: AllocationPlan,
    candidates: readonly string[] = [],
): string {
    const lines: string[] = [];
    if (plan.announcedIds.length > 0) lines.push(`prev: ${plan.announcedIds.join(" ")}`);
    lines.push(`next: ${plan.assistantId}`);
    if (plan.attachments.length > 0) {
        lines.push("attachments:");
        for (const item of plan.attachments) {
            lines.push(`${item.id} ${item.ownerId} ${item.ordinal}`);
        }
    }
    if (candidates.length > 0) lines.push(`try_release: ${candidates.join(" ")}`);
    return lines.join("\n");
}
