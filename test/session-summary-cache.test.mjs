import test from "node:test";
import assert from "node:assert/strict";
import { compactCheckpointSource } from "@deepseek-ai/dsh-compaction";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { Session, SessionLogOffset } from "@deepseek-ai/dsh-session";
import { fixture } from "./fixture.mjs";
import { ledgerProjection } from "../lib/domain/ledger.js";
import { freezeSummaryRange } from "../lib/domain/summary-range.js";
import { readSessionSummaryIdentity } from "../lib/domain/summary-policy.js";
import {
    SESSION_SUMMARY_SOURCE,
    sessionSummaryPlanSchema,
    sessionSummaryProjection,
} from "../lib/domain/session-summary.js";
import { sessionSummaryControlsProjection } from "../lib/domain/session-summary-controls.js";
import { withSessionCut } from "../lib/integration/session-cut.js";

const json = (value) => JSON.parse(JSON.stringify(value));
const SUMMARY_KEY = "contextSessionSummary";
const CONTROLS_KEY = "contextSessionSummaryControls";
const VALID_CHECKPOINT = "accepted-cache-checkpoint";
const COMPACTION_ID = "cache-identity-compaction";

// Historical v3 writers accepted a nonempty checkpoint containing only whitespace.
// Do not use the current writer to recreate a marker it intentionally rejects.
const historicalStamp = (checkpointId) =>
    `[fold-context-projection:3 ${JSON.stringify({
        reasoning: "preserve",
        images: "native",
        execution: "independent",
        compactionId: COMPACTION_ID,
        checkpointId,
    })}]`;

function replaceIdentity(value, from, to) {
    if (typeof value === "string") return value === from ? to : value;
    if (Array.isArray(value)) return value.map((item) => replaceIdentity(item, from, to));
    if (value !== null && typeof value === "object")
        return Object.fromEntries(
            Object.entries(value).map(([key, item]) => [key, replaceIdentity(item, from, to)]),
        );
    return value;
}

async function history(t, checkpointId) {
    const f = await fixture();
    t.after(f.close);
    const original = f.appendUser("Keep the historical user evidence in the archive.");
    const range = await withSessionCut(f.ctx, f.session, (cut) =>
        freezeSummaryRange(
            f.session,
            f.engine.state(f.session).numbering,
            { start: original.seq, end: original.seq },
            cut,
        ),
    );
    const plan = sessionSummaryPlanSchema.parse({
        checkpointId,
        range,
        provider: "test",
        model: "fixture",
        reasoningEffort: null,
        maxTokens: 1024,
        originalMaxTokens: 1024,
        originalReasoningEffort: null,
        originalAdapterDefaults: null,
        manual: true,
        sourceCommandId: null,
    });
    f.session.append(
        "user/message",
        createUserMessage({
            content: [{ type: "text", text: "Prepare the historical summary checkpoint." }],
            source: { kind: SESSION_SUMMARY_SOURCE, control: { phase: "request", plan } },
        }),
        { surfaceOp: "append" },
    );
    const start = f.session.append("compaction/start", {
        compactionId: COMPACTION_ID,
        turn: null,
    });
    const summary = [
        { type: "text", text: historicalStamp(checkpointId) },
        { type: "text", text: "Preserve the user objective and the completed evidence." },
    ];
    const completed = f.session.append("compaction/summary", {
        compactionId: COMPACTION_ID,
        summary,
        shadowedRange: { start: original.seq, end: original.seq },
        shadowedSeqs: [...range.seqs],
        shadowedTokenCount: f.meter.estimateMessage(original.data),
        provider: "test",
        model: "fixture",
    });
    const checkpoint = f.session.append(
        "user/message",
        createUserMessage({ content: summary, source: compactCheckpointSource(COMPACTION_ID) }),
        {
            surfaceOp: { op: "replace", startSeq: original.seq, endSeq: original.seq },
            sourceEventSeqs: [start.seq, ...range.seqs, completed.seq],
        },
    );
    f.session.append("compaction/end", { compactionId: COMPACTION_ID, turn: null });
    // Keep the observation cut exact: Session.create must not add a seed-boundary suffix.
    f.session.append("session/end-seed", {});
    const events = json(await withSessionCut(f.ctx, f.session, (cut) => [...cut.events.values()]));
    const registry = f.ctx.sessionProjections;
    const restore = (rows, log = events, baseSeq = SessionLogOffset(0)) =>
        registry.restore(rows, log, baseSeq, f.session.header, f.session.inheritedEventCount);
    const cold = restore({});
    const seeded = Session.create(f.session.id, json(events), f.session.header);
    assert.equal(seeded.seq, events.length);
    assert.deepEqual(seeded.surface.nodes, f.session.surface.nodes);
    assert.deepEqual(registry.checkpoint(seeded), cold.checkpoint);
    assert.deepEqual(cold.checkpoint[SUMMARY_KEY].val.committedCheckpoints, []);
    assert.equal(cold.checkpoint[SUMMARY_KEY].val.active.phase, "requested");
    assert.equal(cold.checkpoint[CONTROLS_KEY].val.owner, checkpointId);
    assert.equal(readSessionSummaryIdentity(summary[0].text, COMPACTION_ID), null);
    assert.deepEqual(completed.data.shadowedSeqs, range.seqs);
    assert.deepEqual(checkpoint.sourceEventSeqs, [start.seq, ...range.seqs, completed.seq]);

    // The same SDK-valid transaction with an accepted identity provides the old
    // consumers' exact committed/owner-cleared state without copying an old parser.
    const acceptedEvents = json(events);
    for (const event of acceptedEvents) {
        if (event.type === "user/message" && event.data.source.kind === SESSION_SUMMARY_SOURCE)
            event.data.source.control.plan.checkpointId = VALID_CHECKPOINT;
        if (event.type === "compaction/summary")
            event.data.summary[0].text = historicalStamp(VALID_CHECKPOINT);
        if (event.type === "user/message" && event.data.source.kind === "compact-checkpoint")
            event.data.content[0].text = historicalStamp(VALID_CHECKPOINT);
    }
    const accepted = Session.create(f.session.id, acceptedEvents, f.session.header);
    assert.equal(accepted.seq, acceptedEvents.length);
    assert.deepEqual(accepted.surface.nodes, seeded.surface.nodes);
    const acceptedRows = restore({}, acceptedEvents).checkpoint;
    assert.equal(acceptedRows[SUMMARY_KEY].val.active.phase, "committed");
    assert.deepEqual(acceptedRows[SUMMARY_KEY].val.committedCheckpoints, [VALID_CHECKPOINT]);
    assert.equal(acceptedRows[CONTROLS_KEY].val.owner, null);
    const legacy = json(cold.checkpoint);
    legacy.contextCompression.ver = 18;
    legacy[SUMMARY_KEY] = {
        ...acceptedRows[SUMMARY_KEY],
        ver: 5,
        val: replaceIdentity(acceptedRows[SUMMARY_KEY].val, VALID_CHECKPOINT, checkpointId),
    };
    legacy[CONTROLS_KEY] = {
        ...acceptedRows[CONTROLS_KEY],
        ver: 2,
        val: replaceIdentity(acceptedRows[CONTROLS_KEY].val, VALID_CHECKPOINT, checkpointId),
    };
    // These remain schema-valid; semantic version checks must discard them.
    sessionSummaryProjection.stateSchema.parse(legacy[SUMMARY_KEY].val);
    sessionSummaryControlsProjection.stateSchema.parse(legacy[CONTROLS_KEY].val);
    return { f, registry, events, cold, legacy, restore };
}

