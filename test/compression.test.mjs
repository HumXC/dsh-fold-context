import test from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./fixture.mjs";
import { Session } from "@deepseek-ai/dsh-session";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { ledgerProjection } from "../lib/domain/ledger.js";
import { catalog, planRelease } from "../lib/domain/planner.js";
import { entryId } from "../lib/domain/protocol.js";
import { commitForcedReleases } from "./release-batch-fixture.mjs";

const longText = (label) => `${label} `.repeat(1500);
const signal = () => new AbortController().signal;

test("v8 queued release is applied before a manual checkpoint and remains replayable", async (t) => {
    const f = await fixture();
    t.after(f.close);
    const result = f.toolRound("read", longText("ORIGINAL"));
    f.appendUser("Keep the historical task objective in the summary.");
    f.appendUser(longText("CURRENT_TAIL"));
    const id = f.idFor(result);
    const receipt = (
        await f.invoke("context_release", { ids: [Number(id)], reason: "Consumed evidence" })
    ).meta;
    assert.equal(receipt.dshContextCompression.version, 8);
    assert.equal(f.engine.state(f.session).entries[0].status, "queued");
    const surface = [...f.session.surface.nodes];
    const messages = f.session.deriveMessages();
    const savedBeforeRelease = f.session.snapshotEvents();
    assert.ok(f.session.surface.nodes.includes(result.seq));
    assert.deepEqual(f.session.surface.nodes, surface);
    assert.deepEqual(f.session.deriveMessages(), messages);
    assert.equal(f.calls.length, 0);
    const before = f.meter.measure(f.session).totalTokens;
    const compact = await f.engine.compactNow(f.agent, signal());
    assert.ok(compact);
    assert.equal(f.engine.state(f.session).entries[0].status, "released");
    assert.equal(f.session.eventAt(result.seq).data.message.content[0].text, longText("ORIGINAL"));
    assert.ok(f.meter.measure(f.session).totalTokens < before);
    assert.equal(
        f.session.snapshotEvents().some((event) => event.type === "compaction/prune"),
        true,
    );
    assert.equal(
        f.calls[0].messages.some((message) => message.id === result.data.message.id),
        false,
    );
    assert.equal(
        f.calls[0].messages.some((message) =>
            message.content.some(
                (block) =>
                    block.type === "tool-call" && block.id === result.data.message.toolCallId,
            ),
        ),
        false,
    );
    const settled = await f.invoke("context_release", {
        ids: [Number(id)],
        reason: "Already consumed",
    });
    assert.deepEqual(settled.value.settled, [id]);
    // Snapshot before application still replays the queued intent without volatile plugin state.
    const replay = Session.create(f.session.id, savedBeforeRelease, f.session.header);
    assert.equal(f.engine.state(replay).entries[0].status, "queued");
});

test("queued IDs outside an explicit summary range remain live until a covering summary", async (t) => {
    const f = await fixture();
    t.after(f.close);
    f.session.append("turn/start", { turn: 1 });
    const first = f.toolRound("read", longText("FIRST"));
    const outside = f.toolRound("grep", longText("OUTSIDE"));
    const firstId = f.idFor(first);
    const outsideId = f.idFor(outside);
    await f.invoke("context_release", {
        ids: [Number(firstId), Number(outsideId)],
        reason: "Done",
    });
    const owner = f.engine
        .state(f.session)
        .numbering.slots.find((slot) => slot.id === firstId).reservationSeq;
    const compact = await f.engine.compactRegion(owner, first.seq, f.agent, signal());
    assert.ok(compact);
    const entries = f.engine.state(f.session).entries;
    assert.equal(entries.find((entry) => entry.id === firstId).status, "released");
    assert.equal(entries.find((entry) => entry.id === outsideId).status, "queued");
    assert.ok(f.session.surface.nodes.includes(outside.seq));
    assert.equal(f.session.eventAt(outside.seq).data.message.content[0].text, longText("OUTSIDE"));
    assert.deepEqual(f.engine.state(f.session).lastSummary.excludedIds, [firstId]);
    f.session.append("turn/end", { turn: 1, reason: { kind: "completed" } });
    assert.ok(await f.engine.compactNow(f.agent, signal()));
    assert.equal(
        f.engine.state(f.session).entries.find((entry) => entry.id === outsideId).status,
        "released",
    );
});

