import test from "node:test";
import assert from "node:assert/strict";
import { Session, interruptedTurnClosers } from "@deepseek-ai/dsh-session";
import {
    createAssistantMessage,
    createToolResultMessage,
    createUserMessage,
} from "@deepseek-ai/dsh-llm";
import { fixture } from "./fixture.mjs";
import { ALLOCATION_SOURCE, foldNumbering, initialNumbering } from "../lib/domain/numbering.js";
import { ledgerProjection } from "../lib/domain/ledger.js";

const signal = () => new AbortController().signal;
const user = (text) =>
    createUserMessage({ source: { kind: "user" }, content: [{ type: "text", text }] });
const assistant = (content) =>
    createAssistantMessage({ source: { provider: "test", model: "fixture" }, content });
const slots = (f) => f.engine.state(f.session).numbering.slots;
async function propose(
    f,
    messages,
    step = 1,
    base = { kind: "enter", messages, startsRequestSeries: true },
) {
    return f.ctx.waterfall(
        "agent/pre-step",
        { agent: f.agent, messages, turn: 1, step, signal: signal() },
        async () => base,
    );
}
function commit(f, decision, step = 1) {
    f.advanceSteps(step);
    f.session.append("step/start", { turn: 1, step });
    for (const message of decision.messages)
        f.session.append("user/message", message, { surfaceOp: "append" });
}
function appendAssistant(f, content, step = 1, interrupted = false) {
    const message = assistant(content);
    return f.session.append(
        "assistant/message",
        { turn: 1, step, message, stream: [], ...(interrupted ? { interrupted: true } : {}) },
        { surfaceOp: "append" },
    );
}
function appendResult(f, callId, call, step = 1) {
    return f.session.append(
        "tool/result",
        {
            turn: 1,
            step,
            message: createToolResultMessage({
                callId,
                content: [{ type: "text", text: "Result ".repeat(1000) }],
                isError: false,
            }),
        },
        { surfaceOp: "append", sourceEventSeqs: [call.seq] },
    );
}

test("cancellation before admission does not append or consume the proposed allocation", async (t) => {
    const f = await fixture();
    t.after(f.close);
    const input = user("Cancelled before admission");
    const before = f.session.seq;
    await assert.rejects(
        f.ctx.waterfall(
            "agent/pre-step",
            {
                agent: f.agent,
                messages: [input],
                turn: 1,
                step: 1,
                signal: AbortSignal.abort(),
            },
            async () => ({ kind: "enter", messages: [input] }),
        ),
        { name: "AbortError" },
    );
    assert.equal(f.session.seq, before);
    assert.equal(f.engine.state(f.session).numbering.nextNumber, 1);
});

test("a changed admitted input cannot silently bind the declaration to the wrong message", async (t) => {
    const f = await fixture();
    t.after(f.close);
    const original = user("Planned input");
    const decision = await propose(f, [original]);
    const replacement = f.appendUser("Another middleware replaced the input");
    const numbered = foldNumbering(initialNumbering(), replacement);
    const declaration = decision.messages.at(-1);
    assert.throws(
        () =>
            foldNumbering(numbered, {
                type: "user/message",
                seq: replacement.seq + 1,
                time: Date.now(),
                data: declaration,
                surfaceOp: "append",
            }),
        /allocation does not match the admitted input sequence/,
    );
    assert.equal(numbered.nextNumber, 2);
});

test("official summary removes live bindings while retaining their original allocation IDs", async (t) => {
    const f = await fixture();
    t.after(f.close);
    const input = f.appendUser("Important goal ".repeat(1000));
    const result = f.toolRound("read", "Old evidence ".repeat(1000));
    f.toolRound("grep", "Recent evidence ".repeat(1000));
    const originalIds = f.engine.state(f.session).numbering.slots.map((slot) => slot.id);
    f.appendUser("Latest tail");
    const checkpoint = await f.engine.compactNow(f.agent, signal());
    assert.ok(checkpoint);
    const numbering = f.engine.state(f.session).numbering;
    assert.deepEqual(
        numbering.slots.slice(0, originalIds.length).map((slot) => slot.id),
        originalIds,
    );
    for (const event of [input, result]) {
        const slot = numbering.slots.find((slot) => slot.sourceSeq === event.seq);
        assert.equal(slot.status, "summarized");
        assert.equal(slot.currentSeq, null);
    }
    assert.equal(
        numbering.slots.some((slot) => slot.sourceSeq === checkpoint.summarySeq),
        false,
    );
    assert.equal(
        f.session.eventAt(result.seq).data.message.content[0].text,
        "Old evidence ".repeat(1000),
    );
});

