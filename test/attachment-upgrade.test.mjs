import test from "node:test";
import assert from "node:assert/strict";
import { createUserMessage, createAssistantMessage } from "@deepseek-ai/dsh-llm";
import { planAllocation, allocationSchema, ALLOCATION_SOURCE } from "../lib/domain/numbering.js";
import { ledgerProjection } from "../lib/domain/ledger.js";
import { planRelease } from "../lib/domain/planner.js";
import { attachmentFixture, png } from "./attachment-fixture.mjs";

test("obsolete attachment declarations are rejected; modern notices announce existing occurrences without renumbering", async (t) => {
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
    const beforeLegacy = f.engine.state(f.session).numbering;
    assert.deepEqual(
        beforeLegacy.attachments.map((item) => [item.id, item.ownerId]),
        [["2", "1"]],
    );
    const obsolete = {
        version: 2,
        turn: 1,
        step: 1,
        inputs: [{ id: "§U1§", messageId: input.id }],
        assistantId: "§A2§",
    };
    assert.equal(allocationSchema.safeParse(obsolete).success, false);
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
        ["1", "3"],
    );
    assert.equal(f.engine.state(f.session).numbering.attachments.length, 1);
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
    assert.equal(before.numbering.nextNumber, 4);
    assert.deepEqual(
        plan.attachments.map((item) => [item.id, item.ownerId]),
        [
            ["2", "1"],
            ["5", "4"],
        ],
    );
    assert.equal(plan.assistantId, "6");
    assert.deepEqual(plan.announcedIds, ["1", "3", "4"]);
    assert.ok(!plan.announcedIds.includes(plan.assistantId));
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
        ["1", "3", "4", "6"],
    );
    assert.deepEqual(
        state.numbering.attachments.map((slot) => slot.id),
        ["2", "5"],
    );
    assert.equal(planRelease(state, ["2", "5"]).accepted, true);
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
