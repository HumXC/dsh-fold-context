import test from "node:test";
import assert from "node:assert/strict";
import { createAssistantMessage, createToolResultMessage } from "@deepseek-ai/dsh-llm";
import { fixture } from "./fixture.mjs";

const boundary = (f) => f.engine.compactIfNeeded(f.agent, "pressure", new AbortController().signal);
const visible = (f, event) => f.session.surface.nodes.includes(event.seq);
const notices = (f) =>
    f.session.surface.nodes
        .map((seq) => f.session.eventAt(seq))
        .filter(
            (event) =>
                event.type === "user/message" &&
                event.data.source.kind === "fold-context-release-cleanup",
        );
const controls = (f) =>
    f.session
        .snapshotEvents()
        .filter(
            (event) =>
                event.type === "assistant/message" &&
                event.data.message.content.some(
                    (block) => block.type === "tool-call" && block.name === "context_release",
                ),
        );

async function release(f, id, ids = [id]) {
    const outcome = await f.invoke("context_release", {
        ids,
        reason: "Evidence retained in conclusions",
    });
    assert.equal(outcome.isError, false);
    const assistant = controls(f).at(-1);
    const call = assistant.data.message.content.find((block) => block.type === "tool-call");
    const result = f.session
        .snapshotEvents()
        .findLast(
            (event) => event.type === "tool/result" && event.data.message.source.callId === call.id,
        );
    return { assistant, result, value: JSON.parse(outcome.content[0].text) };
}