test("filtered later-step input remains empty and cannot manufacture a new request", async (t) => {
    const f = await fixture();
    t.after(f.close);
    f.appendUser("A completed earlier step");
    f.toolRound("read", "Earlier evidence");
    const before = f.session.seq;
    const nextNumber = f.engine.state(f.session).numbering.nextNumber;
    const accepted = { kind: "enter", messages: [], startsRequestSeries: true };
    const result = await f.ctx.waterfall(
        "agent/pre-step",
        {
            agent: f.agent,
            messages: [user("Filtered next-step input")],
            turn: 1,
            step: 2,
            signal: signal(),
        },
        async () => accepted,
    );
    assert.equal(result, accepted);
    assert.deepEqual(result.messages, []);
    assert.equal(f.session.seq, before);
    assert.equal(f.engine.state(f.session).numbering.nextNumber, nextNumber);
});

test("a legitimate input-free continuation after tools still reserves the next assistant", async (t) => {
    const f = await fixture();
    t.after(f.close);
    f.appendUser("Read then continue");
    f.toolRound("read", "Tool evidence");
    const decision = await propose(f, [], 2);
    assert.equal(decision.messages.length, 1);
    assert.equal(decision.messages[0].source.allocation.assistantId, "§A4§");
    assert.deepEqual(decision.messages[0].source.allocation.inputs, []);
    assert.equal(f.engine.state(f.session).numbering.nextNumber, 4);
    commit(f, decision, 2);
    assert.equal(slots(f).at(-1).id, "§A4§");
    assert.equal(slots(f).at(-1).status, "reserved");
});

test("accepted batch declares typed IDs before generation without mutating input or history", async (t) => {
    const f = await fixture();
    t.after(f.close);
    const input = user("Original user body");
    const before = f.session.seq;
    const first = await propose(f, [input]);
    const preview = await propose(f, [input]);
    assert.equal(f.session.seq, before);
    assert.equal(f.engine.state(f.session).numbering.nextNumber, 1);
    assert.equal(first.startsRequestSeries, true);
    assert.equal(first.messages[0], input);
    const declaration = first.messages.at(-1);
    assert.equal(declaration.source.kind, ALLOCATION_SOURCE);
    assert.deepEqual(declaration.source.allocation.inputs, [{ messageId: input.id, id: "§U1§" }]);
    assert.equal(declaration.source.allocation.assistantId, "§A2§");
    assert.match(declaration.content[0].text, /next assistant message is reserved as §A2§/);
    assert.equal(preview.messages.at(-1).source.allocation.assistantId, "§A2§");
    commit(f, first);
    assert.deepEqual(
        slots(f).map((slot) => [slot.id, slot.role, slot.status]),
        [
            ["§U1§", "user", "bound"],
            ["§A2§", "assistant", "reserved"],
        ],
    );
    const result = appendAssistant(f, [{ type: "text", text: "Unmodified generated reply" }]);
    assert.equal(slots(f)[1].sourceSeq, result.seq);
    assert.equal(slots(f)[1].messageId, result.data.message.id);
    assert.equal(slots(f)[1].status, "bound");
    assert.notEqual(result.seq, 2);
    assert.deepEqual(
        f.session.deriveMessages().find((message) => message.id === input.id).content,
        input.content,
    );
    assert.equal(
        f.session.eventAt(result.seq).data.message.content[0].text,
        "Unmodified generated reply",
    );
    const replay = Session.create(f.session.id, f.session.snapshotEvents(), f.session.header);
    assert.deepEqual(f.engine.state(replay).numbering, f.engine.state(f.session).numbering);
});

