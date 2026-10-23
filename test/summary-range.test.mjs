import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Session, SessionId } from "@deepseek-ai/dsh-session";
import {
    createAssistantMessage,
    createDeveloperMessage,
    createSystemMessage,
    createToolResultMessage,
    createUserMessage,
} from "@deepseek-ai/dsh-llm";
import { imageOffloadProjection } from "@deepseek-ai/dsh-compaction-image-offload/projection";
import {
    foldNumbering,
    initialNumbering,
    replaceNumberedSurface,
} from "../lib/domain/numbering.js";
import {
    freezeSummaryRange as freezeFromCut,
    validateSummaryRange as validateFromCut,
} from "../lib/domain/summary-range.js";

const journals = new WeakMap();
const cutFor = (session) => ({
    sessionId: session.id,
    revision: session.seq,
    surface: [...session.surface.nodes],
    events: new Map(journals.get(session).map((event) => [event.seq, event])),
});
const freezeSummaryRange = (session, numbering, range) =>
    freezeFromCut(session, numbering, range, cutFor(session));
const validateSummaryRange = (session, numbering, frozen) =>
    validateFromCut(session, numbering, frozen, cutFor(session));

// Detached RAM sessions and pure numbering folds: no profile, services, model or attachment store.
function world(projections = []) {
    const session = Session.create(SessionId(randomUUID()), [], undefined, undefined, projections);
    const journal = [];
    journals.set(session, journal);
    let numbering = initialNumbering();
    const append = (type, data, options) => {
        const previous = [...session.surface.nodes];
        const event =
            options === undefined
                ? session.append(type, data)
                : session.append(type, data, options);
        journal.push(event);
        if (event.surfaceOp !== undefined && event.surfaceOp !== "append") {
            const first = previous.indexOf(event.surfaceOp.startSeq);
            const last = previous.indexOf(event.surfaceOp.endSeq);
            numbering = replaceNumberedSurface(numbering, event, previous.slice(first, last + 1));
        } else numbering = foldNumbering(numbering, event);
        return event;
    };
    const user = (content) =>
        append(
            "user/message",
            createUserMessage({
                source: { kind: "user" },
                content: typeof content === "string" ? [{ type: "text", text: content }] : content,
            }),
            { surfaceOp: "append" },
        );
    return { session, append, user, numbering: () => numbering };
}

function calls(w, names = ["read"]) {
    const assistant = w.append(
        "assistant/message",
        {
            turn: 1,
            step: 1,
            message: createAssistantMessage({
                source: { provider: "test", model: "summary-range" },
                content: names.map((name, index) => ({
                    type: "tool-call",
                    id: `call-${index}`,
                    name,
                    arguments: "{}",
                })),
            }),
            stream: [],
        },
        { surfaceOp: "append" },
    );
    const invocations = names.map((name, index) =>
        w.append("tool/call", {
            turn: 1,
            step: 1,
            callId: `call-${index}`,
            name,
            arguments: "{}",
        }),
    );
    return { assistant, invocations };
}

function result(w, call, content = "Verified result") {
    return w.append(
        "tool/result",
        {
            turn: 1,
            step: 1,
            message: createToolResultMessage({
                callId: call.data.callId,
                content: typeof content === "string" ? [{ type: "text", text: content }] : content,
                isError: false,
            }),
        },
        { surfaceOp: "append", sourceEventSeqs: [call.seq] },
    );
}

const file = { attachmentId: "a".repeat(64), name: "same.txt", bytes: 4 };
const image = {
    attachmentId: "b".repeat(64),
    mediaType: "image/png",
    width: 1,
    height: 1,
    bytes: 4,
};
const freeze = (w, start, end = start) =>
    freezeSummaryRange(w.session, w.numbering(), { start: start.seq, end: end.seq });
const valid = (w, frozen, numbering = w.numbering()) =>
    validateSummaryRange(w.session, numbering, frozen);

function replaceUser(w, event, content, end = event) {
    return w.append(
        "user/message",
        {
            ...event.data,
            content: typeof content === "string" ? [{ type: "text", text: content }] : content,
        },
        {
            surfaceOp: { op: "replace", startSeq: event.seq, endSeq: end.seq },
            sourceEventSeqs: w.session.surface.nodes.slice(
                w.session.surface.nodes.indexOf(event.seq),
                w.session.surface.nodes.indexOf(end.seq) + 1,
            ),
        },
    );
}

