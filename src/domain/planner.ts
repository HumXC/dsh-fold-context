import type { ContextEntry } from "./protocol.js";
import type { LedgerState } from "./ledger.js";

export interface ReleasePolicy {
    protectRecentResults: number;
    catalogLimit: number;
}
export const DEFAULT_RELEASE_POLICY: Readonly<ReleasePolicy> = Object.freeze({
    protectRecentResults: 2,
    catalogLimit: 32,
});
export function resolveReleasePolicy(config: Partial<ReleasePolicy> = {}): Readonly<ReleasePolicy> {
    const value = { ...DEFAULT_RELEASE_POLICY, ...config };
    for (const [key, number] of Object.entries(value)) {
        if (
            !Number.isSafeInteger(number) ||
            number < 0 ||
            (key === "catalogLimit" && (number < 1 || number > 128))
        ) {
            throw new Error(`fold-context: invalid ${key}`);
        }
    }
    return Object.freeze(value);
}
export function protectedIds(state: LedgerState, count: number): Set<string> {
    const bySeq = new Map(
        state.entries
            .filter((entry) => entry.currentSeq !== null && entry.status !== "released")
            .map((entry) => [entry.currentSeq, entry.id]),
    );
    const active = state.surface.flatMap((seq) => {
        const id = bySeq.get(seq);
        return id === undefined ? [] : [id];
    });
    return new Set(count === 0 ? [] : active.slice(-count));
}
export function planRelease(state: LedgerState, ids: readonly string[], count: number) {
    const entries = new Map(state.entries.map((entry) => [entry.id, entry]));
    const protectedSet = protectedIds(state, count);
    const unique = [...new Set(ids)];
    const known = new Set(state.numbering.slots.map((slot) => slot.id));
    const unknown = unique.filter((id) => !known.has(id));
    const unsupported = unique.filter((id) => known.has(id) && !entries.has(id));
    // Every target must be a releasable tool result; never apply a valid subset silently.
    if (unknown.length > 0 || unsupported.length > 0)
        return {
            accepted: false as const,
            unknown,
            unsupported,
            queued: [],
            deferred: [],
            settled: [],
        };
    return {
        accepted: true as const,
        unknown,
        unsupported,
        queued: unique.filter(
            (id) => entries.get(id)?.status === "available" || entries.get(id)?.status === "queued",
        ),
        deferred: unique.filter(
            (id) => protectedSet.has(id) && entries.get(id)?.status !== "released",
        ),
        settled: unique.filter((id) =>
            ["released", "summarized"].includes(entries.get(id)!.status),
        ),
    };
}
export function pendingRelease(state: LedgerState, count: number): ContextEntry[] {
    const protectedSet = protectedIds(state, count);
    return state.entries.filter(
        (entry) =>
            entry.status === "queued" && entry.currentSeq !== null && !protectedSet.has(entry.id),
    );
}
export function catalog(
    state: LedgerState,
    policy: ReleasePolicy,
    limit = policy.catalogLimit,
    ids?: readonly string[],
) {
    const targets =
        ids === undefined ? state.entries : state.entries.filter((entry) => ids.includes(entry.id));
    const protectedSet = protectedIds(state, policy.protectRecentResults);
    const entries = targets
        .slice(-limit)
        .map((entry) => ({ ...entry, protected: protectedSet.has(entry.id) }));
    const summaryIds =
        state.lastSummary?.ids
            .filter((id) => ids === undefined || ids.includes(id))
            .slice(-limit) ?? [];
    const lastSummary =
        state.lastSummary === null
            ? null
            : {
                  ...state.lastSummary,
                  ids: summaryIds,
                  total: state.lastSummary.ids.length,
                  omitted: state.lastSummary.ids.length - summaryIds.length,
              };
    const numbered =
        ids === undefined
            ? state.numbering.slots
            : state.numbering.slots.filter((slot) => ids.includes(slot.id));
    const numbers = numbered.slice(-limit).map((slot) => ({
        ...slot,
        releasable: state.entries.some((entry) => entry.id === slot.id),
    }));
    return {
        numbers,
        numbersOmitted: Math.max(0, numbered.length - numbers.length),
        nextNumber: state.numbering.nextNumber,
        entries,
        omitted: Math.max(0, targets.length - entries.length),
        summaryRequests: state.summaryRequests.slice(-8),
        lastSummary,
    };
}