test("rejected and empty initial steps consume no numbers and append no declaration", async (t) => {
    const f = await fixture();
    t.after(f.close);
    const before = f.session.seq;
    assert.deepEqual(await propose(f, [user("Rejected")], 1, { kind: "reject" }), {
        kind: "reject",
    });
    const empty = await propose(f, []);
    assert.deepEqual(empty.messages, []);
    await f.ctx.systemPrompt.assemble({ scope: f.agent });
    await f.ctx.systemPrompt.assemble({ scope: f.agent });
    assert.equal(f.session.seq, before);
    assert.equal(f.engine.state(f.session).numbering.nextNumber, 1);
});

test("only ordinary admitted inputs consume typed IDs before the assistant reservation", async (t) => {
    const f = await fixture();
    t.after(f.close);
    const snapshot = createUserMessage({
        source: {
            kind: "runtime-context",
            form: "snapshot",
            sections: [{ name: "other-plugin", text: "existing contribution" }],
        },
        content: [{ type: "text", text: "Existing runtime context" }],
    });
    const messages = [user("First"), snapshot, user("Second")];
    const decision = await propose(f, messages);
    assert.deepEqual(decision.messages.slice(0, 3), messages);
    assert.equal(decision.messages[1], snapshot);
    assert.equal(decision.messages.at(-1).source.allocation.assistantId, "§A3§");
    commit(f, decision);
    assert.deepEqual(
        slots(f).map((slot) => slot.id),
        ["§U1§", "§U2§", "§A3§"],
    );
    assert.equal(
        slots(f).some((slot) => slot.messageId === snapshot.id),
        false,
    );
});

test("failed attempts retain the reservation and retry binds the same typed ID exactly once", async (t) => {
    const f = await fixture();
    t.after(f.close);
    commit(f, await propose(f, [user("Retry test")]));
    f.session.append("assistant/attempt", { turn: 1, step: 1, stream: [] });
    f.session.append("assistant/attempt", { turn: 1, step: 1, stream: [] });
    assert.equal(slots(f)[1].status, "reserved");
    assert.equal(f.engine.state(f.session).numbering.nextNumber, 3);
    appendAssistant(f, [{ type: "text", text: "Succeeded after retries" }]);
    f.session.append("step/end", { turn: 1, step: 1 });
    assert.equal(slots(f)[1].id, "§A2§");
    assert.equal(slots(f)[1].status, "bound");
    assert.equal(
        f.session
            .snapshotEvents()
            .filter(
                (event) =>
                    event.type === "user/message" && event.data.source.kind === ALLOCATION_SOURCE,
            ).length,
        1,
    );
});

test("empty cancellation abandons the ID permanently; interrupted visible output binds it", async (t) => {
    const f = await fixture();
    t.after(f.close);
    commit(f, await propose(f, [user("Cancel test")]));
    f.session.append("assistant/attempt", { turn: 1, step: 1, stream: [] });
    f.session.append("step/end", { turn: 1, step: 1 });
    assert.equal(slots(f)[1].status, "abandoned");
    const next = await propose(f, [], 2);
    assert.equal(next.messages.at(-1).source.allocation.assistantId, "§A3§");
    commit(f, next, 2);
    appendAssistant(f, [{ type: "text", text: "Partial visible reply" }], 2, true);
    f.session.append("step/end", { turn: 1, step: 2 });
    assert.equal(slots(f)[2].status, "bound");
    assert.equal(slots(f)[1].status, "abandoned");
});

