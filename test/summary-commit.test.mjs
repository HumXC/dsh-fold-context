import test from "node:test";
import assert from "node:assert/strict";
import { createAssistantMessage, createToolResultMessage } from "@deepseek-ai/dsh-llm";
import { fixture } from "./fixture.mjs";
import { recordLegacyRelease } from "./legacy-release-fixture.mjs";
import { ledgerProjection } from "../lib/domain/ledger.js";
import { selectedExclusions, summaryInput } from "../lib/domain/exclusion.js";
import { summaryRecords } from "./summary-records.mjs";

function parsed(outcome) {
    assert.equal(outcome.isError, false, JSON.stringify(outcome));
    return JSON.parse(outcome.content[0].text);
}
function folded(events) {
    return events.reduce(
        (state, event) => ledgerProjection.apply(state, event),
        ledgerProjection.init(),
    );
}

test("matching adjacent checkpoint settles version8 exclusions; subsequent end error does not roll back", async (t) => {
    const f = await fixture();
    t.after(f.close);
    f.session.append("turn/start", { turn: 1 });
    f.appendUser("Keep the task objective.");
    const original = f.toolRound("read", "Completed evidence. ".repeat(500));
    const id = f.idFor(original);
    parsed(await f.invoke("context_release", { ids: [Number(id)], reason: "redundant" }));
    parsed(await f.invoke("context_compact", { reason: "checkpoint" }));
    const nodes = f.session.surface.nodes;
    await f.engine.compactRegion(nodes[0], nodes.at(-1), f.agent);
    const events = f.session.snapshotEvents();
    const checkpointIndex = events.findIndex(
        (event) => event.type === "user/message" && event.data.source.kind === "compact-checkpoint",
    );
    const checkpoint = events[checkpointIndex];
    const summary = events[checkpointIndex - 1];
    const before = folded(events.slice(0, checkpointIndex));
    assert.equal(summary.type, "compaction/summary");
    assert.equal(before.entries.find((entry) => entry.id === id).status, "queued");
    assert.deepEqual(before.pendingSummary.excludedIds, [id]);
    assert.equal(before.lastSummary, null);
    const invalid = [
        { ...checkpoint, seq: checkpoint.seq + 1 },
        {
            ...checkpoint,
            data: {
                ...checkpoint.data,
                source: { ...checkpoint.data.source, compactionId: "different-transaction" },
            },
        },
        {
            ...checkpoint,
            sourceEventSeqs: checkpoint.sourceEventSeqs.filter((seq) => seq !== summary.seq),
        },
        {
            ...checkpoint,
            surfaceOp: { ...checkpoint.surfaceOp, endSeq: checkpoint.surfaceOp.startSeq },
        },
    ];
    for (const event of invalid) {
        const result = ledgerProjection.apply(before, event);
        assert.equal(
            result.entries.some((entry) => entry.status === "released"),
            false,
        );
        assert.equal(result.lastSummary, null);
        assert.equal(result.summaryRequests.at(-1).status, "queued");
    }
    const committed = ledgerProjection.apply(before, checkpoint);
    assert.equal(committed.entries.find((entry) => entry.id === id).status, "released");
    assert.equal(committed.summaryRequests.at(-1).status, "applied");
    const end = events.findLast((event) => event.type === "compaction/end");
    const failedAfterCommit = ledgerProjection.apply(committed, {
        ...end,
        data: { ...end.data, error: "flush failed after committed replacement" },
    });
    assert.equal(failedAfterCommit.entries.find((entry) => entry.id === id).status, "released");
    assert.equal(failedAfterCommit.summaryRequests.at(-1).status, "applied");
    assert.deepEqual(failedAfterCommit.lastSummary.excludedIds, [id]);
    const late = {
        ...before,
        entries: before.entries.map((entry) =>
            entry.id === id ? { ...entry, queuedAt: before.activeStart } : entry,
        ),
    };
    assert.deepEqual(selectedExclusions(late, new Set(before.surface), before.activeStart), []);
});

test("signed replay stays immutable while a modern tool exclusion ignores an obsolete assistant mark", async (t) => {
    const f = await fixture();
    t.after(f.close);
    f.session.append("turn/start", { turn: 1 });
    f.appendUser("Keep the task goal. ".repeat(200));
    f.session.append("step/start", { turn: 1, step: 1 });
    const message = createAssistantMessage({
        source: {
            provider: "test",
            model: "fixture",
            replayState: { response: { private: "opaque-signature" } },
        },
        content: [
            { type: "text", text: "Finished explanation. ".repeat(200) },
            { type: "reasoning", text: "Retained reasoning chain." },
            { type: "tool-call", id: "call", name: "read", arguments: "{}" },
        ],
    });
    const assistant = f.session.append(
        "assistant/message",
        { turn: 1, step: 1, message, stream: [] },
        { surfaceOp: "append" },
    );
    const call = f.session.append("tool/call", {
        turn: 1,
        step: 1,
        callId: "call",
        name: "read",
        arguments: "{}",
    });
    const result = f.session.append(
        "tool/result",
        {
            turn: 1,
            step: 1,
            message: createToolResultMessage({
                callId: "call",
                content: [{ type: "text", text: "Original output." }],
                isError: false,
            }),
        },
        { surfaceOp: "append", sourceEventSeqs: [call.seq] },
    );
    f.session.append("step/end", { turn: 1, step: 1 });
    f.advanceSteps(1);
    const ids = [f.idFor(assistant), f.idFor(result)];
    recordLegacyRelease(f, [ids[0]], "obsolete assistant mark");
    parsed(await f.invoke("context_release", { ids: [Number(ids[1])], reason: "consumed" }));
    const status = parsed(await f.invoke("context_status", { ids: ids.map(Number) }));
    assert.equal(status.entries.find((entry) => entry.id === ids[0]).status, "available");
    assert.equal(status.entries.find((entry) => entry.id === ids[0]).pendingReason, null);
    assert.equal(
        status.entries.find((entry) => entry.id === ids[1]).pendingReason,
        "awaiting_step_boundary",
    );
    assert.equal(
        status.numbers.some((slot) => "summaryShape" in slot),
        false,
    );
    const state = f.engine.state(f.session);
    assert.deepEqual(
        summaryInput(state, f.session.deriveMessages(), f.session.seq),
        f.session.deriveMessages(),
    );
    const nodes = f.session.surface.nodes;
    await f.engine.compactRegion(nodes[0], nodes.at(-1), f.agent);
    assert.equal(
        summaryRecords(f.calls[0].messages).some(
            (record) => record.text === message.content[1].text || record.callId === "call",
        ),
        false,
    );
    assert.equal(
        summaryRecords(f.calls[0].messages).some(
            (record) =>
                record.role === "user" && record.text === "Keep the task goal. ".repeat(200),
        ),
        true,
    );
    assert.deepEqual(f.engine.state(f.session).lastSummary.excludedIds, [ids[1]]);
    assert.equal(f.engine.state(f.session).lastSummary.projection.omittedReasoning[0].id, ids[0]);
    assert.equal(
        f.engine.state(f.session).entries.find((entry) => entry.id === ids[0]).status,
        "summarized",
    );
    assert.equal(
        f.engine.state(f.session).entries.find((entry) => entry.id === ids[1]).status,
        "released",
    );
    assert.ok(
        summaryRecords(f.calls[0].messages).some(
            (record) => record.text === message.content[0].text,
        ),
    );
    assert.equal(assistant.data.message.source.replayState.response.private, "opaque-signature");
    assert.deepEqual(assistant.data.message.content, message.content);
});