function recover(w, rows) {
    const floor = w.registry.restoreFloor(rows);
    assert.notEqual(floor, undefined);
    const tail = w.events.filter((event) => event.seq >= floor);
    const restored = w.restore(rows, tail, floor);
    const session = Session.create(w.f.session.id, json(w.events), w.f.session.header);
    const snapshot = w.registry.hydrate(session, rows, tail, floor);
    assert.deepEqual(snapshot, restored.snapshot);
    const checkpoint = w.registry.checkpoint(session);
    assert.deepEqual(checkpoint, restored.checkpoint);
    return { floor, checkpoint };
}

for (const checkpointId of [" ", "\t\n"]) {
    test(`summary identity caches refold legacy whitespace checkpoint ${JSON.stringify(checkpointId)}`, async (t) => {
        const w = await history(t, checkpointId);
        assert.equal(w.registry.restoreFloor(w.legacy), 0);
        const mixed = recover(w, w.legacy);
        assert.deepEqual(mixed.checkpoint, w.cold.checkpoint);
        assert.equal(mixed.checkpoint.contextCompression.ver, ledgerProjection.stateVersion);
        assert.equal(mixed.checkpoint[SUMMARY_KEY].ver, sessionSummaryProjection.stateVersion);
        assert.equal(
            mixed.checkpoint[CONTROLS_KEY].ver,
            sessionSummaryControlsProjection.stateVersion,
        );

        // Either dependent key must independently invalidate its older accepting state.
        for (const key of [SUMMARY_KEY, CONTROLS_KEY]) {
            const oneOldKey = json(w.cold.checkpoint);
            oneOldKey[key] = json(w.legacy[key]);
            const result = recover(w, oneOldKey);
            assert.equal(result.floor, 0, `${key} must require a full replay`);
            assert.deepEqual(result.checkpoint, w.cold.checkpoint);
        }

        // A full-log floor from ledger alone does not discard matching-version rows.
        // Relabel the schema-valid stale values to prove the two bumps are load-bearing.
        const matchingConsumers = json(w.legacy);
        matchingConsumers[SUMMARY_KEY].ver = sessionSummaryProjection.stateVersion;
        matchingConsumers[CONTROLS_KEY].ver = sessionSummaryControlsProjection.stateVersion;
        const reused = recover(w, matchingConsumers);
        assert.equal(reused.floor, 0);
        assert.equal(reused.checkpoint[SUMMARY_KEY].val.active.phase, "committed");
        assert.deepEqual(reused.checkpoint[SUMMARY_KEY].val.committedCheckpoints, [checkpointId]);
        assert.equal(reused.checkpoint[CONTROLS_KEY].val.owner, null);
        assert.notDeepEqual(reused.checkpoint[SUMMARY_KEY].val, w.cold.checkpoint[SUMMARY_KEY].val);
        assert.notDeepEqual(
            reused.checkpoint[CONTROLS_KEY].val,
            w.cold.checkpoint[CONTROLS_KEY].val,
        );
    });
}

test("current summary identity caches really restore from the checkpoint tail", async (t) => {
    const w = await history(t, " ");
    const restored = recover(w, w.cold.checkpoint);
    assert.ok(restored.floor > 0);
    assert.equal(restored.floor, w.events.at(-1).seq);
    assert.deepEqual(restored.checkpoint, w.cold.checkpoint);
});