test("invalid ID rejects the complete plan without marking a valid subset", async (t) => {
    const f = await fixture();
    t.after(f.close);
    const result = f.toolRound("read", longText("KEEP"));
    const receipt = await f.invoke("context_release", {
        ids: [Number(f.idFor(result)), 999999],
        reason: "Done",
    });
    assert.equal(receipt.isError, false);
    assert.equal(receipt.value.accepted, false);
    assert.equal(f.engine.state(f.session).entries[0].status, "available");
    assert.equal(await f.engine.compactIfNeeded(f.agent, "pressure", signal()), null);
});

test("stable IDs survive official summaries and repeated provider call IDs", async (t) => {
    const f = await fixture();
    t.after(f.close);
    f.session.append("turn/start", { turn: 1 });
    const a = f.toolRound("read", longText("A"), "reused-call");
    const b = f.toolRound("grep", longText("B"), "reused-call");
    await f.invoke("context_release", { ids: [Number(f.idFor(a))], reason: "Done" });
    const owner = f.engine
        .state(f.session)
        .numbering.slots.find((slot) => slot.id === f.idFor(a)).reservationSeq;
    assert.ok(await f.engine.compactRegion(owner, a.seq, f.agent, signal()));
    const state = f.engine.state(f.session);
    assert.deepEqual(
        state.entries.map((entry) => entry.id),
        [f.idFor(a), f.idFor(b)],
    );
    assert.equal(state.entries[0].tool, "read");
    assert.equal(state.entries[1].tool, "grep");
    assert.equal(state.entries[1].status, "available");
    assert.equal(state.entries[0].status, "released");
    assert.equal(planRelease(state, [f.idFor(a)]).settled[0], f.idFor(a));
});

test("official manual summary filters marked bodies, retains pairing and exact official usage metadata", async (t) => {
    const f = await fixture();
    t.after(f.close);
    f.appendUser(longText("User goal must survive"));
    const result = f.toolRound("read", longText("DISCARD_ME"));
    f.toolRound("grep", longText("KEEP_ME"));
    await f.invoke("context_release", { ids: [Number(f.idFor(result))], reason: "Consumed" });
    f.appendUser("Latest tail");
    const compact = await f.engine.compactNow(f.agent, signal());
    assert.ok(compact);
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0].purpose, "compaction");
    assert.equal(
        f.calls[0].messages.some((message) =>
            message.content.some(
                (block) => block.type === "text" && block.text.includes("DISCARD_ME"),
            ),
        ),
        false,
    );
    assert.equal(
        f.calls[0].messages.some((message) =>
            message.content.some(
                (block) => block.type === "text" && block.text.includes("KEEP_ME"),
            ),
        ),
        true,
    );
    assert.equal(
        f.calls[0].messages.some((message) => message.id === result.data.message.id),
        false,
    );
    assert.equal(
        f.calls[0].messages.some((message) =>
            message.content.some(
                (block) =>
                    block.type === "tool-call" && block.id === result.data.message.toolCallId,
            ),
        ),
        false,
    );
    const summary = f.session.eventAt(compact.summarySeq);
    assert.equal(summary.data.llmStreamCall, true);
    assert.deepEqual(summary.data.usage, {
        inputTokens: 100,
        outputTokens: 8,
        cacheReadTokens: 20,
    });
    assert.equal(summary.data.rawOutput[0].text, "Checkpoint: continue the requested work.");
    assert.equal(f.session.eventAt(compact.startSeq).data.turn, null);
    assert.ok(f.flushes() >= 1, "the release batch and official summary are durably flushed");
    assert.equal(
        f.engine.state(f.session).entries.find((entry) => entry.sourceSeq === result.seq).status,
        "released",
    );
    assert.ok(f.engine.state(f.session).lastSummary.ids.includes(f.idFor(result)));
    assert.deepEqual(f.engine.state(f.session).lastSummary.excludedIds, [f.idFor(result)]);
    assert.equal(
        f.engine.state(f.session).entries.find((entry) => entry.tool === "grep").status,
        "summarized",
    );
    const index = f.session.snapshotEvents().findIndex((event) => event.seq === compact.summarySeq);
    assert.equal(f.session.snapshotEvents()[index + 1].surfaceOp.op, "replace");
});

