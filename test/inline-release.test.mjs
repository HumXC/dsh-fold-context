import test from "node:test";
import assert from "node:assert/strict";
import { Session } from "@deepseek-ai/dsh-session";
import {
    createAssistantMessage,
    createToolResultMessage,
    createUserMessage,
} from "@deepseek-ai/dsh-llm";
import { fixture } from "./fixture.mjs";
import { commitForcedReleases } from "./release-batch-fixture.mjs";

const signal = () => new AbortController().signal;
const body = (label) => `${label} 🧠é\n`.repeat(1800);
const value = (outcome) => {
    assert.equal(outcome.isError, false, JSON.stringify(outcome));
    return JSON.parse(
        outcome.content
            .filter((block) => block.type === "text")
            .map((block) => block.text)
            .join(""),
    );
};
const entryFor = (f, id) => f.engine.state(f.session).entries.find((entry) => entry.id === id);
const eventFor = (session, seq) => session.snapshotEvents().find((event) => event.seq === seq);
const surfaceSnapshot = (f) => ({
    nodes: [...f.session.surface.nodes],
    messages: f.session.deriveMessages(),
    replaceGeneration: f.session.surface.replaceGeneration,
    contentGeneration: f.session.surface.contentGeneration,
});
const boundary = async (f, abortSignal = signal()) => {
    commitForcedReleases(f, abortSignal);
    return null;
};

function appendSignedRound(f, text) {
    const step = 1;
    const callId = "signed-read-call";
    const replayState = {
        response: { id: "signed-provider-response", opaque: "retain response bytes\n🧠" },
        blocks: [
            { type: "thinking", thinking: "Historical reasoning.", signature: "signed-thinking" },
            { type: "tool_use", id: callId, name: "read", input: { path: "evidence.txt" } },
        ],
    };
    f.session.append("step/start", { turn: 1, step });
    const assistant = f.session.append(
        "assistant/message",
        {
            turn: 1,
            step,
            stream: [],
            message: createAssistantMessage({
                source: { provider: "test", model: "fixture", replayState },
                content: [
                    { type: "reasoning", text: "Historical reasoning." },
                    { type: "text", text: "Read the evidence before continuing." },
                    {
                        type: "tool-call",
                        id: callId,
                        name: "read",
                        arguments: '{"path":"evidence.txt"}',
                    },
                ],
            }),
        },
        { surfaceOp: "append" },
    );
    const call = f.session.append("tool/call", {
        turn: 1,
        step,
        callId,
        name: "read",
        arguments: '{"path":"evidence.txt"}',
    });
    const result = f.session.append(
        "tool/result",
        {
            turn: 1,
            step,
            message: createToolResultMessage({
                callId,
                content: [{ type: "text", text }],
                isError: false,
            }),
        },
        { surfaceOp: "append" },
    );
    f.session.append("step/end", { turn: 1, step });
    f.advanceSteps(step);
    return { assistant, call, result };
}

