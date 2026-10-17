import { z } from "zod";
import type { Session, SessionSeq } from "@deepseek-ai/dsh-session";
import type { LedgerState } from "./ledger.js";
import type { ReleasePolicy } from "./planner.js";
import { selectedExclusions } from "./exclusion.js";
import { ALLOCATION_SOURCE } from "./numbering.js";
import { ID_PATTERN, displayId } from "./protocol.js";
import { pendingReleaseReason, hasInlinePlaceholder } from "./release.js";

const MAX_ROWS = 8;
const MAX_LOOKUP_NODES = 64;
const ledgerViewSchema = z.object({
    version: z.literal(1),
    rows: z
        .array(
            z.object({
                id: z.string().regex(ID_PATTERN),
                fingerprint: z.string().max(128),
            }),
        )
        .max(MAX_ROWS),
    summaryWatermark: z.number().int().nonnegative().safe().nullable(),
});

/** Only displayed semantic rows and the displayed summary survive in the notice. */
export type AdmissionLedgerView = z.infer<typeof ledgerViewSchema>;
export interface PreviousAdmissionLedger {
    seq: SessionSeq;
    view: AdmissionLedgerView;
}

/** Search the current surface tail, never the historical event log. */
export function previousAdmissionLedger(session: Session): PreviousAdmissionLedger | null {
    const nodes = session.surface.nodes;
    const start = Math.max(0, nodes.length - MAX_LOOKUP_NODES);
    for (let index = nodes.length - 1; index >= start; index -= 1) {
        const seq = nodes[index]!;
        const event = session.eventAt(seq);
        if (event?.type !== "user/message" || event.data.source.kind !== ALLOCATION_SOURCE)
            continue;
        const source: unknown = event.data.source;
        const parsed = ledgerViewSchema.safeParse(
            source !== null && typeof source === "object" && "ledgerView" in source
                ? source.ledgerView
                : undefined,
        );
        // An older notice must not masquerade as the latest delivered view.
        return parsed.success ? { seq, view: parsed.data } : null;
    }
    return null;
}

const pendingReason = pendingReleaseReason;

function boundedIds(ids: readonly string[], limit: number): string {
    const shown = ids.slice(-limit);
    return `${shown.join(", ") || "none"}${ids.length > shown.length ? ` (+${ids.length - shown.length} omitted)` : ""}`;
}

/** Pure admission preview. Core commits the returned view with the allocation notice. */
export function admissionLedger(
    state: LedgerState,
    policy: ReleasePolicy,
    previous: PreviousAdmissionLedger | null,
    declaredIds: readonly string[] = [],
): { text: string; view: AdmissionLedgerView; omitted: number } {
    const limit = Math.min(MAX_ROWS, policy.catalogLimit);
    const delivered = new Map(previous?.view.rows.map((row) => [row.id, row.fingerprint]) ?? []);
    const declared = new Set(declaredIds);
    const selectable = new Set(
        selectedExclusions(
            state,
            new Set(state.surface),
            Number.MAX_SAFE_INTEGER,
            "transcript",
        ).map((entry) => entry.id),
    );
    const covered = new Set(state.lastSummary?.ids ?? []);
    const latestRequestSeq = state.summaryRequests.at(-1)?.seq ?? -1;
    const candidates = state.entries.flatMap((entry, index) => {
        if (declared.has(entry.id)) return [];
        const pending = pendingReason(state, entry, selectable);
        const fingerprint = `${entry.status}:${pending ?? ""}`;
        const known = delivered.get(entry.id);
        if (known === fingerprint) return [];
        const changedAt = Math.max(
            entry.sourceSeq,
            entry.currentSeq ?? -1,
            entry.queuedAt ?? -1,
            covered.has(entry.id) || entry.status === "queued"
                ? (state.lastSummary?.seq ?? -1)
                : -1,
            entry.status === "queued" ? latestRequestSeq : -1,
        );
        const fresh = previous === null || changedAt > previous.seq;
        // Omitted historical rows stay discoverable on demand; eviction is not a new change.
        if (known === undefined && !fresh) return [];
        const priority = known !== undefined ? 0 : entry.status !== "available" ? 1 : 2;
        return [{ id: entry.id, fingerprint, status: entry.status, pending, priority, index }];
    });
    candidates.sort((left, right) => left.priority - right.priority || right.index - left.index);
    const shown = candidates.slice(0, limit);
    const omitted = candidates.length - shown.length;
    const rows = new Map(delivered);
    for (const row of shown) {
        rows.delete(row.id);
        rows.set(row.id, row.fingerprint);
    }
    const summaryWatermark = state.lastSummary?.seq ?? null;
    const parts: string[] = [];
    if (previous === null) parts.push("Release ledger bootstrap (bounded)");
    if (shown.length > 0)
        parts.push(
            shown
                .map(
                    (row) =>
                        `${displayId(row.id, hasInlinePlaceholder(state.entries.find((entry) => entry.id === row.id)))} ${row.status}${row.pending === null ? "" : ` (${row.pending})`}`,
                )
                .join("; "),
        );
    if (previous === null || previous.view.summaryWatermark !== summaryWatermark) {
        const summary = state.lastSummary;
        parts.push(
            summary === null
                ? "lastSummary: none"
                : `lastSummary: coverage ${boundedIds(summary.ids, limit)}; excluded ${boundedIds(summary.excludedIds, limit)}`,
        );
    }
    if (omitted > 0) parts.push(`${omitted} semantic rows omitted`);
    if (parts.length > 0)
        parts.push(
            "Use context_status for the full directory and pending reasons; context_expand/context_search recover originals",
        );
    return {
        text: parts.length === 0 ? "" : `\n${parts.join(". ")}.`,
        view: {
            version: 1,
            rows: [...rows].slice(-limit).map(([id, fingerprint]) => ({ id, fingerprint })),
            summaryWatermark,
        },
        omitted,
    };
}