test("tool results are allocated in assistant call order before execution and bind by call provenance", async (t) => {
    const f = await fixture();
    t.after(f.close);
    commit(f, await propose(f, [user("Run two tools")]));
    const owner = appendAssistant(f, [
        { type: "tool-call", id: "alpha", name: "read", arguments: "{}" },
        { type: "tool-call", id: "beta", name: "grep", arguments: "{}" },
    ]);
    assert.deepEqual(
        slots(f)
            .slice(2)
            .map((slot) => [slot.id, slot.callId, slot.status, slot.reservationSeq]),
        [
            ["§T3§", "alpha", "reserved", owner.seq],
            ["§T4§", "beta", "reserved", owner.seq],
        ],
    );
    const alpha = f.session.append("tool/call", {
        turn: 1,
        step: 1,
        callId: "alpha",
        name: "read",
        arguments: "{}",
    });
    const beta = f.session.append("tool/call", {
        turn: 1,
        step: 1,
        callId: "beta",
        name: "grep",
        arguments: "{}",
    });
    const b = appendResult(f, "beta", beta);
    const a = appendResult(f, "alpha", alpha);
    assert.equal(f.idFor(a), "§T3§");
    assert.equal(f.idFor(b), "§T4§");
    assert.deepEqual(
        slots(f)
            .slice(2)
            .map((slot) => slot.status),
        ["bound", "bound"],
    );
    assert.equal(f.engine.state(f.session).numbering.nextNumber, 5);
    f.session.append("step/end", { turn: 1, step: 1 });
    await f.invoke("context_release", { ids: ["§T3§"], reason: "Consumed" });
    assert.ok(await f.engine.compactNow(f.agent, signal()));
    assert.equal(
        f.engine.state(f.session).entries.find((entry) => entry.id === "§T3§").status,
        "released",
    );
    assert.equal(
        slots(f).find((slot) => slot.id === "§T3§").currentSeq,
        f.engine.state(f.session).entries.find((entry) => entry.id === "§T3§").currentSeq,
    );
    assert.equal(f.session.eventAt(a.seq).data.message.content[0].text, "Result ".repeat(1000));
    const records = f.calls[0].messages.flatMap((message) =>
        message.content
            .filter((block) => block.type === "text" && block.text.startsWith("{"))
            .map((block) => JSON.parse(block.text)),
    );
    assert.equal(
        records.some((record) => record.callId === "alpha"),
        false,
    );
    assert.equal(
        records.some(
            (record) =>
                record.callId === "beta" &&
                record.role === "tool" &&
                record.text === "Result ".repeat(1000),
        ),
        true,
    );
    assert.deepEqual(
        records.filter((record) => record.type === "tool-call").map((record) => record.callId),
        ["beta"],
    );
    assert.equal(
        f.engine.state(f.session).entries.find((entry) => entry.id === "§T4§").status,
        "summarized",
    );
});

test("actual recovery closers bind both started and unstarted tool reservations without lifecycle hooks", async (t) => {
    const f = await fixture();
    t.after(f.close);
    f.session.append("turn/start", { turn: 1 });
    commit(f, await propose(f, [user("Recover pending tools")]));
    appendAssistant(f, [
        { type: "tool-call", id: "started", name: "read", arguments: "{}" },
        { type: "tool-call", id: "unstarted", name: "grep", arguments: "{}" },
    ]);
    f.session.append("tool/call", {
        turn: 1,
        step: 1,
        callId: "started",
        name: "read",
        arguments: "{}",
    });
    const log = f.session.snapshotEvents();
    const closers = interruptedTurnClosers(log);
    const repaired = [...log, ...closers];
    const recovered = Session.create(f.session.id, repaired, f.session.header);
    const restored = f.engine.state(recovered);
    assert.deepEqual(
        restored.numbering.slots.slice(2).map((slot) => [slot.id, slot.callId, slot.status]),
        [
            ["§T3§", "started", "bound"],
            ["§T4§", "unstarted", "bound"],
        ],
    );
    assert.deepEqual(
        restored.entries
            .filter((entry) => entry.role === "tool")
            .map((entry) => [entry.id, entry.tool]),
        [
            ["§T3§", "read"],
            ["§T4§", "grep"],
        ],
    );
    assert.deepEqual(
        closers
            .filter((event) => event.type === "tool/result")
            .map((event) => event.data.error.code),
        ["TOOL_OUTCOME_UNKNOWN", "TOOL_NOT_STARTED"],
    );
    assert.equal(restored.numbering.nextNumber, 5);
});