test("v8 tool release replaces only its body with an explicit user-compaction batch permit", async (t) => {
    const f = await fixture({ compaction: { auto: false }, scheduling: { enabled: false } });
    t.after(f.close);
    const user = f.appendUser("Keep this goal and the conversation around the evidence.");
    const original = f.toolRound("read", body("INLINE_ORIGINAL"));
    const sibling = f.toolRound("grep", "Sibling evidence remains available.");
    const id = f.idFor(original);
    const placeholder = `[released ${id}]`;
    const originalBytes = JSON.stringify(original);
    const assistant = f.session
        .snapshotEvents()
        .find(
            (event) =>
                event.type === "assistant/message" &&
                event.data.message.content.some(
                    (block) =>
                        block.type === "tool-call" && block.id === original.data.message.toolCallId,
                ),
        );
    const assistantBytes = JSON.stringify(assistant);
    const call = f.session
        .snapshotEvents()
        .find(
            (event) =>
                event.type === "tool/call" &&
                event.data.callId === original.data.message.toolCallId,
        );
    const callBytes = JSON.stringify(call);
    const receipt = await f.invoke("context_release", {
        ids: [Number(id)],
        reason: "Evidence consumed",
    });
    assert.equal(value(receipt).accepted, true);
    assert.equal(receipt.meta.dshContextCompression.version, 8);
    assert.deepEqual(receipt.meta.dshContextCompression.ids, [id]);
    assert.equal(entryFor(f, id).status, "queued");
    assert.ok(f.session.surface.nodes.includes(original.seq));
    assert.deepEqual(f.session.deriveEventMessage(original).content, original.data.message.content);
    const beforeEvents = f.session.snapshotEvents();
    const beforeTokens = f.meter.measure(f.session).totalTokens;

    await boundary(f);

    const entry = entryFor(f, id);
    assert.equal(entry.status, "released");
    assert.equal(entry.sourceSeq, original.seq);
    assert.ok(Number.isSafeInteger(entry.currentSeq));
    assert.notEqual(entry.currentSeq, original.seq);
    const replacement = eventFor(f.session, entry.currentSeq);
    assert.equal(replacement.type, "tool/result");
    assert.equal(replacement.data.message.role, "tool");
    assert.equal(replacement.data.message.toolCallId, original.data.message.toolCallId);
    assert.deepEqual(replacement.sourceEventSeqs, [original.seq]);
    assert.equal(replacement.surfaceOp.op, "replace");
    assert.ok(JSON.stringify(replacement.data.message.content).includes(placeholder));
    assert.equal(
        JSON.stringify(replacement.data.message.content).includes("INLINE_ORIGINAL"),
        false,
    );
    assert.equal(f.session.surface.nodes.includes(original.seq), false);
    assert.ok(f.session.surface.nodes.includes(replacement.seq));
    assert.ok(f.session.surface.nodes.includes(assistant.seq));
    assert.ok(f.session.surface.nodes.includes(user.seq));
    assert.ok(f.session.surface.nodes.includes(sibling.seq));
    assert.equal(entryFor(f, f.idFor(sibling)).status, "available");
    const slot = f.engine.state(f.session).numbering.slots.find((item) => item.id === id);
    assert.equal(slot.sourceSeq, original.seq);
    assert.equal(slot.currentSeq, replacement.seq);
    const committed = f.session.snapshotEvents().slice(beforeEvents.length);
    const prune = committed.find((event) => event.type === "compaction/prune");
    assert.ok(prune);
    assert.ok(prune.seq < replacement.seq);
    assert.ok(prune.data.shadowedSeqs.includes(original.seq));
    assert.deepEqual(f.session.snapshotEvents().slice(0, beforeEvents.length), beforeEvents);
    assert.equal(JSON.stringify(eventFor(f.session, original.seq)), originalBytes);
    assert.equal(JSON.stringify(eventFor(f.session, assistant.seq)), assistantBytes);
    assert.equal(JSON.stringify(eventFor(f.session, call.seq)), callBytes);
    assert.ok(f.meter.measure(f.session).totalTokens < beforeTokens);
    assert.equal(f.calls.length, 0);
    assert.equal(f.engine.state(f.session).lastSummary, null);
    assert.equal(f.engine.state(f.session).activeStart, null);
});

test("numeric IDs recover exact originals before and after settlement and aliases are rejected", async (t) => {
    const f = await fixture();
    t.after(f.close);
    const text = "Exact original 🧠é\nwith whitespace  preserved.";
    const original = f.toolRound("read", text);
    const id = f.idFor(original);
    for (const invalid of [id, `${id}R`, `§T${id}§`]) {
        assert.equal(
            (
                await f.invoke("context_release", {
                    ids: [invalid],
                    reason: "Reject string argument",
                })
            ).isError,
            true,
        );
        assert.equal((await f.invoke("context_status", { ids: [invalid] })).isError, true);
        assert.equal((await f.invoke("context_expand", { id: invalid })).isError, true);
    }
    const receipt = await f.invoke("context_release", {
        ids: [Number(id), Number(id)],
        reason: "Consumed",
    });
    assert.equal(value(receipt).accepted, true);
    assert.equal(receipt.meta.dshContextCompression.version, 8);
    assert.deepEqual(receipt.meta.dshContextCompression.ids, [id]);
    const queued = value(await f.invoke("context_status", { ids: [Number(id)] }));
    assert.deepEqual(
        queued.entries.map((entry) => entry.id),
        [id],
    );
    assert.equal(queued.entries[0].status, "queued");
    const before = value(await f.invoke("context_expand", { id: Number(id), limit: 16000 }));
    assert.equal(before.text, text);
    await boundary(f);
    const settled = value(await f.invoke("context_status", { ids: [Number(id), Number(id)] }));
    assert.deepEqual(
        settled.entries.map((entry) => entry.id),
        [id],
    );
    assert.equal(settled.entries[0].status, "released");
    const expanded = value(await f.invoke("context_expand", { id: Number(id), limit: 16000 }));
    assert.equal(expanded.id, id);
    assert.equal(expanded.status, "found");
    assert.equal(expanded.sourceSeq, original.seq);
    assert.equal(expanded.releaseStatus, "released");
    assert.equal(expanded.text, text);
    assert.equal(expanded.restoresSurface, false);
    assert.equal(entryFor(f, id).status, "released");
    assert.equal(f.calls.length, 0);
});

