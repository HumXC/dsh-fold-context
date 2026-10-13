import test from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./fixture.mjs";
import { Session } from "@deepseek-ai/dsh-session";
import { ledgerProjection } from "../lib/domain/ledger.js";
import { catalog, planRelease } from "../lib/domain/planner.js";
import { entryId } from "../lib/domain/protocol.js";

const longText = (label) => `${label} `.repeat(1500);
const signal = () => new AbortController().signal;

test("numbered release is queued, durable, idempotent, and preserves tool pairing and original log", async (t) => {
    const f = await fixture();
    t.after(f.close);
    const result = f.toolRound("read", longText("ORIGINAL"));
    const id = f.idFor(result);
    const before = f.meter.measure(f.session).totalTokens;
    const receipt = await f.invoke("context_release", {
        ids: [id, id],
        reason: "Consumed evidence",
    });
    assert.equal(receipt.isError, false);
    assert.equal(f.engine.state(f.session).entries[0].status, "queued");
    assert.equal(f.session.surface.nodes.includes(result.seq), true);
    const savedBeforeRelease = f.session.snapshotEvents();
    assert.deepEqual(f.engine.flushReleases(f.agent), [id]);
    assert.equal(f.engine.state(f.session).entries[0].status, "released");
    assert.deepEqual(f.engine.flushReleases(f.agent), []);
    assert.equal(f.session.eventAt(result.seq).data.message.content[0].text, longText("ORIGINAL"));
    assert.ok(f.meter.measure(f.session).totalTokens < before);
    const events = f.session.snapshotEvents();
    const prune = events.findIndex((event) => event.type === "compaction/prune");
    assert.equal(events[prune + 1].surfaceOp.op, "replace");
    assert.deepEqual(events[prune + 1].sourceEventSeqs, [result.seq]);
    const messages = f.session.deriveMessages();
    assert.equal(
        messages.filter(
            (message) =>
                message.role === "tool" && message.toolCallId === result.data.message.toolCallId,
        ).length,
        1,
    );
    // Snapshot before application still replays the queued intent without volatile plugin state.
    const replay = Session.create(f.session.id, savedBeforeRelease, f.session.header);
    assert.equal(f.engine.state(replay).entries[0].status, "queued");
});

test("recent-window protection defers exact IDs and expires after newer results", async (t) => {
    const f = await fixture({ protect: 1 });
    t.after(f.close);
    const first = f.toolRound("read", longText("RECENT"));
    const id = f.idFor(first);
    await f.invoke("context_release", { ids: [id], reason: "Done" });
    assert.deepEqual(f.engine.flushReleases(f.agent), []);
    assert.equal(f.engine.state(f.session).entries[0].status, "queued");
    f.toolRound("grep", longText("NEWER"));
    assert.deepEqual(f.engine.flushReleases(f.agent), [id]);
});

test("invalid ID rejects the complete plan without marking a valid subset", async (t) => {
    const f = await fixture();
    t.after(f.close);
    const result = f.toolRound("read", longText("KEEP"));
    const receipt = await f.invoke("context_release", {
        ids: [f.idFor(result), "§999999§"],
        reason: "Done",
    });
    assert.equal(receipt.isError, false);
    assert.equal(receipt.value.accepted, false);
    assert.equal(f.engine.state(f.session).entries[0].status, "available");
    assert.deepEqual(f.engine.flushReleases(f.agent), []);
});

test("stable IDs survive release replacements and repeated provider call IDs", async (t) => {
    const f = await fixture();
    t.after(f.close);
    const a = f.toolRound("read", longText("A"), "reused-call");
    const b = f.toolRound("grep", longText("B"), "reused-call");
    await f.invoke("context_release", { ids: [f.idFor(a)], reason: "Done" });
    f.engine.flushReleases(f.agent);
    const state = f.engine.state(f.session);
    assert.deepEqual(
        state.entries.map((entry) => entry.id),
        [f.idFor(a), f.idFor(b)],
    );
    assert.equal(state.entries[0].tool, "read");
    assert.equal(state.entries[1].tool, "grep");
    assert.equal(state.entries[1].status, "available");
    assert.ok(state.surface.some((seq, index) => index > 0 && seq < state.surface[index - 1]));
    assert.equal(planRelease(state, [f.idFor(a)], 0).settled[0], f.idFor(a));
});

