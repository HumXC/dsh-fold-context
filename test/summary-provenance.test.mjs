import test from "node:test";
import assert from "node:assert/strict";
import {
    createAssistantMessage,
    createToolResultMessage,
    createUserMessage,
} from "@deepseek-ai/dsh-llm";
import { fixture } from "./fixture.mjs";
import { summaryRecords } from "./summary-records.mjs";
import { ALLOCATION_SOURCE } from "../lib/domain/numbering.js";
import { projectSummaryInput, projectionReceipt } from "../lib/domain/summary-projection.js";

const projectionPolicy = { reasoning: "omit-from-summary", images: "references" };

async function admit(f, input) {
    const decision = await f.ctx.waterfall(
        "agent/pre-step",
        {
            agent: f.agent,
            messages: [input],
            turn: 1,
            step: 1,
            signal: new AbortController().signal,
        },
        async () => ({ kind: "enter", messages: [input], startsRequestSeries: true }),
    );
    assert.equal(decision.kind, "enter");
    f.session.append("step/start", { turn: 1, step: 1 });
    for (const message of decision.messages)
        f.session.append("user/message", message, { surfaceOp: "append" });
    return decision.messages;
}

test("summary input hides numeric message provenance without changing task text, arguments or original events", async (t) => {
    const f = await fixture();
    t.after(f.close);
    f.session.append("turn/start", { turn: 1 });
    const userText = "The protocol must accept literal §T9R§; keep that code string exactly.";
    const user = f.appendUser(userText);
    const args = JSON.stringify({ pattern: "§T9R§", code: 'normalizeId("§T9R§")' });
    f.session.append("step/start", { turn: 1, step: 1 });
    const assistant = createAssistantMessage({
        source: {
            provider: "test",
            model: "fixture",
            replayState: { response: { private: "signed-original" } },
        },
        content: [
            { type: "text", text: "Preserve the §T9R§ example in the implementation." },
            { type: "tool-call", id: "task-call", name: "read", arguments: args },
        ],
    });
    f.session.append(
        "assistant/message",
        { turn: 1, step: 1, message: assistant, stream: [] },
        { surfaceOp: "append" },
    );
    const call = f.session.append("tool/call", {
        turn: 1,
        step: 1,
        callId: "task-call",
        name: "read",
        arguments: args,
    });
    const result = createToolResultMessage({
        callId: "task-call",
        isError: false,
        content: [{ type: "text", text: "Exact code evidence: §T9R§" }],
    });
    f.session.append(
        "tool/result",
        { turn: 1, step: 1, message: result },
        { surfaceOp: "append", sourceEventSeqs: [call.seq] },
    );
    f.session.append("step/end", { turn: 1, step: 1 });
    const state = f.engine.state(f.session);
    const sourceIds = state.numbering.slots.map((slot) => slot.id);
    assert.deepEqual(sourceIds, ["1", "2", "3"]);
    const messages = [user.data, assistant, result];
    const before = JSON.stringify({ events: f.session.snapshotEvents(), state, messages });
    const projected = projectSummaryInput(state, messages, f.session.seq, projectionPolicy);
    const records = summaryRecords(projected);
    assert.equal(records.length, 4);
    assert.equal(
        records.every((record) => record.id === null && !("ownerId" in record)),
        true,
    );
    assert.equal(
        records.some((record) => sourceIds.includes(record.id)),
        false,
    );
    assert.equal(records.find((record) => record.role === "user").text, userText);
    assert.equal(
        records.find((record) => record.role === "assistant" && record.type === "text").text,
        assistant.content[0].text,
    );
    assert.equal(records.find((record) => record.type === "tool-call").arguments, args);
    assert.equal(records.find((record) => record.role === "tool").text, result.content[0].text);
    assert.equal(JSON.stringify(projected).includes("signed-original"), false);
    assert.match(
        projected.at(-1).content[0].text,
        /Do not copy or invent bookkeeping\/source labels/,
    );
    assert.match(
        projected.at(-1).content[0].text,
        /preserve identifiers that are actual task content or code/,
    );
    assert.equal(JSON.stringify({ events: f.session.snapshotEvents(), state, messages }), before);
});

