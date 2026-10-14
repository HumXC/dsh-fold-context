import test from "node:test";
import assert from "node:assert/strict";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { Session } from "@deepseek-ai/dsh-session";
import { fixture } from "./fixture.mjs";

test("legacy untyped declarations, receipts and released bodies replay into typed bindings", async (t) => {
    const f = await fixture();
    t.after(f.close);
    f.session.append("turn/start", { turn: 1 });
    const input = f.appendUser("Legacy user evidence. ".repeat(100));
    f.session.append(
        "user/message",
        createUserMessage({
            source: {
                kind: "fold-context-allocation",
                form: "notice",
                summary: "Legacy allocation",
                allocation: {
                    version: 1,
                    turn: 1,
                    step: 1,
                    inputs: [{ messageId: input.data.id, id: "§1§" }],
                    assistantId: "§2§",
                },
            },
            content: [{ type: "text", text: "Legacy next assistant is §2§." }],
        }),
        { surfaceOp: "append" },
    );
    const original = f.toolRound("read", "Legacy tool evidence. ".repeat(500));
    const id = f.idFor(original);
    assert.equal(id, "§T3§");
    await f.invoke("context_release", { ids: [id], reason: "Consumed" });
    // Historical releases replaced only tool results; keep this compatibility log explicit.
    f.session.append("compaction/prune", {
        shadowedRange: { start: original.seq, end: original.seq },
        shadowedSeqs: [original.seq],
        shadowedTokenCount: f.meter.estimateMessage(original.data.message),
    });
    f.session.append(
        "tool/result",
        {
            ...original.data,
            message: {
                ...original.data.message,
                content: [
                    {
                        type: "text",
                        text: `[Context ${id} released by model request; original retained in session log.]`,
                    },
                ],
            },
        },
        {
            surfaceOp: { op: "replace", startSeq: original.seq, endSeq: original.seq },
            sourceEventSeqs: [original.seq],
        },
    );
    const legacyLog = JSON.parse(
        JSON.stringify(f.session.snapshotEvents()).replace(/§[UAT]([1-9][0-9]*)§/g, "§$1§"),
    );
    const intent = legacyLog.find(
        (event) => event.type === "tool/result" && event.data.meta?.dshContextCompression,
    )?.data.meta.dshContextCompression;
    assert.ok(intent);
    intent.version = 2;
    assert.deepEqual(intent.ids, ["§3§"]);
    const restored = Session.create(f.session.id, legacyLog);
    const state = f.engine.state(restored);
    assert.equal(state.numbering.slots[1].id, "§A2§");
    assert.equal(state.numbering.slots[1].declared, true);
    const entry = state.entries.find((entry) => entry.id === id);
    assert.equal(entry.status, "released");
    assert.equal(entry.sourceSeq, original.seq);
    assert.deepEqual(
        restored.eventAt(original.seq).data.message.content,
        original.data.message.content,
    );
    assert.equal(state.numbering.nextNumber, f.engine.state(f.session).numbering.nextNumber);
});
