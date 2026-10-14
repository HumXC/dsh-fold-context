import test from "node:test";
import assert from "node:assert/strict";
import { createAssistantMessage, createToolResultMessage } from "@deepseek-ai/dsh-llm";
import { fixture } from "./fixture.mjs";
import { ledgerProjection } from "../lib/domain/ledger.js";
import { selectedExclusions, summaryInput } from "../lib/domain/exclusion.js";
import { summaryRecords } from "./summary-records.mjs";

function parsed(outcome) {
    assert.equal(outcome.isError, false, JSON.stringify(outcome));
    return JSON.parse(outcome.content[0].text);
}

async function compactSurface(f) {
    const nodes = f.session.surface.nodes;
    return f.engine.compactRegion(nodes[0], nodes.at(-1), f.agent);
}

test("ambiguous call IDs within one assistant preserve both calls and results", async (t) => {
    const f = await fixture();
    t.after(f.close);
    f.session.append("turn/start", { turn: 1 });
    f.appendUser("Earlier evidence suitable for consolidation. ".repeat(200));
    f.session.append("step/start", { turn: 1, step: 1 });
    const message = createAssistantMessage({
        source: { provider: "test", model: "fixture" },
        content: [
            { type: "tool-call", id: "reused", name: "read", arguments: '{"path":"one"}' },
            { type: "tool-call", id: "reused", name: "grep", arguments: '{"query":"two"}' },
        ],
    });
    f.session.append(
        "assistant/message",
        { turn: 1, step: 1, message, stream: [] },
        { surfaceOp: "append" },
    );
    for (const block of message.content) {
        const call = f.session.append("tool/call", {
            turn: 1,
            step: 1,
            callId: block.id,
            name: block.name,
            arguments: block.arguments,
        });
        f.session.append(
            "tool/result",
            {
                turn: 1,
                step: 1,
                message: createToolResultMessage({
                    callId: block.id,
                    content: [{ type: "text", text: block.name + " evidence" }],
                    isError: false,
                }),
            },
            { surfaceOp: "append", sourceEventSeqs: [call.seq] },
        );
    }
    f.session.append("step/end", { turn: 1, step: 1 });
    f.advanceSteps(1);
    const tools = f.engine.state(f.session).entries.filter((entry) => entry.role === "tool");
    assert.equal(tools.length, 2);
    parsed(
        await f.invoke("context_release", { ids: [tools[0].id], reason: "consumed first call" }),
    );
    const state = f.engine.state(f.session);
    assert.deepEqual(selectedExclusions(state, new Set(state.surface), f.session.seq), []);
    const messages = f.session.deriveMessages();
    assert.deepEqual(summaryInput(state, messages, f.session.seq), messages);
    const status = parsed(await f.invoke("context_status", { ids: [tools[0].id] }));
    assert.equal(status.entries[0].pendingReason, "protocol_protection");
    await compactSurface(f);
    const supplied = summaryRecords(f.calls[0].messages);
    assert.equal(
        supplied.filter((record) => record.type === "tool-call" && record.callId === "reused")
            .length,
        2,
    );
    assert.equal(
        supplied.filter((record) => record.role === "tool" && record.callId === "reused").length,
        2,
    );
    assert.equal(
        supplied
            .filter((record) => record.type === "tool-call" && record.callId === "reused")
            .every((record) => record.id === null),
        true,
    );
    assert.deepEqual(f.engine.state(f.session).lastSummary.excludedIds, []);
    assert.equal(
        f.engine.state(f.session).entries.find((entry) => entry.id === tools[0].id).status,
        "summarized",
    );
});

test("a same-identity replacement removing user text cannot produce a false exclusion receipt", async (t) => {
    const f = await fixture();
    t.after(f.close);
    f.session.append("turn/start", { turn: 1 });
    const original = f.appendUser("Text originally marked for exclusion. ".repeat(200));
    const id = f.idFor(original);
    parsed(await f.invoke("context_release", { ids: [id], reason: "consumed text" }));
    const replacement = f.session.append(
        "user/message",
        {
            ...original.data,
            content: [
                { type: "reasoning", text: "Preserved structured content without ordinary text." },
            ],
        },
        {
            surfaceOp: { op: "replace", startSeq: original.seq, endSeq: original.seq },
            sourceEventSeqs: [original.seq],
        },
    );
    f.appendUser("Independent earlier context to consolidate. ".repeat(200));
    const state = f.engine.state(f.session);
    assert.equal(state.numbering.slots.find((slot) => slot.id === id).currentSeq, replacement.seq);
    assert.deepEqual(selectedExclusions(state, new Set(state.surface), f.session.seq), []);
    const messages = f.session.deriveMessages();
    assert.deepEqual(summaryInput(state, messages, f.session.seq), messages);
    const status = parsed(await f.invoke("context_status", { ids: [id] }));
    assert.equal(status.entries[0].pendingReason, "protocol_protection");
    await compactSurface(f);
    assert.deepEqual(
        summaryRecords(f.calls[0].messages)
            .filter((record) => record.id === id)
            .map(({ type, text }) => ({ type, text })),
        replacement.data.content,
    );
    assert.deepEqual(f.engine.state(f.session).lastSummary.excludedIds, []);
    assert.equal(
        f.engine.state(f.session).entries.find((entry) => entry.id === id).status,
        "summarized",
    );
    const replayed = f.session
        .snapshotEvents()
        .reduce((fold, event) => ledgerProjection.apply(fold, event), ledgerProjection.init());
    assert.deepEqual(replayed, f.engine.state(f.session));
});

test("a foreign compaction end cannot clear pending proof in a pure replay fold", async (t) => {
    const f = await fixture();
    t.after(f.close);
    f.session.append("turn/start", { turn: 1 });
    const original = f.appendUser("Completed evidence. ".repeat(200));
    const id = f.idFor(original);
    parsed(await f.invoke("context_release", { ids: [id], reason: "consumed" }));
    await compactSurface(f);
    const events = f.session.snapshotEvents();
    const checkpointIndex = events.findIndex(
        (event) => event.type === "user/message" && event.data.source.kind === "compact-checkpoint",
    );
    const before = events
        .slice(0, checkpointIndex)
        .reduce((state, event) => ledgerProjection.apply(state, event), ledgerProjection.init());
    assert.notEqual(before.pendingSummary, null);
    const ignored = ledgerProjection.apply(before, {
        type: "compaction/end",
        seq: events[checkpointIndex].seq,
        time: 0,
        data: { compactionId: "foreign-transaction", turn: 1, error: "unrelated failure" },
    });
    assert.equal(ignored, before);
    const after = ledgerProjection.apply(ignored, events[checkpointIndex]);
    assert.equal(after.entries.find((entry) => entry.id === id).status, "released");
    assert.deepEqual(after.lastSummary.excludedIds, [id]);
});