test("range snapshot includes user, pure tool-call assistant and result without consulting release entries", () => {
    const w = world();
    const user = w.user("Find the evidence");
    const { assistant, invocations } = calls(w);
    const tool = result(w, invocations[0]);
    const before = JSON.stringify(w.numbering());
    const frozen = freeze(w, user, tool);
    assert.deepEqual(frozen.seqs, [user.seq, assistant.seq, tool.seq]);
    assert.deepEqual(frozen.messages, [
        { seq: user.seq, id: "1", role: "user", tool: null },
        { seq: assistant.seq, id: "2", role: "assistant", tool: null },
        { seq: tool.seq, id: "3", role: "tool", tool: "read" },
    ]);
    assert.equal(
        assistant.data.message.content.every((block) => block.type === "tool-call"),
        true,
    );
    assert.deepEqual(
        frozen.nodes.map((node) => node.messageId),
        [user.data.id, assistant.data.message.id, tool.data.message.id],
    );
    assert.ok(frozen.nodes.every((node) => /^[a-f0-9]{64}$/.test(node.fingerprint)));
    assert.deepEqual(JSON.parse(JSON.stringify(frozen)), frozen);
    assert.equal(JSON.stringify(w.numbering()), before);
    assert.deepEqual(valid(w, frozen), { valid: true });
});

test("reverse tool completion keeps IDs 4,3 in surface order", () => {
    const w = world();
    w.user("Run both checks");
    const { invocations } = calls(w, ["read", "grep"]);
    const second = result(w, invocations[1], "Second finished first");
    const first = result(w, invocations[0], "First finished last");
    const frozen = freeze(w, second, first);
    assert.deepEqual(frozen.seqs, [second.seq, first.seq]);
    assert.deepEqual(
        frozen.messages.map((message) => message.id),
        ["4", "3"],
    );
    assert.deepEqual(
        frozen.messages.map((message) => message.tool),
        ["grep", "read"],
    );
});

test("replacement spans use surface positions even when start seq is greater than end seq", () => {
    const w = world();
    w.user("Earlier evidence");
    const middle = w.user("Original middle");
    const tail = w.user("Retained later evidence");
    const replacement = replaceUser(w, middle, "Replaced middle");
    assert.ok(replacement.seq > tail.seq);
    const frozen = freeze(w, replacement, tail);
    assert.deepEqual(frozen.seqs, [replacement.seq, tail.seq]);
    assert.deepEqual(
        frozen.messages.map((message) => message.id),
        ["2", "3"],
    );
    assert.deepEqual(valid(w, frozen), { valid: true });
    assert.throws(() => freeze(w, middle, tail), /current surface span/);
    assert.throws(() => freeze(w, tail, replacement), /current surface span/);
});

test("new tail nodes, metadata events and changes outside the span remain valid", () => {
    const w = world();
    const outside = w.user("Outside before the span");
    const selected = w.user("Selected evidence");
    const frozen = freeze(w, selected);
    const seq = w.session.seq;
    w.user("A new user instruction must be retained");
    replaceUser(w, outside, "Outside changed");
    w.append("request/header", {
        header: { config: { provider: "test", model: "summary-range" } },
        reason: "initial",
    });
    assert.ok(w.session.seq > seq);
    assert.deepEqual(valid(w, frozen), { valid: true });
});

test("replacement or removal of a selected node invalidates the original snapshot", () => {
    for (const collapse of [false, true]) {
        const w = world();
        const first = w.user("First selected node");
        const second = w.user("Second selected node");
        const frozen = freeze(w, first, second);
        replaceUser(w, first, "Replacement", collapse ? second : first);
        const outcome = valid(w, frozen);
        assert.equal(outcome.valid, false);
        assert.match(outcome.reason, /missing|contiguous/);
    }
});