test("explicit summary runs below pressure at the next boundary and records applied", async (t) => {
    const f = await fixture();
    t.after(f.close);
    f.session.append("turn/start", { turn: 1 });
    f.appendUser(longText("GOAL"));
    f.toolRound("read", longText("DETAIL"));
    await f.invoke("context_compact", { reason: "A milestone is complete" });
    assert.equal(f.calls.length, 0);
    assert.equal(f.engine.state(f.session).summaryRequests[0].status, "queued");
    const compact = await f.engine.compactIfNeeded(f.agent, "pressure", signal());
    assert.ok(compact);
    assert.equal(f.calls.length, 1);
    assert.equal(f.engine.state(f.session).summaryRequests[0].status, "applied");
    assert.equal(f.session.eventAt(compact.startSeq).data.turn, 1);
});

test("a failed summary retains settled releases and exact recovery evidence while closing its transaction", async (t) => {
    const f = await fixture({ finish: "max-tokens" });
    t.after(f.close);
    f.session.append("turn/start", { turn: 1 });
    f.appendUser(longText("GOAL"));
    const result = f.toolRound("read", longText("QUEUED_ON_FAILURE"));
    const id = f.idFor(result);
    await f.invoke("context_release", { ids: [Number(id)], reason: "Consumed" });
    await f.invoke("context_compact", { reason: "Checkpoint" });
    const before = [...f.session.surface.nodes];
    await assert.rejects(
        f.engine.compactIfNeeded(f.agent, "pressure", signal()),
        /summarization truncated at the token cap/,
    );
    assert.ok(before.includes(result.seq));
    assert.equal(f.session.surface.nodes.includes(result.seq), false);
    assert.ok(
        f.session.surface.nodes.includes(
            f.engine.state(f.session).entries.find((entry) => entry.id === id).currentSeq,
        ),
    );
    assert.equal(
        f.engine.state(f.session).entries.find((entry) => entry.id === id).status,
        "released",
    );
    assert.equal(
        f.session.eventAt(result.seq).data.message.content[0].text,
        longText("QUEUED_ON_FAILURE"),
    );
    assert.equal(f.engine.state(f.session).lastSummary, null);
    assert.equal(f.engine.state(f.session).summaryRequests[0].status, "failed");
    assert.equal(f.engine.state(f.session).activeStart, null);
    assert.ok(f.session.snapshotEvents().at(-1).data.error);
});

test("cancellation during summarization preserves the preceding release batch and exact originals", async (t) => {
    const controller = new AbortController();
    const f = await fixture({
        onStream: () => {
            controller.abort(new Error("isolated manual summary cancelled"));
            controller.signal.throwIfAborted();
        },
    });
    t.after(f.close);
    f.appendUser(longText("GOAL"));
    const result = f.toolRound("read", longText("QUEUED_ON_CANCEL"));
    const id = f.idFor(result);
    await f.invoke("context_release", { ids: [Number(id)], reason: "Consumed" });
    const before = [...f.session.surface.nodes];
    await assert.rejects(
        f.engine.compactNow(f.agent, controller.signal),
        /isolated manual summary cancelled/,
    );
    assert.ok(before.includes(result.seq));
    assert.equal(f.session.surface.nodes.includes(result.seq), false);
    assert.ok(
        f.session.surface.nodes.includes(
            f.engine.state(f.session).entries.find((entry) => entry.id === id).currentSeq,
        ),
    );
    assert.equal(
        f.engine.state(f.session).entries.find((entry) => entry.id === id).status,
        "released",
    );
    assert.equal(
        f.session.eventAt(result.seq).data.message.content[0].text,
        longText("QUEUED_ON_CANCEL"),
    );
    assert.equal(f.engine.state(f.session).lastSummary, null);
    assert.equal(f.engine.state(f.session).activeStart, null);
    assert.equal(
        f.session.snapshotEvents().some((event) => event.type === "compaction/prune"),
        true,
    );
});

test("sessions are isolated and status queries are bounded with targeted retrieval", async (t) => {
    const f = await fixture();
    t.after(f.close);
    const result = f.toolRound("read", longText("LOCAL"));
    f.toolRound("grep", longText("NEXT"));
    const unrelated = f.sessions.create();
    assert.deepEqual(f.engine.state(unrelated).entries, []);
    const small = await f.invoke("context_status", { limit: 1 });
    assert.equal(small.value.entries.length, 1);
    assert.equal(small.value.omitted, 1);
    const targeted = await f.invoke("context_status", { ids: [Number(f.idFor(result))] });
    assert.equal(targeted.value.entries[0].id, f.idFor(result));
    assert.equal(unrelated.seq, 0);
});