test("inline release replays from JSON into a new Session and a fresh projection registry", async (t) => {
    const f = await fixture();
    const fresh = await fixture();
    t.after(f.close);
    t.after(fresh.close);
    const original = f.toolRound("read", body("REPLAY_ORIGINAL"));
    const id = f.idFor(original);
    await f.invoke("context_release", { ids: [Number(id)], reason: "Consumed before replay" });
    await boundary(f);
    const events = JSON.parse(JSON.stringify(f.session.snapshotEvents()));
    const replay = Session.create(f.session.id, events, f.session.header);
    assert.deepEqual(fresh.engine.state(replay), f.engine.state(f.session));
    assert.deepEqual(replay.surface.nodes, f.session.surface.nodes);
    assert.deepEqual(replay.deriveMessages(), f.session.deriveMessages());
    assert.equal(fresh.meter.measure(replay).totalTokens, f.meter.measure(f.session).totalTokens);
    assert.equal(
        eventFor(replay, original.seq).data.message.content[0].text,
        body("REPLAY_ORIGINAL"),
    );
    const restoredEntry = fresh.engine.state(replay).entries.find((entry) => entry.id === id);
    assert.equal(restoredEntry.sourceSeq, original.seq);
    assert.equal(restoredEntry.status, "released");
    assert.ok(
        JSON.stringify(eventFor(replay, restoredEntry.currentSeq)).includes(`[released ${id}]`),
    );
    const beforeSeq = replay.seq;
    await fresh.engine.compactIfNeeded({ ...fresh.agent, session: replay }, "pressure", signal());
    assert.equal(replay.seq, beforeSeq);
    assert.equal(fresh.calls.length, 0);
});

test("repeated queued and released requests do not advance release progress or repeat the batch", async (t) => {
    const f = await fixture();
    t.after(f.close);
    const original = f.toolRound("read", body("ONCE"));
    const id = f.idFor(original);
    await f.invoke("context_release", { ids: [Number(id)], reason: "First intent" });
    const queued = structuredClone(entryFor(f, id));
    const queuedProgress = f.engine.state(f.session).lastReleaseProgressSeq;
    assert.ok(queuedProgress > 0);
    value(
        await f.invoke("context_release", {
            ids: [Number(id), Number(id)],
            reason: "Duplicate intent",
        }),
    );
    assert.deepEqual(entryFor(f, id), queued);
    assert.equal(f.engine.state(f.session).lastReleaseProgressSeq, queuedProgress);
    await boundary(f);
    const released = structuredClone(entryFor(f, id));
    const settledProgress = f.engine.state(f.session).lastReleaseProgressSeq;
    const pruneCount = f.session
        .snapshotEvents()
        .filter((event) => event.type === "compaction/prune").length;
    assert.ok(pruneCount > 0);
    value(await f.invoke("context_release", { ids: [Number(id)], reason: "Already released" }));
    assert.deepEqual(entryFor(f, id), released);
    assert.equal(f.engine.state(f.session).lastReleaseProgressSeq, settledProgress);
    const beforeSeq = f.session.seq;
    const before = surfaceSnapshot(f);
    await boundary(f);
    assert.equal(f.session.seq, beforeSeq);
    assert.deepEqual(surfaceSnapshot(f), before);
    assert.equal(
        f.session.snapshotEvents().filter((event) => event.type === "compaction/prune").length,
        pruneCount,
    );
    assert.equal(f.calls.length, 0);
});

test("new user and assistant release requests are refused without removing conversation text", async (t) => {
    const f = await fixture();
    t.after(f.close);
    const user = f.appendUser("User requirements must stay in the conversation.");
    const { assistant, result } = appendSignedRound(f, body("TOOL_STILL_AVAILABLE"));
    const ids = [f.idFor(user), f.idFor(assistant)];
    for (const id of ids) {
        const receipt = await f.invoke("context_release", {
            ids: [Number(id)],
            reason: "Attempted conversation release",
        });
        assert.equal(value(receipt).accepted, false);
        assert.notEqual(entryFor(f, id)?.status, "queued");
    }
    assert.equal(f.engine.state(f.session).lastReleaseProgressSeq, 0);
    const before = surfaceSnapshot(f);
    const beforeSeq = f.session.seq;
    await boundary(f);
    assert.equal(f.session.seq, beforeSeq);
    assert.deepEqual(surfaceSnapshot(f), before);
    assert.deepEqual(f.session.deriveEventMessage(user).content, user.data.content);
    assert.deepEqual(f.session.deriveEventMessage(assistant), assistant.data.message);
    assert.equal(entryFor(f, f.idFor(result)).status, "available");
    assert.equal(f.calls.length, 0);
});