function protectedControl(f, id, signed) {
    const step =
        1 +
        Math.max(
            0,
            ...f.session
                .snapshotEvents()
                .filter((event) => event.type === "step/start")
                .map((event) => event.data.step),
        );
    f.advanceSteps(step);
    const callId = `protected-release-${step}`;
    f.session.append("step/start", { turn: 1, step });
    const assistant = f.session.append(
        "assistant/message",
        {
            turn: 1,
            step,
            stream: [],
            message: createAssistantMessage({
                source: {
                    provider: "test",
                    model: "fixture",
                    ...(signed ? { replayState: { opaque: "retain signed control bytes" } } : {}),
                },
                content: [
                    ...(!signed
                        ? [{ type: "text", text: "A preserved explanation beside management." }]
                        : []),
                    {
                        type: "tool-call",
                        id: callId,
                        name: "context_release",
                        arguments: JSON.stringify({ ids: [id], reason: "Already consumed" }),
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
        name: "context_release",
        arguments: JSON.stringify({ ids: [id], reason: "Already consumed" }),
    });
    const value = {
        accepted: true,
        unknown: [],
        unsupported: [],
        queued: [],
        settled: [id],
        dshContextCompression: null,
    };
    const result = f.session.append(
        "tool/result",
        {
            turn: 1,
            step,
            meta: value,
            message: createToolResultMessage({
                callId,
                content: [{ type: "text", text: JSON.stringify(value) }],
                isError: false,
            }),
        },
        { surfaceOp: "append", sourceEventSeqs: [call.seq] },
    );
    f.session.append("step/end", { turn: 1, step });
    return { assistant, result };
}

test("an existing inline rewrite cleans older completed release pairs and retains the latest two", async (t) => {
    const f = await fixture();
    t.after(f.close);
    const goal = f.appendUser("Preserve this user objective and all substantive replies.");
    const targets = Array.from({ length: 4 }, (_, index) =>
        f.toolRound("read", `EVIDENCE_${index} `.repeat(300)),
    );
    const rounds = [];
    for (const target of targets) {
        rounds.push(await release(f, f.idFor(target)));
        await boundary(f);
    }
    for (const round of rounds.slice(0, -2)) {
        assert.equal(visible(f, round.assistant), false);
        assert.equal(visible(f, round.result), false);
    }
    for (const round of rounds.slice(-2)) {
        assert.equal(visible(f, round.assistant), true);
        assert.equal(visible(f, round.result), true);
    }
    assert.equal(notices(f).length, 2);
    assert.ok(notices(f).every((event) => JSON.stringify(event.data.content).length < 256));
    assert.ok(visible(f, goal));
    assert.deepEqual(f.session.eventAt(goal.seq).data.content, goal.data.content);
    for (const round of rounds) {
        assert.deepEqual(f.session.eventAt(round.assistant.seq), round.assistant);
        assert.deepEqual(f.session.eventAt(round.result.seq), round.result);
    }
    const live = f.session.deriveMessages();
    const calls = live.flatMap((message) =>
        message.content.filter((block) => block.type === "tool-call").map((block) => block.id),
    );
    const results = live
        .filter((message) => message.role === "tool")
        .map((message) => message.source.callId);
    assert.deepEqual(
        [...calls].sort(),
        [...results].sort(),
        "remaining native call/result pairs stay balanced",
    );
    const seq = f.session.seq;
    await boundary(f);
    assert.equal(f.session.seq, seq, "cleanup alone cannot trigger a second rewrite");
    assert.equal(f.calls.length, 0);
});

test("cleanup never moves the first changed prefix before the newly released evidence", async (t) => {
    const f = await fixture();
    t.after(f.close);
    const old = f.toolRound("read", "OLD_EVIDENCE ".repeat(300));
    const oldId = f.idFor(old);
    await release(f, oldId);
    await boundary(f);
    for (let index = 0; index < 3; index++) await release(f, oldId);
    const prefix = [...f.session.surface.nodes];
    const before = f.session.seq;
    await boundary(f);
    assert.equal(f.session.seq, before, "settled receipts do not initiate rewrites");
    const target = f.toolRound("read", "NEW_EVIDENCE ".repeat(300));
    await release(f, f.idFor(target));
    await boundary(f);
    assert.deepEqual(f.session.surface.nodes.slice(0, prefix.length), prefix);
    assert.equal(notices(f).length, 0);
    assert.ok(controls(f).every((event) => visible(f, event)));
});

test("a rejected release remains visible while eligible older success pairs are cleaned", async (t) => {
    const f = await fixture();
    t.after(f.close);
    const targets = Array.from({ length: 3 }, (_, index) =>
        f.toolRound("read", `FACT_${index} `.repeat(300)),
    );
    for (const target of targets.slice(0, 2)) {
        await release(f, f.idFor(target));
        await boundary(f);
    }
    const rejected = await release(f, f.idFor(targets[2]), [f.idFor(targets[2]), "§T999999§"]);
    assert.equal(rejected.value.accepted, false);
    await release(f, f.idFor(targets[2]));
    await boundary(f);
    assert.ok(notices(f).length > 0);
    assert.ok(visible(f, rejected.assistant));
    assert.ok(visible(f, rejected.result));
    assert.deepEqual(f.session.eventAt(rejected.result.seq), rejected.result);
});

for (const signed of [true, false]) {
    test(`${signed ? "signed provider" : "explanatory"} release records survive otherwise eligible receipt cleanup`, async (t) => {
        const f = await fixture();
        t.after(f.close);
        const targets = [
            f.toolRound("read", "FIRST ".repeat(300)),
            f.toolRound("read", "SECOND ".repeat(300)),
        ];
        const id = f.idFor(targets[0]);
        await release(f, id);
        await boundary(f);
        const protectedRound = protectedControl(f, id, signed);
        const bytes = JSON.stringify(protectedRound);
        for (let index = 0; index < 3; index++) await release(f, id);
        await release(f, f.idFor(targets[1]));
        await boundary(f);
        assert.ok(notices(f).length > 0);
        assert.ok(visible(f, protectedRound.assistant));
        assert.ok(visible(f, protectedRound.result));
        assert.equal(
            JSON.stringify({
                assistant: f.session.eventAt(protectedRound.assistant.seq),
                result: f.session.eventAt(protectedRound.result.seq),
            }),
            bytes,
        );
        assert.equal(f.calls.length, 0);
    });
}