test("real PTC receipts queue v8 releases without turning sub-dispatches into model context IDs", async (t) => {
    let id;
    const f = await fixture({
        ptc: async (tools) => {
            await tools.context_release({ ids: [Number(id)], reason: "Done" });
            return {};
        },
    });
    t.after(f.close);
    f.appendUser(longText("PTC_GOAL"));
    const result = f.toolRound("run_code", longText("PROGRAM_OUTPUT"));
    id = f.idFor(result);
    const outcome = await f.invoke("run_code", {
        code: "deterministic isolated release",
        description: "Release consumed output",
    });
    assert.equal(outcome.isError, false);
    const dispatches = f.session
        .snapshotEvents()
        .filter((event) => event.type === "tool/ptc-dispatch");
    assert.equal(dispatches.length, 1);
    assert.deepEqual(dispatches[0].data.arguments, { ids: [Number(id)], reason: "Done" });
    assert.equal(
        f.engine
            .state(f.session)
            .numbering.slots.some((slot) => slot.callId === dispatches[0].data.subCallId),
        false,
    );
    assert.equal(
        f.engine.state(f.session).entries.some((entry) => entry.sourceSeq === dispatches[0].seq),
        false,
    );
    assert.equal(
        f.engine.state(f.session).entries.find((entry) => entry.id === id).status,
        "queued",
    );
    f.appendUser(longText("LATEST_PTC_TAIL"));
    assert.ok(await f.engine.compactNow(f.agent, signal()));
    assert.equal(
        f.engine.state(f.session).entries.find((entry) => entry.id === id).status,
        "released",
    );
    assert.equal(
        f.calls[0].messages.some((message) => message.id === result.data.message.id),
        false,
    );
});

test("ledger fold checkpoint is pure JSON and deterministic from the full event log", async (t) => {
    const f = await fixture();
    t.after(f.close);
    const result = f.toolRound("read", longText("LOG"));
    await f.invoke("context_release", { ids: [Number(f.idFor(result))], reason: "Done" });
    commitForcedReleases(f);
    let state = ledgerProjection.init(f.session.header, 0);
    for (const event of f.session.snapshotEvents()) state = ledgerProjection.apply(state, event);
    assert.deepEqual(state, f.engine.state(f.session));
    assert.deepEqual(JSON.parse(JSON.stringify(state)), state);
    assert.equal(ledgerProjection.stateSchema.safeParse(state).success, true);
});

test("the full plugin registers its tools and admits one plain notice with no runtime ledger", async (t) => {
    const f = await fixture();
    t.after(f.close);
    const result = f.toolRound("read", longText("DISCOVERABLE"));
    const assembly = await f.ctx.systemPrompt.assemble({ scope: f.agent });
    assert.deepEqual(assembly.tools.map((tool) => tool.name).sort(), [
        "context_compact",
        "context_expand",
        "context_release",
        "context_search",
        "context_status",
    ]);
    assert.ok(!assembly.contexts.some((context) => context.name === "fold-context:ledger"));
    const input = createUserMessage({
        source: { kind: "user" },
        content: [{ type: "text", text: "Continue." }],
    });
    const decision = await f.ctx.waterfall(
        "agent/pre-step",
        {
            agent: f.agent,
            messages: [input],
            turn: 1,
            step: 100,
            signal: signal(),
        },
        async () => ({ kind: "enter", messages: [input] }),
    );
    assert.equal(decision.messages.length, 2);
    assert.equal(decision.messages[0], input);
    const notice = decision.messages[1];
    assert.equal(notice.source.kind, "fold-context-allocation");
    assert.ok(notice.source.allocation.announcedIds.includes(f.idFor(result)));
    assert.match(notice.content[0].text, /^prev: [1-9]\d*(?: [1-9]\d*)*\nnext: [1-9]\d*/);
});