test("official manual summary filters marked bodies, retains pairing and exact official usage metadata", async (t) => {
    const f = await fixture({ protect: 99 });
    t.after(f.close);
    f.appendUser(longText("User goal must survive"));
    const result = f.toolRound("read", longText("DISCARD_ME"));
    f.toolRound("grep", longText("KEEP_ME"));
    await f.invoke("context_release", { ids: [f.idFor(result)], reason: "Consumed" });
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
    const filteredTool = f.calls[0].messages.find(
        (message) => message.id === result.data.message.id,
    );
    assert.equal(filteredTool.role, "tool");
    const summary = f.session.eventAt(compact.summarySeq);
    assert.equal(summary.data.llmStreamCall, true);
    assert.deepEqual(summary.data.usage, {
        inputTokens: 100,
        outputTokens: 8,
        cacheReadTokens: 20,
    });
    assert.equal(summary.data.rawOutput[0].text, "Checkpoint: continue the requested work.");
    assert.equal(f.session.eventAt(compact.startSeq).data.turn, null);
    assert.equal(f.flushes(), 1);
    assert.equal(
        f.engine.state(f.session).entries.find((entry) => entry.sourceSeq === result.seq).status,
        "summarized",
    );
    assert.ok(f.engine.state(f.session).lastSummary.ids.includes(f.idFor(result)));
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

test("failed official summary retains history, closes transaction, and reports failed", async (t) => {
    const f = await fixture({ finish: "max-tokens" });
    t.after(f.close);
    f.session.append("turn/start", { turn: 1 });
    f.appendUser(longText("GOAL"));
    await f.invoke("context_compact", { reason: "Checkpoint" });
    const before = [...f.session.surface.nodes];
    await assert.rejects(
        f.engine.compactIfNeeded(f.agent, "pressure", signal()),
        /summarization truncated at the token cap/,
    );
    assert.deepEqual(f.session.surface.nodes, before);
    assert.equal(f.engine.state(f.session).summaryRequests[0].status, "failed");
    assert.equal(f.engine.state(f.session).activeStart, null);
    assert.ok(f.session.snapshotEvents().at(-1).data.error);
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
    const targeted = await f.invoke("context_status", { ids: [f.idFor(result)] });
    assert.equal(targeted.value.entries[0].id, f.idFor(result));
    assert.equal(unrelated.seq, 0);
});

test("PTC durable control receipts queue releases; sub-dispatches themselves are not model context IDs", async (t) => {
    const f = await fixture();
    t.after(f.close);
    const result = f.toolRound("run_code", longText("PROGRAM_OUTPUT"));
    const id = f.idFor(result);
    f.session.append("tool/ptc-dispatch", {
        rootCallId: "outer",
        parentCallId: "outer",
        subCallId: "inner",
        name: "context_release",
        arguments: { ids: [id], reason: "Done" },
        isError: false,
        content: [
            {
                type: "text",
                text: JSON.stringify({
                    dshContextCompression: {
                        version: 2,
                        kind: "release",
                        sessionId: f.session.id,
                        ids: [id],
                        reason: "Done",
                    },
                }),
            },
        ],
    });
    assert.equal(f.engine.state(f.session).entries.length, 1);
    assert.deepEqual(f.engine.flushReleases(f.agent), [id]);
});

test("ledger fold checkpoint is pure JSON and deterministic from the full event log", async (t) => {
    const f = await fixture();
    t.after(f.close);
    const result = f.toolRound("read", longText("LOG"));
    await f.invoke("context_release", { ids: [f.idFor(result)], reason: "Done" });
    f.engine.flushReleases(f.agent);
    let state = ledgerProjection.init(f.session.header, 0);
    for (const event of f.session.snapshotEvents()) state = ledgerProjection.apply(state, event);
    assert.deepEqual(state, f.engine.state(f.session));
    assert.deepEqual(JSON.parse(JSON.stringify(state)), state);
    assert.equal(ledgerProjection.stateSchema.safeParse(state).success, true);
});

test("full plugin registers its model tools and injects the current session ledger at a boundary", async (t) => {
    const f = await fixture();
    t.after(f.close);
    const result = f.toolRound("read", longText("DISCOVERABLE"));
    await f.engine.compactIfNeeded(f.agent, "pressure", signal());
    const assembly = await f.ctx.systemPrompt.assemble({ scope: f.agent });
    assert.deepEqual(assembly.tools.map((tool) => tool.name).sort(), [
        "context_compact",
        "context_release",
        "context_status",
    ]);
    const ledger = assembly.contexts.find((context) => context.name === "fold-context:ledger");
    assert.ok(ledger.text.includes(f.idFor(result)));
    assert.ok(ledger.text.includes("available"));
    assert.equal(f.engine.runtimeContext({}), "");
});

test("resume and fork seed boundaries abandon orphan summary locks and allow queued releases", async (t) => {
    const f = await fixture();
    t.after(f.close);
    const result = f.toolRound("read", longText("RECOVERABLE"));
    const id = f.idFor(result);
    await f.invoke("context_release", { ids: [id], reason: "Done" });
    await f.invoke("context_compact", { reason: "Checkpoint" });
    f.session.append("compaction/start", { compactionId: "interrupted", turn: null });
    assert.deepEqual(f.engine.flushReleases(f.agent), []);
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
        assert.deepEqual(f.engine.flushReleases({ ...f.agent, session: recovered }), [id]);
        assert.equal(f.engine.state(recovered).entries[0].status, "released");
    }
    assert.equal(f.engine.state(f.session).entries[0].status, "queued");
});

test("cancellation before a boundary preserves queued intent and never rewrites context", async (t) => {
    const f = await fixture();
    t.after(f.close);
    const result = f.toolRound("read", longText("CANCEL"));
    await f.invoke("context_release", { ids: [f.idFor(result)], reason: "Done" });
    const before = f.session.seq;
    await assert.rejects(f.engine.compactIfNeeded(f.agent, "pressure", AbortSignal.abort()), {
        name: "AbortError",
    });
    assert.equal(f.session.seq, before);
    assert.equal(f.engine.state(f.session).entries[0].status, "queued");
});

test("a tiny marked result remains queued rather than growing its context body", async (t) => {
    const f = await fixture();
    t.after(f.close);
    const result = f.toolRound("read", "ok");
    await f.invoke("context_release", { ids: [f.idFor(result)], reason: "Done" });
    const before = f.session.seq;
    assert.deepEqual(f.engine.flushReleases(f.agent), []);
    assert.equal(f.session.seq, before);
    assert.equal(f.engine.state(f.session).entries[0].status, "queued");
});

test("large summary coverage stays bounded and exact IDs remain queryable", async (t) => {
    const f = await fixture();
    t.after(f.close);
    const ids = Array.from({ length: 5000 }, (_, index) => entryId(index + 1));
    const state = { ...f.engine.state(f.session), lastSummary: { seq: 6000, ids } };
    const policy = { protectRecentResults: 0, catalogLimit: 32 };
    const bounded = catalog(state, policy, 1);
    assert.equal(bounded.lastSummary.ids.length, 1);
    assert.equal(bounded.lastSummary.total, 5000);
    assert.equal(bounded.lastSummary.omitted, 4999);
    assert.ok(JSON.stringify(bounded).length < 1000);
    const targeted = catalog(state, policy, 1, [ids[0]]);
    assert.deepEqual(targeted.lastSummary.ids, [ids[0]]);
});