test("same-byte attachment occurrences keep distinct IDs, owners and current block positions", () => {
    const w = world();
    const first = w.user([
        { type: "file", attachment: file },
        { type: "image", attachment: image },
        { type: "file", attachment: file },
        { type: "image", attachment: image },
    ]);
    const second = w.user([{ type: "file", attachment: file }]);
    const frozen = freeze(w, first, second);
    assert.deepEqual(
        frozen.messages.map((message) => message.id),
        ["1", "6"],
    );
    assert.deepEqual(frozen.attachments, [
        { seq: first.seq, id: "2", ownerId: "1", blockIndex: 0, kind: "file" },
        { seq: first.seq, id: "3", ownerId: "1", blockIndex: 1, kind: "image" },
        { seq: first.seq, id: "4", ownerId: "1", blockIndex: 2, kind: "file" },
        { seq: first.seq, id: "5", ownerId: "1", blockIndex: 3, kind: "image" },
        { seq: second.seq, id: "7", ownerId: "6", blockIndex: 0, kind: "file" },
    ]);
    assert.deepEqual(valid(w, frozen), { valid: true });
    const changed = structuredClone(w.numbering());
    changed.attachments[0].id = "999";
    assert.equal(valid(w, frozen, changed).valid, false);
    const swapped = structuredClone(w.numbering());
    [swapped.attachments[0].id, swapped.attachments[2].id] = [
        swapped.attachments[2].id,
        swapped.attachments[0].id,
    ];
    assert.equal(valid(w, frozen, swapped).valid, false);
    const missing = structuredClone(w.numbering());
    missing.attachments.shift();
    assert.throws(
        () =>
            freezeSummaryRange(w.session, missing, {
                start: first.seq,
                end: second.seq,
            }),
        /has no numbering slot/,
    );
    const duplicated = structuredClone(w.numbering());
    duplicated.attachments.push({ ...duplicated.attachments[0], id: "999" });
    assert.throws(
        () =>
            freezeSummaryRange(w.session, duplicated, {
                start: first.seq,
                end: second.seq,
            }),
        /ambiguous attachment position/,
    );
});

test("attachment replacement invalidates the selection", () => {
    const w = world();
    const original = w.user([{ type: "file", attachment: file }]);
    const frozen = freeze(w, original);
    replaceUser(w, original, [
        {
            type: "file",
            attachment: { ...file, attachmentId: "c".repeat(64) },
        },
    ]);
    assert.equal(valid(w, frozen).valid, false);
});

test("derived image projection changes invalidate the hash without changing surface seq or message ID", () => {
    const w = world([imageOffloadProjection]);
    const original = w.user([{ type: "image", attachment: image }]);
    const frozen = freeze(w, original);
    w.append("image/offload", { targets: [{ seq: original.seq, imageIndexes: [0] }] });
    assert.ok(w.session.surface.nodes.includes(original.seq));
    assert.equal(w.session.deriveEventMessage(original).id, original.data.id);
    assert.equal(w.session.deriveEventMessage(original).content[0].offloaded, true);
    assert.deepEqual(valid(w, frozen), { valid: false, reason: "derived message content changed" });
});

test("existing checkpoint, system/developer, null derivation and control inputs stay separately classified", () => {
    const w = world();
    const empty = w.append(
        "system/message",
        {
            turn: 1,
            step: 1,
            message: createSystemMessage(""),
        },
        { surfaceOp: "append" },
    );
    const system = w.append(
        "system/message",
        {
            turn: 1,
            step: 1,
            message: createSystemMessage("System instructions"),
        },
        { surfaceOp: "append" },
    );
    const developer = w.append(
        "developer/message",
        {
            turn: 1,
            step: 1,
            message: createDeveloperMessage({
                source: { kind: "user" },
                content: [{ type: "text", text: "Developer context" }],
            }),
        },
        { surfaceOp: "append" },
    );
    const checkpointId = randomUUID();
    const checkpoint = w.append(
        "user/message",
        createUserMessage({
            source: { kind: "compact-checkpoint", compactionId: checkpointId },
            content: [{ type: "text", text: "Previous checkpoint" }],
        }),
        { surfaceOp: "append" },
    );
    const notice = w.append(
        "user/message",
        createUserMessage({
            source: { kind: "runtime-context", form: "notice", summary: "Runtime context" },
            content: [{ type: "text", text: "Internal context" }],
        }),
        { surfaceOp: "append" },
    );
    const business = w.user("Keep this objective");
    const frozen = freeze(w, empty, business);
    assert.equal(w.session.deriveEventMessage(empty), null);
    assert.deepEqual(frozen.checkpoints, [{ seq: checkpoint.seq, compactionId: checkpointId }]);
    assert.deepEqual(frozen.unnumbered, [
        { seq: empty.seq, kind: "system/message" },
        { seq: system.seq, kind: "system" },
        { seq: developer.seq, kind: "developer" },
        { seq: notice.seq, kind: "runtime-context" },
    ]);
    assert.deepEqual(
        frozen.messages.map((message) => message.id),
        ["1"],
    );
    assert.equal(frozen.nodes[0].messageId, null);
    assert.deepEqual(valid(w, frozen), { valid: true });
});

