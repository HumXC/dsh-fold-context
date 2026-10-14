import type { LedgerState } from "./ledger.js";
import { selectedExclusions } from "./exclusion.js";
import { resolveSummaryPolicy, type SummaryPolicy } from "./summary-policy.js";

export interface ReleasePolicy {
    catalogLimit: number;
}
export const DEFAULT_RELEASE_POLICY: Readonly<ReleasePolicy> = Object.freeze({ catalogLimit: 32 });
export function resolveReleasePolicy(config: Partial<ReleasePolicy> = {}): Readonly<ReleasePolicy> {
    const value = { ...DEFAULT_RELEASE_POLICY, ...config };
    if (
        !Number.isSafeInteger(value.catalogLimit) ||
        value.catalogLimit < 1 ||
        value.catalogLimit > 128
    )
        throw new Error("fold-context: invalid catalogLimit");
    return Object.freeze(value);
}
export function planRelease(state: LedgerState, ids: readonly string[]) {
    const entries = new Map(state.entries.map((entry) => [entry.id, entry]));
    const unique = [...new Set(ids)];
    const known = new Set([
        ...state.numbering.slots.map((slot) => slot.id),
        ...state.numbering.attachments.map((slot) => slot.id),
    ]);
    const unknown = unique.filter((id) => !known.has(id));
    const unsupported = unique.filter((id) => known.has(id) && !entries.has(id));
    if (unknown.length > 0 || unsupported.length > 0)
        return { accepted: false as const, unknown, unsupported, queued: [], settled: [] };
    return {
        accepted: true as const,
        unknown,
        unsupported,
        queued: unique.filter((id) => ["available", "queued"].includes(entries.get(id)!.status)),
        settled: unique.filter((id) =>
            ["released", "summarized"].includes(entries.get(id)!.status),
        ),
    };
}
export function catalog(
    state: LedgerState,
    policy: ReleasePolicy,
    limit = policy.catalogLimit,
    ids?: readonly string[],
    summaryPolicy: SummaryPolicy = resolveSummaryPolicy(),
) {
    const targets =
        ids === undefined ? state.entries : state.entries.filter((entry) => ids.includes(entry.id));
    const selectable = new Set(
        selectedExclusions(
            state,
            new Set(state.surface),
            Number.MAX_SAFE_INTEGER,
            "transcript",
        ).map((entry) => entry.id),
    );
    const entries = targets.slice(-limit).map((entry) => ({
        ...entry,
        pendingReason:
            entry.status !== "queued"
                ? null
                : !selectable.has(entry.id)
                  ? "protocol_protection"
                  : state.activeStart !== null
                    ? "summary_in_progress"
                    : state.lastSummary !== null &&
                        entry.queuedAt !== null &&
                        entry.queuedAt < state.lastSummary.seq
                      ? "outside_selection"
                      : state.summaryRequests.at(-1)?.status === "failed"
                        ? "summary_failed"
                        : "awaiting_covering_summary",
    }));
    const matching = (values: readonly string[]) =>
        values.filter((id) => ids === undefined || ids.includes(id));
    const summaryIds = matching(state.lastSummary?.ids ?? []).slice(-limit);
    const excludedIds = matching(state.lastSummary?.excludedIds ?? []).slice(-limit);
    const lastSummary =
        state.lastSummary === null
            ? null
            : {
                  seq: state.lastSummary.seq,
                  ids: summaryIds,
                  total: state.lastSummary.ids.length,
                  omitted: state.lastSummary.ids.length - summaryIds.length,
                  excludedIds,
                  excludedTotal: state.lastSummary.excludedIds.length,
                  excludedOmitted: state.lastSummary.excludedIds.length - excludedIds.length,
                  projection:
                      state.lastSummary.projection == null
                          ? null
                          : {
                                version: state.lastSummary.projection.version,
                                reasoning: state.lastSummary.projection.reasoning,
                                images: state.lastSummary.projection.images ?? null,
                                attachments: (state.lastSummary.projection.attachments ?? [])
                                    .filter(
                                        (item) =>
                                            ids === undefined ||
                                            ids.includes(item.id) ||
                                            ids.includes(item.ownerId),
                                    )
                                    .slice(-limit),
                                attachmentsTotal:
                                    state.lastSummary.projection.attachments?.length ?? 0,
                                attachmentsOmitted:
                                    (state.lastSummary.projection.attachments?.length ?? 0) -
                                    (state.lastSummary.projection.attachments
                                        ?.filter(
                                            (item) =>
                                                ids === undefined ||
                                                ids.includes(item.id) ||
                                                ids.includes(item.ownerId),
                                        )
                                        .slice(-limit).length ?? 0),
                                omittedReasoning: state.lastSummary.projection.omittedReasoning
                                    .filter((item) => ids === undefined || ids.includes(item.id))
                                    .slice(-limit),
                                omittedReasoningTotal:
                                    state.lastSummary.projection.omittedReasoning.length,
                                omittedReasoningOmitted:
                                    state.lastSummary.projection.omittedReasoning.length -
                                    state.lastSummary.projection.omittedReasoning
                                        .filter(
                                            (item) => ids === undefined || ids.includes(item.id),
                                        )
                                        .slice(-limit).length,
                                omittedReasoningCharacters:
                                    state.lastSummary.projection.omittedReasoning.reduce(
                                        (sum, item) => sum + item.characters,
                                        0,
                                    ),
                            },
              };
    const numbered =
        ids === undefined
            ? state.numbering.slots
            : state.numbering.slots.filter((slot) => ids.includes(slot.id));
    const releasable = new Set(state.entries.map((entry) => entry.id));
    const numbers = numbered.slice(-limit).map(({ summaryShape: _shape, ...slot }) => ({
        ...slot,
        releasable: releasable.has(slot.id),
    }));
    return {
        summaryPolicy,
        attachments: state.numbering.attachments
            .filter(
                (item) => ids === undefined || ids.includes(item.id) || ids.includes(item.ownerId),
            )
            .slice(-limit)
            .map(({ block, ...item }) => ({
                ...item,
                attachment: {
                    attachmentId: block.attachment.attachmentId,
                    name:
                        block.attachment.name === undefined
                            ? null
                            : Array.from(block.attachment.name).slice(0, 128).join(""),
                    bytes: block.attachment.bytes,
                    mediaType: block.type === "image" ? block.attachment.mediaType : null,
                    width: block.type === "image" ? block.attachment.width : null,
                    height: block.type === "image" ? block.attachment.height : null,
                },
                releaseStatus: state.entries.find((entry) => entry.id === item.id)?.status ?? null,
            })),
        attachmentsOmitted: Math.max(
            0,
            state.numbering.attachments.filter(
                (item) => ids === undefined || ids.includes(item.id) || ids.includes(item.ownerId),
            ).length - limit,
        ),
        numbers,
        numbersOmitted: Math.max(0, numbered.length - numbers.length),
        nextNumber: state.numbering.nextNumber,
        entries,
        omitted: Math.max(0, targets.length - entries.length),
        summaryRequests: state.summaryRequests.slice(-8),
        lastSummary,
    };
}