test("obsolete release receipts cannot queue conversation bodies and normal summaries preserve their evidence", async (t) => {
    const f = await fixture();
    t.after(f.close);
    f.session.append("turn/start", { turn: 1 });
    const user = f.appendUser(body("LEGACY_USER"));
    const { assistant, result } = appendSignedRound(f, body("LEGACY_TOOL"));
    const ids = [f.idFor(user), f.idFor(assistant)];
    f.session.append("tool/ptc-dispatch", {
        rootCallId: "legacy-control-root",
        parentCallId: "legacy-control-root",
        subCallId: "legacy-release",
        name: "context_release",
        arguments: { ids, reason: "Historical v4 marks" },
        isError: false,
        content: [
            {
                type: "text",
                text: JSON.stringify({
                    dshContextCompression: {
                        version: 4,
                        kind: "release",
                        sessionId: f.session.id,
                        ids,
                        reason: "Historical v4 marks",
                    },
                }),
            },
        ],
    });
    for (const id of ids) assert.equal(entryFor(f, id).status, "available");
    const replay = Session.create(
        f.session.id,
        JSON.parse(JSON.stringify(f.session.snapshotEvents())),
        f.session.header,
    );
    assert.deepEqual(f.engine.state(replay), f.engine.state(f.session));
    const before = surfaceSnapshot(f);
    await boundary(f);
    assert.deepEqual(surfaceSnapshot(f), before);
    assert.equal(f.calls.length, 0);
    assert.ok(await f.engine.compactRegion(user.seq, result.seq, f.agent, signal()));
    for (const id of ids) assert.equal(entryFor(f, id).status, "summarized");
    assert.ok(ids.every((id) => !f.engine.state(f.session).lastSummary.excludedIds.includes(id)));
    assert.deepEqual(eventFor(f.session, user.seq).data.content, user.data.content);
    assert.deepEqual(eventFor(f.session, assistant.seq).data.message, assistant.data.message);
});

for (const kind of ["image", "file"]) {
    test(`inline ${kind} release replaces one occurrence while retaining adjacent text and sibling attachments`, async (t) => {
        const f = await fixture();
        t.after(f.close);
        f.llm.fileRequestText = (ref) => `Synthetic file ${ref.name} (${ref.bytes} bytes)`;
        const image = {
            type: "image",
            attachment: {
                attachmentId: "synthetic-image",
                mediaType: "image/png",
                bytes: 128,
                width: 1,
                height: 1,
            },
        };
        const file = {
            type: "file",
            attachment: {
                attachmentId: "synthetic-file",
                name: "evidence.txt",
                bytes: 128,
            },
        };
        const target = kind === "image" ? image : file;
        const sibling = kind === "image" ? file : image;
        const text = [
            { type: "text", text: "Before attachment; keep user requirements." },
            { type: "text", text: "Between identical occurrences; keep the conclusion." },
            { type: "text", text: "After attachments; continue the task." },
        ];
        const content = [text[0], target, text[1], target, sibling, text[2]];
        const input = createUserMessage({ source: { kind: "user" }, content });
        const decision = await f.ctx.waterfall(
            "agent/pre-step",
            {
                agent: f.agent,
                messages: [input],
                turn: 1,
                step: 1,
                signal: signal(),
            },
            async () => ({ kind: "enter", messages: [input] }),
        );
        let original;
        for (const message of decision.messages) {
            const event = f.session.append("user/message", message, { surfaceOp: "append" });
            if (message.id === input.id) original = event;
        }
        assert.ok(original);
        const occurrences = f.engine
            .state(f.session)
            .numbering.attachments.filter((slot) => slot.kind === kind);
        assert.equal(occurrences.length, 2);
        assert.equal(occurrences[0].blockIndex, 1);
        assert.equal(occurrences[1].blockIndex, 3);
        const id = occurrences[0].id;
        const siblingId = f.engine
            .state(f.session)
            .numbering.attachments.find((slot) => slot.kind !== kind).id;
        assert.equal(
            value(
                await f.invoke("context_release", {
                    ids: [Number(id)],
                    reason: "First occurrence consumed",
                }),
            ).accepted,
            true,
        );
        await boundary(f);
        const current = f.session
            .deriveMessages()
            .find((message) => message.id === original.data.id);
        assert.ok(current);
        assert.equal(current.role, "user");
        assert.deepEqual(
            current.content.filter((block) => block.type === kind),
            [target],
        );
        assert.deepEqual(
            current.content.filter((block) => block.type === sibling.type),
            [sibling],
        );
        assert.deepEqual(
            current.content.filter((block) => text.some((item) => item.text === block.text)),
            text,
        );
        assert.ok(JSON.stringify(current.content).includes(`[released ${id}]`));
        assert.equal(entryFor(f, id).status, "released");
        assert.equal(entryFor(f, occurrences[1].id).status, "available");
        assert.equal(entryFor(f, siblingId).status, "available");
        assert.deepEqual(eventFor(f.session, original.seq).data, original.data);
        assert.deepEqual(original.data.content, content);
        const replay = Session.create(
            f.session.id,
            JSON.parse(JSON.stringify(f.session.snapshotEvents())),
            f.session.header,
        );
        assert.deepEqual(f.engine.state(replay), f.engine.state(f.session));
        assert.deepEqual(replay.deriveMessages(), f.session.deriveMessages());
        assert.equal(f.calls.length, 0);
    });
}

