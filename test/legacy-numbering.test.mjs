import test from "node:test";
import assert from "node:assert/strict";
import { Session } from "@deepseek-ai/dsh-session";
import { allocationSchema, foldNumbering } from "../lib/domain/numbering.js";
import { intentSchema } from "../lib/domain/ledger.js";
import { fixture } from "./fixture.mjs";

test("obsolete allocation declarations are rejected without changing canonical bindings", async (t) => {
    const f = await fixture();
    t.after(f.close);
    const input = f.appendUser("Original user evidence.");
    const state = f.engine.state(f.session).numbering;
    const allocation = {
        version: 1,
        turn: 1,
        step: 1,
        inputs: [{ messageId: input.data.id, id: "1" }],
        announcedIds: ["1"],
        assistantId: "2",
        attachments: [],
    };
    assert.equal(allocationSchema.safeParse(allocation).success, true);
    for (const obsolete of [
        { ...allocation, version: 2 },
        { ...allocation, inputs: [{ messageId: input.data.id, id: "§U1§" }] },
        { ...allocation, assistantId: "§2§" },
        { ...allocation, announcedIds: ["§U1R§"] },
        { version: 1, turn: 1, step: 1, inputs: allocation.inputs, assistantId: "2" },
    ]) {
        assert.equal(allocationSchema.safeParse(obsolete).success, false);
        assert.throws(() =>
            foldNumbering(state, {
                type: "user/message",
                seq: f.session.seq,
                time: 0,
                surfaceOp: "append",
                data: {
                    role: "user",
                    id: "obsolete-notice",
                    content: [{ type: "text", text: "old declaration" }],
                    source: { kind: "fold-context-allocation", allocation: obsolete },
                },
            }),
        );
    }
    assert.deepEqual(
        state.slots.map((slot) => slot.id),
        ["1"],
    );
    assert.equal(state.nextNumber, 2);
});

test("obsolete release receipts and delimited aliases cannot queue replayed evidence", async (t) => {
    const f = await fixture();
    t.after(f.close);
    f.appendUser("Keep the objective.");
    const original = f.toolRound("read", "Original tool evidence. ".repeat(500));
    const id = f.idFor(original);
    assert.equal(id, "3");
    const outcome = await f.invoke("context_release", { ids: [Number(id)], reason: "Consumed" });
    assert.equal(outcome.isError, false);
    const events = f.session.snapshotEvents();
    const receipt = events.find(
        (event) => event.type === "tool/result" && event.data.meta?.dshContextCompression,
    );
    assert.equal(receipt.data.meta.dshContextCompression.version, 8);
    for (const obsolete of [
        ...[1, 2, 3, 4, 5, 6, 7].map((version) => ({ version, ids: [id] })),
        { version: 8, ids: ["§3§"] },
        { version: 8, ids: ["§T3§"] },
        { version: 8, ids: ["§T3R§"] },
    ]) {
        const intent = { ...receipt.data.meta.dshContextCompression, ...obsolete };
        assert.equal(intentSchema.safeParse(intent).success, false);
        const log = structuredClone(events);
        const event = log.find((candidate) => candidate.seq === receipt.seq);
        event.data.meta.dshContextCompression = intent;
        event.data.message.content = [
            { type: "text", text: JSON.stringify({ dshContextCompression: intent }) },
        ];
        const restored = Session.create(f.session.id, log);
        const entry = f.engine.state(restored).entries.find((entry) => entry.id === id);
        assert.equal(entry.status, "available");
        assert.equal(entry.reason, null);
        assert.deepEqual(
            restored.eventAt(original.seq).data.message.content,
            original.data.message.content,
        );
    }
});