test("control tool results can contain deliberately unnumbered attachments", () => {
    const w = world();
    const { invocations } = calls(w, ["context_expand"]);
    const tool = result(w, invocations[0], [{ type: "image", attachment: image }]);
    const frozen = freeze(w, tool);
    assert.equal(frozen.messages[0].tool, "context_expand");
    assert.deepEqual(frozen.attachments, []);
    assert.deepEqual(valid(w, frozen), { valid: true });
});

test("wrong session, missing/ambiguous message mapping and malformed endpoints are rejected", () => {
    const w = world();
    const user = w.user("Evidence");
    const { assistant, invocations } = calls(w);
    const tool = result(w, invocations[0]);
    const frozen = freeze(w, user, tool);
    assert.deepEqual(validateSummaryRange(world().session, w.numbering(), frozen), {
        valid: false,
        reason: "session mismatch",
    });
    for (const event of [user, assistant, tool]) {
        const missing = structuredClone(w.numbering());
        missing.slots = missing.slots.filter((slot) => slot.currentSeq !== event.seq);
        assert.throws(
            () =>
                freezeSummaryRange(w.session, missing, {
                    start: event.seq,
                    end: event.seq,
                }),
            /exactly one message numbering slot/,
        );
        assert.equal(valid(w, frozen, missing).valid, false);
    }
    const duplicate = structuredClone(w.numbering());
    duplicate.slots.push({ ...duplicate.slots[0] });
    assert.throws(
        () =>
            freezeSummaryRange(w.session, duplicate, {
                start: user.seq,
                end: tool.seq,
            }),
        /exactly one message numbering slot/,
    );
    for (const start of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1])
        assert.throws(
            () =>
                freezeSummaryRange(w.session, w.numbering(), {
                    start,
                    end: tool.seq,
                }),
            /safe integers/,
        );
    assert.equal(valid(w, { ...frozen, seqs: [] }).valid, false);
    assert.equal(valid(w, { ...frozen, seqs: [...frozen.seqs].reverse() }).valid, false);
});

test("canonical fingerprints survive JSON round trips and object-key reordering", () => {
    const w = world();
    const user = w.user("Keep stable content identity");
    const frozen = freeze(w, user);
    const log = w.session.snapshotEvents().map((event) =>
        event.type === "user/message"
            ? {
                  ...event,
                  data: Object.fromEntries(Object.entries(event.data).reverse()),
              }
            : event,
    );
    const restored = Session.create(w.session.id, log, w.session.header);
    journals.set(restored, log);
    assert.deepEqual(
        validateSummaryRange(restored, w.numbering(), JSON.parse(JSON.stringify(frozen))),
        {
            valid: true,
        },
    );
});

test("range reads reject an old cut while a fresh cut still accepts unchanged selected evidence", () => {
    const w = world();
    const source = w.user("Keep the selected evidence unchanged.");
    const cut = cutFor(w.session);
    const range = { start: source.seq, end: source.seq };
    const frozen = freezeFromCut(w.session, w.numbering(), range, cut);
    w.user("New protected input outside the selected span.");
    assert.deepEqual(validateFromCut(w.session, w.numbering(), frozen, cut), {
        valid: false,
        reason: "observation revision changed",
    });
    assert.throws(
        () => freezeFromCut(w.session, w.numbering(), range, cut),
        /observation revision changed/,
    );
    assert.deepEqual(valid(w, frozen), { valid: true });
});