test("releasing a signed assistant's paired result preserves its complete replay state and tool call bytes", async (t) => {
    const f = await fixture();
    t.after(f.close);
    const { assistant, call, result } = appendSignedRound(f, body("SIGNED_RESULT_ORIGINAL"));
    const assistantBytes = JSON.stringify(assistant.data);
    const replayBytes = JSON.stringify(assistant.data.message.source.replayState);
    const callBytes = JSON.stringify(call);
    const id = f.idFor(result);
    await f.invoke("context_release", { ids: [Number(id)], reason: "Signed call result consumed" });
    await boundary(f);
    const currentAssistant = f.session
        .deriveMessages()
        .find((message) => message.id === assistant.data.message.id);
    assert.ok(currentAssistant);
    assert.equal(JSON.stringify(currentAssistant), JSON.stringify(assistant.data.message));
    assert.equal(JSON.stringify(currentAssistant.source.replayState), replayBytes);
    assert.equal(JSON.stringify(eventFor(f.session, assistant.seq).data), assistantBytes);
    assert.equal(JSON.stringify(eventFor(f.session, call.seq)), callBytes);
    const currentResult = eventFor(f.session, entryFor(f, id).currentSeq);
    assert.equal(currentResult.type, "tool/result");
    assert.equal(currentResult.data.message.toolCallId, call.data.callId);
    assert.ok(JSON.stringify(currentResult.data.message.content).includes(`[released ${id}]`));
    assert.equal(f.calls.length, 0);
});

test("cancellation before an inline batch preserves pending intents, log, surface and token meter", async (t) => {
    const f = await fixture();
    t.after(f.close);
    const first = f.toolRound("read", body("CANCEL_FIRST"));
    const second = f.toolRound("grep", body("CANCEL_SECOND"));
    const ids = [f.idFor(first), f.idFor(second)];
    await f.invoke("context_release", {
        ids: ids.map(Number),
        reason: "Queue before cancellation",
    });
    const beforeEvents = f.session.snapshotEvents();
    const beforeState = structuredClone(f.engine.state(f.session));
    const beforeSurface = surfaceSnapshot(f);
    const beforeTokens = f.meter.measure(f.session).totalTokens;
    const controller = new AbortController();
    controller.abort(new Error("inline batch cancelled before commit"));
    await boundary(f, controller.signal).catch((error) => {
        assert.equal(error, controller.signal.reason);
    });
    assert.deepEqual(f.session.snapshotEvents(), beforeEvents);
    assert.deepEqual(f.engine.state(f.session), beforeState);
    assert.deepEqual(surfaceSnapshot(f), beforeSurface);
    assert.equal(f.meter.measure(f.session).totalTokens, beforeTokens);
    assert.equal(f.calls.length, 0);
    await boundary(f);
    for (const id of ids) assert.equal(entryFor(f, id).status, "released");
});

test("one unknown ID rejects a mixed inline release batch without queuing its valid subset", async (t) => {
    const f = await fixture();
    t.after(f.close);
    const original = f.toolRound("read", body("KEEP_ON_INVALID_BATCH"));
    const id = f.idFor(original);
    const receipt = await f.invoke("context_release", {
        ids: [Number(id), 999999],
        reason: "Invalid mixed batch",
    });
    assert.equal(value(receipt).accepted, false);
    assert.equal(entryFor(f, id).status, "available");
    assert.equal(f.engine.state(f.session).lastReleaseProgressSeq, 0);
    const beforeEvents = f.session.snapshotEvents();
    const before = surfaceSnapshot(f);
    await boundary(f);
    assert.deepEqual(f.session.snapshotEvents(), beforeEvents);
    assert.deepEqual(surfaceSnapshot(f), before);
    assert.equal(f.calls.length, 0);
});
