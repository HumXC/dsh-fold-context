import test from "node:test";
import assert from "node:assert/strict";
import { Session, interruptedTurnClosers } from "@deepseek-ai/dsh-session";
import {
    createAssistantMessage,
    createToolResultMessage,
    createUserMessage,
} from "@deepseek-ai/dsh-llm";
import { fixture } from "./fixture.mjs";
import { commitForcedReleases } from "./release-batch-fixture.mjs";
import { ALLOCATION_SOURCE, foldNumbering } from "../lib/domain/numbering.js";
import { ledgerProjection } from "../lib/domain/ledger.js";

const signal = () => new AbortController().signal;
const user = (text) =>
    createUserMessage({ source: { kind: "user" }, content: [{ type: "text", text }] });
const slots = (f) => f.engine.state(f.session).numbering.slots;
const noticeOf = (decision) =>
    decision.messages.find((message) => message.source.kind === ALLOCATION_SOURCE);
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
async function commit(f, decision, step = 1) {
    f.advanceSteps(step);
    f.session.append("step/start", { turn: 1, step });
    await f.ctx.waterfall(
        "agent/request",
        { agent: f.agent, turn: 1, step, signal: signal() },
        async () => ({ provider: "test", model: "fixture" }),
    );
    for (const message of decision.messages)
        f.session.append("user/message", message, { surfaceOp: "append" });
}
function appendAssistant(f, content, step = 1, interrupted = false) {
    return f.session.append(
        "assistant/message",
        {
            turn: 1,
            step,
            message: createAssistantMessage({
                source: { provider: "test", model: "fixture" },
                content,
            }),
            stream: [],
            ...(interrupted ? { interrupted: true } : {}),
        },
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

test("cancellation before admission appends nothing and consumes no allocation", async (t) => {
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

test("a changed admitted input cannot bind a notice planned for another message", async (t) => {
    const f = await fixture();
    t.after(f.close);
    const decision = await propose(f, [user("Planned input")]);
    const notice = noticeOf(decision);
    const replacement = f.appendUser("Another middleware replaced the input");
    assert.throws(
        () =>
            foldNumbering(f.engine.state(f.session).numbering, {
                ...replacement,
                data: notice,
            }),
        /allocation does not match admitted inputs/,
    );
    assert.equal(f.engine.state(f.session).numbering.nextNumber, 2);
});

test("official summary removes live bindings while retaining original numeric IDs", async (t) => {
    const f = await fixture();
    t.after(f.close);
    const input = f.appendUser("Important goal ".repeat(1000));
    const result = f.toolRound("read", "Old evidence ".repeat(1000));
    f.toolRound("grep", "Recent evidence ".repeat(1000));
    const originalIds = slots(f).map((slot) => slot.id);
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

test("filtered later-step input stays empty and cannot manufacture a request", async (t) => {
    const f = await fixture();
    t.after(f.close);
    f.appendUser("A completed earlier step");
    f.toolRound("read", "Earlier evidence");
    const before = f.session.seq;
    const nextNumber = f.engine.state(f.session).numbering.nextNumber;
    const accepted = { kind: "enter", messages: [], startsRequestSeries: true };
    const result = await propose(f, [user("Filtered next-step input")], 2, accepted);
    assert.equal(result, accepted);
    assert.deepEqual(result.messages, []);
    assert.equal(f.session.seq, before);
    assert.equal(f.engine.state(f.session).numbering.nextNumber, nextNumber);
});

test("input-free continuation announces results and reserves its next assistant", async (t) => {
    const f = await fixture();
    t.after(f.close);
    f.appendUser("Read then continue");
    f.toolRound("read", "Tool evidence");
    const decision = await propose(f, [], 2);
    assert.equal(decision.messages.length, 1);
    assert.equal(noticeOf(decision).content[0].text, "prev: 1 2 3\nnext: 4");
    assert.equal(f.engine.state(f.session).numbering.nextNumber, 4);
    await commit(f, decision, 2);
    assert.equal(slots(f).at(-1).id, "4");
    assert.equal(slots(f).at(-1).status, "reserved");
});

test("admission preserves raw bodies and a bound next ID is never repeated in prev", async (t) => {
    const f = await fixture();
    t.after(f.close);
    const input = user("Original user body");
    const first = await propose(f, [input]);
    const preview = await propose(f, [input]);
    assert.equal(f.engine.state(f.session).numbering.nextNumber, 1);
    assert.equal(first.startsRequestSeries, true);
    assert.equal(first.messages[0], input);
    assert.deepEqual(input.content, [{ type: "text", text: "Original user body" }]);
    assert.equal(noticeOf(first).content[0].text, "prev: 1\nnext: 2");
    assert.deepEqual(noticeOf(preview).source.allocation, noticeOf(first).source.allocation);
    await commit(f, first);
    assert.deepEqual(
        slots(f).map((slot) => [slot.id, slot.role, slot.status]),
        [
            ["1", "user", "bound"],
            ["2", "assistant", "reserved"],
        ],
    );
    const result = appendAssistant(f, [{ type: "text", text: "Unmodified generated reply" }]);
    const bytes = JSON.stringify(result.data);
    assert.equal(slots(f)[1].sourceSeq, result.seq);
    assert.equal(slots(f)[1].status, "bound");
    assert.deepEqual(
        f.session.deriveMessages().find((message) => message.id === input.id).content,
        input.content,
    );
    f.session.append("step/end", { turn: 1, step: 1 });
    const continuation = await propose(f, [], 2);
    assert.equal(noticeOf(continuation).content[0].text, "next: 3");
    assert.equal(JSON.stringify(f.session.eventAt(result.seq).data), bytes);
    const replay = Session.create(f.session.id, f.session.snapshotEvents(), f.session.header);
    assert.deepEqual(f.engine.state(replay).numbering, f.engine.state(f.session).numbering);
});

test("rejected and empty initial steps append no declaration or reservation", async (t) => {
    const f = await fixture();
    t.after(f.close);
    const before = f.session.seq;
    assert.deepEqual(await propose(f, [user("Rejected")], 1, { kind: "reject" }), {
        kind: "reject",
    });
    assert.deepEqual((await propose(f, [])).messages, []);
    await f.ctx.systemPrompt.assemble({ scope: f.agent });
    await f.ctx.systemPrompt.assemble({ scope: f.agent });
    assert.equal(f.session.seq, before);
    assert.equal(f.engine.state(f.session).numbering.nextNumber, 1);
});

test("ordinary inputs alone consume IDs and the notice follows the complete batch", async (t) => {
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
    assert.equal(decision.messages.length, 4);
    assert.equal(noticeOf(decision), decision.messages.at(-1));
    assert.equal(noticeOf(decision).content[0].text, "prev: 1 2\nnext: 3");
    await commit(f, decision);
    assert.deepEqual(
        slots(f).map((slot) => slot.id),
        ["1", "2", "3"],
    );
    assert.equal(
        slots(f).some(
            (slot) => slot.messageId === snapshot.id || slot.messageId === noticeOf(decision).id,
        ),
        false,
    );
});

test("failed attempts retain their reservation and retry binds it once", async (t) => {
    const f = await fixture();
    t.after(f.close);
    await commit(f, await propose(f, [user("Retry test")]));
    f.session.append("assistant/attempt", { turn: 1, step: 1, stream: [] });
    f.session.append("assistant/attempt", { turn: 1, step: 1, stream: [] });
    assert.equal(slots(f)[1].status, "reserved");
    assert.equal(f.engine.state(f.session).numbering.nextNumber, 3);
    appendAssistant(f, [{ type: "text", text: "Succeeded after retries" }]);
    f.session.append("step/end", { turn: 1, step: 1 });
    assert.equal(slots(f)[1].id, "2");
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

test("cancellation leaves a permanent gap and interrupted visible output binds its reservation", async (t) => {
    const f = await fixture();
    t.after(f.close);
    await commit(f, await propose(f, [user("Cancel test")]));
    f.session.append("assistant/attempt", { turn: 1, step: 1, stream: [] });
    f.session.append("step/end", { turn: 1, step: 1 });
    assert.equal(slots(f)[1].status, "abandoned");
    const next = await propose(f, [], 2);
    assert.equal(noticeOf(next).content[0].text, "next: 3");
    await commit(f, next, 2);
    appendAssistant(f, [{ type: "text", text: "Partial visible reply" }], 2, true);
    f.session.append("step/end", { turn: 1, step: 2 });
    assert.equal(slots(f)[2].status, "bound");
    assert.equal(slots(f)[1].status, "abandoned");
});

test("grouped tool results reserve in call order and bind by provenance despite reversed completion", async (t) => {
    const f = await fixture();
    t.after(f.close);
    await commit(f, await propose(f, [user("Run two tools")]));
    const owner = appendAssistant(f, [
        { type: "tool-call", id: "alpha", name: "read", arguments: "{}" },
        { type: "tool-call", id: "beta", name: "grep", arguments: "{}" },
    ]);
    assert.deepEqual(
        slots(f)
            .slice(2)
            .map((slot) => [slot.id, slot.callId, slot.status, slot.reservationSeq]),
        [
            ["3", "alpha", "reserved", owner.seq],
            ["4", "beta", "reserved", owner.seq],
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
    assert.equal(f.idFor(a), "3");
    assert.equal(f.idFor(b), "4");
    assert.deepEqual(
        slots(f)
            .slice(2)
            .map((slot) => slot.status),
        ["bound", "bound"],
    );
    assert.equal(f.engine.state(f.session).numbering.nextNumber, 5);
    f.session.append("step/end", { turn: 1, step: 1 });
    const decision = await propose(f, [], 2);
    assert.equal(noticeOf(decision).content[0].text, "prev: 4 3\nnext: 5");
    assert.equal(decision.messages.length, 1);
    assert.equal(f.session.eventAt(a.seq).data.message.content[0].text, "Result ".repeat(1000));
    await f.invoke("context_release", { ids: [3], reason: "Consumed" });
    assert.ok(await f.engine.compactNow(f.agent, signal()));
    assert.equal(
        f.engine.state(f.session).entries.find((entry) => entry.id === "3").status,
        "released",
    );
    const records = f.calls[0].messages.flatMap((message) =>
        message.content
            .filter((block) => block.type === "text" && block.text.startsWith("{"))
            .map((block) => JSON.parse(block.text)),
    );
    assert.equal(
        records.some((record) => record.callId === "alpha"),
        false,
    );
    assert.ok(
        records.some(
            (record) =>
                record.callId === "beta" &&
                record.role === "tool" &&
                record.text === "Result ".repeat(1000),
        ),
    );
    assert.deepEqual(
        records.filter((record) => record.type === "tool-call").map((record) => record.callId),
        ["beta"],
    );
});

test("recovery closers bind both started and unstarted tool reservations", async (t) => {
    const f = await fixture();
    t.after(f.close);
    f.session.append("turn/start", { turn: 1 });
    await commit(f, await propose(f, [user("Recover pending tools")]));
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
    const restored = f.engine.state(
        Session.create(f.session.id, [...log, ...closers], f.session.header),
    );
    assert.deepEqual(
        restored.numbering.slots.slice(2).map((slot) => [slot.id, slot.callId, slot.status]),
        [
            ["3", "started", "bound"],
            ["4", "unstarted", "bound"],
        ],
    );
    assert.deepEqual(
        restored.entries
            .filter((entry) => entry.role === "tool")
            .map((entry) => [entry.id, entry.tool]),
        [
            ["3", "read"],
            ["4", "grep"],
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

test("resume and fork abandon orphan reservations without recycling or changing the notice", async (t) => {
    const f = await fixture();
    t.after(f.close);
    await commit(f, await propose(f, [user("Orphan reservation")]));
    const log = f.session.snapshotEvents();
    for (const header of [
        f.session.header,
        { ...f.session.header, id: "numbering-fork", isSeeded: true, parentSession: f.session.id },
    ]) {
        const recovered = Session.create(header.id, log, header, header.isSeeded ? log.length : 0);
        const numbering = f.engine.state(recovered).numbering;
        assert.equal(numbering.slots[1].id, "2");
        assert.equal(numbering.slots[1].status, "abandoned");
        assert.equal(numbering.nextNumber, 3);
        assert.ok(
            recovered
                .snapshotEvents()
                .some(
                    (event) =>
                        event.type === "user/message" &&
                        event.data.source.kind === ALLOCATION_SOURCE &&
                        event.data.source.allocation.assistantId === "2",
                ),
        );
    }
    assert.equal(slots(f)[1].status, "reserved");
});

test("conversation IDs reject a mixed batch while numeric tool IDs are individually releasable", async (t) => {
    const f = await fixture();
    t.after(f.close);
    const first = f.appendUser("Consumed user input ".repeat(1000));
    const result = f.toolRound("read", "Evidence ".repeat(1000));
    const userId = f.idFor(first);
    const toolId = f.idFor(result);
    const protocolId = slots(f).find((slot) => slot.role === "assistant").id;
    for (const protectedId of [protocolId, userId]) {
        const rejected = await f.invoke("context_release", {
            ids: [Number(protectedId), Number(toolId)],
            reason: "Consumed bodies",
        });
        assert.equal(rejected.isError, false);
        assert.equal(rejected.value.accepted, false);
        assert.deepEqual(rejected.value.unsupported, [protectedId]);
        assert.equal(
            f.engine.state(f.session).entries.find((entry) => entry.id === toolId).status,
            "available",
        );
    }
    const status = await f.invoke("context_status", { ids: [Number(userId)] });
    assert.equal(status.value.numbers[0].role, "user");
    assert.equal(status.value.numbers[0].releasable, false);
    assert.equal(
        (
            await f.invoke("context_release", {
                ids: [Number(toolId)],
                reason: "Consumed tool output",
            })
        ).value.accepted,
        true,
    );
    await commitForcedReleases(f);
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
    for (const invalidId of ["3", "§T3§", "3R", 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
        assert.equal(
            (await f.invoke("context_release", { ids: [invalidId], reason: "Invalid identifier" }))
                .isError,
            true,
        );
    }
});

test("numbering state is JSON, bounded through status, and independent between sessions", async (t) => {
    const f = await fixture();
    t.after(f.close);
    await commit(f, await propose(f, [user("Deterministic log")]));
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