test("resume and fork seed boundaries abandon orphan summary locks and allow queued releases", async (t) => {
    const f = await fixture();
    t.after(f.close);
    const result = f.toolRound("read", longText("RECOVERABLE"));
    const id = f.idFor(result);
    await f.invoke("context_release", { ids: [Number(id)], reason: "Done" });
    await f.invoke("context_compact", { reason: "Checkpoint" });
    f.toolRound("read_unmarked", longText("UNMARKED_RESUME_EVIDENCE"));
    f.session.append("compaction/start", { compactionId: "interrupted", turn: null });
    assert.equal(f.engine.state(f.session).entries[0].status, "queued");
    const log = f.session.snapshotEvents();
    for (const header of [
        f.session.header,
        { ...f.session.header, id: "fork-session", isSeeded: true, parentSession: f.session.id },
    ]) {
        const recovered = Session.create(header.id, log, header, header.isSeeded ? log.length : 0);
        const restored = f.engine.state(recovered);
        assert.equal(restored.activeStart, null);
        assert.equal(restored.summaryRequests[0].status, "failed");
        assert.match(restored.summaryRequests[0].error, /interrupted/);
        assert.equal(f.engine.state(recovered).entries[0].status, "queued");
        // Official manual checkpoints require a session owned by the RAM store for flushes.
        const live = f.sessions.create(`live-${header.id}`, {
            seed: log,
            inheritedEventCount: header.isSeeded ? log.length : 0,
            meta: {
                isSeeded: header.isSeeded,
                ...(header.parentSession ? { parentSession: header.parentSession } : {}),
            },
        });
        assert.deepEqual(f.engine.state(live), restored);
        await f.engine.compactNow({ ...f.agent, session: live }, signal());
        assert.equal(f.engine.state(live).entries[0].status, "released");
    }
    assert.equal(f.engine.state(f.session).entries[0].status, "queued");
});

test("cancellation before a boundary preserves queued intent and never rewrites context", async (t) => {
    const f = await fixture();
    t.after(f.close);
    const result = f.toolRound("read", longText("CANCEL"));
    await f.invoke("context_release", { ids: [Number(f.idFor(result))], reason: "Done" });
    const before = f.session.seq;
    await assert.rejects(f.engine.compactIfNeeded(f.agent, "pressure", AbortSignal.abort()), {
        name: "AbortError",
    });
    assert.equal(f.session.seq, before);
    assert.equal(f.engine.state(f.session).entries[0].status, "queued");
});

test("an explicit tiny release still replaces its body with a bounded recoverable marker", async (t) => {
    const f = await fixture();
    t.after(f.close);
    const result = f.toolRound("read", "ok");
    await f.invoke("context_release", { ids: [Number(f.idFor(result))], reason: "Done" });
    const before = f.session.seq;
    assert.equal(commitForcedReleases(f), 1);
    assert.ok(f.session.seq > before);
    assert.equal(f.engine.state(f.session).entries[0].status, "released");
    const current = f.session
        .deriveMessages()
        .find((message) => message.id === result.data.message.id);
    assert.ok(current.content[0].text.length < 128);
    assert.equal(f.session.eventAt(result.seq).data.message.content[0].text, "ok");
    assert.equal(f.calls.length, 0);
});

test("large summary coverage stays bounded and exact IDs remain queryable", async (t) => {
    const f = await fixture();
    t.after(f.close);
    const ids = Array.from({ length: 5000 }, (_, index) => entryId(index + 1));
    const excludedIds = ids.slice(1000, 4000);
    const state = { ...f.engine.state(f.session), lastSummary: { seq: 6000, ids, excludedIds } };
    const policy = { catalogLimit: 32 };
    const bounded = catalog(state, policy, 1);
    assert.equal(bounded.lastSummary.ids.length, 1);
    assert.equal(bounded.lastSummary.total, 5000);
    assert.equal(bounded.lastSummary.omitted, 4999);
    assert.deepEqual(bounded.lastSummary.excludedIds, [excludedIds.at(-1)]);
    assert.equal(bounded.lastSummary.excludedTotal, 3000);
    assert.equal(bounded.lastSummary.excludedOmitted, 2999);
    assert.ok(JSON.stringify(bounded).length < 1000);
    const targeted = catalog(state, policy, 1, [ids[0]]);
    assert.deepEqual(targeted.lastSummary.ids, [ids[0]]);
    assert.deepEqual(targeted.lastSummary.excludedIds, []);
    const excluded = catalog(state, policy, 1, [excludedIds[0]]);
    assert.deepEqual(excluded.lastSummary.ids, [excludedIds[0]]);
    assert.deepEqual(excluded.lastSummary.excludedIds, [excludedIds[0]]);
    assert.ok(
        Number.isSafeInteger(ledgerProjection.stateVersion) && ledgerProjection.stateVersion > 0,
    );
});