test("resume and fork abandon orphan assistant reservations without recycling or changing originals", async (t) => {
    const f = await fixture();
    t.after(f.close);
    commit(f, await propose(f, [user("Orphan reservation")]));
    const log = f.session.snapshotEvents();
    for (const header of [
        f.session.header,
        { ...f.session.header, id: "numbering-fork", isSeeded: true, parentSession: f.session.id },
    ]) {
        const recovered = Session.create(header.id, log, header, header.isSeeded ? log.length : 0);
        const numbering = f.engine.state(recovered).numbering;
        assert.equal(numbering.slots[1].id, "§A2§");
        assert.equal(numbering.slots[1].status, "abandoned");
        assert.equal(numbering.nextNumber, 3);
        assert.equal(
            recovered.eventAt(
                log.find(
                    (event) =>
                        event.type === "user/message" &&
                        event.data.source.kind === ALLOCATION_SOURCE,
                ).seq,
            ).data.source.allocation.assistantId,
            "§A2§",
        );
    }
    assert.equal(slots(f)[1].status, "reserved");
});

test("conversation IDs reject a mixed batch while tool results remain individually releasable", async (t) => {
    const f = await fixture();
    t.after(f.close);
    const first = f.appendUser("Consumed user input ".repeat(1000));
    const result = f.toolRound("read", "Evidence ".repeat(1000));
    const userId = f.idFor(first);
    const toolId = f.idFor(result);
    const protocolId = slots(f).find((slot) => slot.role === "assistant").id;
    const rejected = await f.invoke("context_release", {
        ids: [protocolId, toolId],
        reason: "Unsupported protocol-only body",
    });
    assert.equal(rejected.isError, false);
    assert.equal(rejected.value.accepted, false);
    assert.deepEqual(rejected.value.unsupported, [protocolId]);
    assert.equal(
        f.engine.state(f.session).entries.find((entry) => entry.id === toolId).status,
        "available",
    );
    const status = await f.invoke("context_status", { ids: [userId] });
    assert.equal(status.value.numbers[0].role, "user");
    assert.equal(status.value.numbers[0].releasable, false);
    assert.equal(status.value.entries.length, 1);
    const accepted = await f.invoke("context_release", {
        ids: [userId, toolId],
        reason: "Consumed bodies",
    });
    assert.equal(accepted.value.accepted, false);
    assert.deepEqual(accepted.value.unsupported, [userId]);
    assert.equal(
        f.engine.state(f.session).entries.find((entry) => entry.id === toolId).status,
        "available",
    );
    assert.equal(
        (await f.invoke("context_release", { ids: [toolId], reason: "Consumed tool output" })).value
            .accepted,
        true,
    );
    assert.equal(await f.engine.compactIfNeeded(f.agent, "pressure", signal()), null);
    assert.equal(
        f.engine.state(f.session).entries.find((entry) => entry.id === toolId).status,
        "released",
    );
    assert.equal(
        f.engine.state(f.session).entries.find((entry) => entry.id === userId).status,
        "available",
    );
    assert.ok(f.session.surface.nodes.includes(first.seq));
    assert.deepEqual(f.session.eventAt(first.seq).data.content, first.data.content);
    for (const id of ["c42", "42", "§0§", "§01§", "§-1§", "§42", "§42§", "§T0§", "§A01§", "§X1§"]) {
        const invalid = await f.invoke("context_release", { ids: [id], reason: "Invalid marker" });
        assert.equal(invalid.isError, true);
    }
});

test("numbering checkpoints are JSON, bounded in model views, and independent between sessions", async (t) => {
    const f = await fixture();
    t.after(f.close);
    commit(f, await propose(f, [user("Deterministic log")]));
    appendAssistant(f, [{ type: "text", text: "Output" }]);
    const other = f.sessions.create();
    assert.equal(f.engine.state(other).numbering.nextNumber, 1);
    assert.deepEqual(f.engine.state(other).numbering.slots, []);
    let state = ledgerProjection.init(f.session.header, 0);
    for (const event of f.session.snapshotEvents()) state = ledgerProjection.apply(state, event);
    assert.deepEqual(state, f.engine.state(f.session));
    assert.deepEqual(JSON.parse(JSON.stringify(state)), state);
    assert.equal(ledgerProjection.stateSchema.safeParse(state).success, true);
    f.session.append("step/end", { turn: 1, step: 1 });
    const view = await f.invoke("context_status", { limit: 1 });
    assert.equal(view.value.numbers.length, 1);
    assert.ok(view.value.numbersOmitted > 0);
});