test("summary input retains attachment archive IDs while hiding owner IDs and allocation notices", async (t) => {
    const f = await fixture();
    t.after(f.close);
    f.session.append("turn/start", { turn: 1 });
    const image = {
        type: "image",
        attachment: {
            attachmentId: "summary-image",
            mediaType: "image/png",
            bytes: 128,
            width: 1,
            height: 1,
        },
    };
    const file = {
        type: "file",
        attachment: { attachmentId: "summary-file", name: "evidence.txt", bytes: 128 },
    };
    const input = createUserMessage({
        source: { kind: "user" },
        content: [
            { type: "text", text: "Keep the sketch and source document recoverable." },
            image,
            file,
        ],
    });
    const messages = await admit(f, input);
    assert.equal(
        messages.some((message) => message.source.kind === ALLOCATION_SOURCE),
        true,
    );
    const label = messages.find((message) => message.source.kind === ALLOCATION_SOURCE).content[0]
        .text;
    const state = f.engine.state(f.session);
    const owner = state.numbering.slots.find((slot) => slot.messageId === input.id);
    const attachments = state.numbering.attachments.filter((item) => item.ownerId === owner.id);
    assert.deepEqual(
        attachments.map((item) => item.kind),
        ["image", "file"],
    );
    const before = JSON.stringify({ events: f.session.snapshotEvents(), state, messages });
    for (const images of ["references", "native"]) {
        const projected = projectSummaryInput(state, messages, f.session.seq, {
            reasoning: "omit-from-summary",
            images,
        });
        const records = summaryRecords(projected);
        assert.equal(records.length, 3);
        assert.deepEqual(
            records
                .filter((record) => record.type === "image" || record.type === "file")
                .map((record) => record.id),
            attachments.map((item) => item.id),
        );
        assert.match(records.find((record) => record.type === "image").id, /^[1-9]\d*$/);
        assert.match(records.find((record) => record.type === "file").id, /^[1-9]\d*$/);
        assert.equal(
            records.every((record) => !("ownerId" in record)),
            true,
        );
        assert.equal(
            records.some((record) => record.id === owner.id),
            false,
        );
        assert.equal(
            records.some((record) => record.text === label),
            false,
        );
        assert.deepEqual(
            projected.at(-1).content.filter((block) => block.type === "file"),
            [file],
        );
        assert.deepEqual(
            projected.at(-1).content.filter((block) => block.type === "image"),
            images === "native" ? [image] : [],
        );
        const receipt = projectionReceipt(state, new Set([owner.currentSeq]), {
            reasoning: "omit-from-summary",
            images,
        });
        assert.equal(receipt.version, 2);
        assert.equal(receipt.images, images);
        assert.deepEqual(
            receipt.attachments.map(({ id, ownerId }) => ({ id, ownerId })),
            attachments.map(({ id, ownerId }) => ({ id, ownerId })),
        );
    }
    assert.equal(JSON.stringify({ events: f.session.snapshotEvents(), state, messages }), before);
});

test("summary input omits allocation and release cleanup notices while preserving similarly worded user content", async (t) => {
    const f = await fixture();
    t.after(f.close);
    f.session.append("turn/start", { turn: 1 });
    const input = createUserMessage({
        source: { kind: "user" },
        content: [
            {
                type: "text",
                text: "Context numbering (this session): explain literal §T9R§ in my code.",
            },
        ],
    });
    const admitted = await admit(f, input);
    assert.equal(
        admitted.some((message) => message.source.kind === ALLOCATION_SOURCE),
        true,
    );
    const allocation = createUserMessage({
        source: { kind: ALLOCATION_SOURCE, form: "notice" },
        content: [{ type: "text", text: "Legacy context numbering notice must be omitted." }],
    });
    const cleanup = createUserMessage({
        source: { kind: "fold-context-release-cleanup", form: "notice" },
        content: [
            { type: "text", text: "Release bookkeeping settled; this is not task evidence." },
        ],
    });
    // Even a reused ID on omitted bookkeeping must not make business evidence ambiguous.
    const messages = [{ ...allocation, id: input.id }, { ...cleanup, id: input.id }, input];
    const state = f.engine.state(f.session);
    const before = JSON.stringify({ events: f.session.snapshotEvents(), state, messages });
    const projected = projectSummaryInput(state, messages, f.session.seq, projectionPolicy);
    const records = summaryRecords(projected);
    assert.equal(records.length, 1);
    assert.equal(records[0].role, "user");
    assert.equal(records[0].text, input.content[0].text);
    assert.equal(JSON.stringify(projected).includes(allocation.content[0].text), false);
    assert.equal(JSON.stringify(projected).includes(cleanup.content[0].text), false);
    assert.equal(JSON.stringify({ events: f.session.snapshotEvents(), state, messages }), before);
});
