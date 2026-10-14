import test from "node:test";
import assert from "node:assert/strict";
import { createUserMessage, createAssistantMessage } from "@deepseek-ai/dsh-llm";
import { planAllocation, ALLOCATION_SOURCE } from "../lib/domain/numbering.js";
import { ledgerProjection } from "../lib/domain/ledger.js";
import { planRelease } from "../lib/domain/planner.js";
import { attachmentFixture, png } from "./attachment-fixture.mjs";

test("legacy declarations keep old ordinals and the first modern declaration adopts existing attachment occurrences", async (t) => {
    const f = await attachmentFixture(t);
    const file = await f.store.saveFile({
        data: Buffer.from("legacy evidence"),
        name: "legacy.txt",
    });
    const input = createUserMessage({
        source: { kind: "user" },
        content: [
            { type: "text", text: "legacy input" },
            { type: "file", attachment: file },
        ],
    });
    f.session.append("user/message", input, { surfaceOp: "append" });
    f.session.append(
        "user/message",
        createUserMessage({
            source: {
                kind: ALLOCATION_SOURCE,
                form: "notice",
                summary: "legacy allocation",
                allocation: {
                    version: 2,
                    turn: 1,
                    step: 1,
                    inputs: [{ id: "§U1§", messageId: input.id }],
                    assistantId: "§A2§",
                },
            },
            content: [{ type: "text", text: "Legacy declaration." }],
        }),
        { surfaceOp: "append" },
    );
    f.session.append(
        "assistant/message",
        {
            turn: 1,
            step: 1,
            stream: [],
            message: createAssistantMessage({
                source: { provider: "test", model: "fixture" },
                content: [{ type: "text", text: "Legacy response." }],
            }),
        },
        { surfaceOp: "append" },
    );
    assert.deepEqual(
        f.engine.state(f.session).numbering.slots.map((slot) => slot.id),
        ["§U1§", "§A2§"],
    );
    assert.equal(f.engine.state(f.session).numbering.attachments.length, 0);
    f.session.append("step/end", { turn: 1, step: 1 });
    f.session.append("step/start", { turn: 1, step: 2 });
    const image = await f.store.saveImage({ data: png(), mediaType: "image/png" });
    const next = createUserMessage({
        source: { kind: "user" },
        content: [
            { type: "text", text: "New input." },
            { type: "image", attachment: image },
        ],
    });
    const before = f.engine.state(f.session);
    const plan = planAllocation(before.numbering, [next], 1, 2);
    assert.equal(before.numbering.nextNumber, 3);
    assert.deepEqual(
        plan.attachments.map((item) => [item.id, item.ownerId]),
        [
            ["§F4§", "§U1§"],
            ["§I5§", "§U3§"],
        ],
    );
    assert.equal(plan.assistantId, "§A6§");
    f.session.append("user/message", next, { surfaceOp: "append" });
    f.session.append(
        "user/message",
        createUserMessage({
            source: {
                kind: ALLOCATION_SOURCE,
                form: "notice",
                summary: "modern allocation",
                allocation: plan,
            },
            content: [{ type: "text", text: "Modern declaration." }],
        }),
        { surfaceOp: "append" },
    );
    const state = f.engine.state(f.session);
    assert.deepEqual(
        state.numbering.slots.map((slot) => slot.id),
        ["§U1§", "§A2§", "§U3§", "§A6§"],
    );
    assert.deepEqual(
        state.numbering.attachments.map((slot) => slot.id),
        ["§F4§", "§I5§"],
    );
    assert.equal(planRelease(state, ["§F4§", "§I5§"]).accepted, true);
    assert.deepEqual(
        f.session
            .snapshotEvents()
            .reduce(
                (value, event) => ledgerProjection.apply(value, event),
                ledgerProjection.init(),
            ),
        state,
    );
});
