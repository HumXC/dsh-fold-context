import test from "node:test";
import assert from "node:assert/strict";
import { createAssistantMessage, createUserMessage } from "@deepseek-ai/dsh-llm";
import { fixture } from "./fixture.mjs";
import { ALLOCATION_SOURCE } from "../lib/domain/numbering.js";

const input = (kind, text, form) =>
    createUserMessage({
        source: { kind, ...(form === undefined ? {} : { form }) },
        content: [{ type: "text", text }],
    });
const propose = (f, messages, step, signal = new AbortController().signal) =>
    f.ctx.waterfall(
        "agent/pre-step",
        { agent: f.agent, messages, turn: 1, step, signal },
        async () => ({ kind: "enter", messages, startsRequestSeries: true }),
    );
async function commit(f, decision, step) {
    f.advanceSteps(step);
    f.session.append("step/start", { turn: 1, step });
    await f.ctx.waterfall(
        "agent/request",
        { agent: f.agent, turn: 1, step, signal: new AbortController().signal },
        async () => ({ provider: "test", model: "fixture" }),
    );
    for (const message of decision.messages)
        f.session.append("user/message", message, { surfaceOp: "append" });
    f.session.append(
        "assistant/message",
        {
            turn: 1,
            step,
            message: createAssistantMessage({
                source: { provider: "test", model: "fixture" },
                content: [{ type: "text", text: "Continue the work." }],
            }),
            stream: [],
        },
        { surfaceOp: "append" },
    );
    f.session.append("step/end", { turn: 1, step });
    return f.engine.state(f.session).numbering;
}
const textOf = (message) => message.content.map((block) => block.text ?? "").join("");

test("outer instructions, skills and memory are declared by one independent notice", async (t) => {
    const f = await fixture();
    t.after(f.close);
    const user = input("user", "Continue the project.");
    const instructions = input(
        "agent-instructions",
        "Preserve active requirements.",
        "instructions",
    );
    const runtime = input("runtime-context", "Current file policy.", "snapshot");
    const catalog = input("skill-catalog", "Available skills.", "catalog");
    const reminder = input("dsh-mnemon", "Memory handling instructions.", "instructions");
    const memory = input("dsh-mnemon", "Latest project progress.", "recall");
    f.ctx.on("agent/pre-step", async (_payload, next) => {
        const decision = await next();
        return { ...decision, messages: [...decision.messages, catalog] };
    });
    f.ctx.on(
        "agent/pre-step",
        async (_payload, next) => {
            const decision = await next();
            return { ...decision, messages: [...decision.messages, reminder, memory] };
        },
        { prepend: true },
    );
    f.ctx.on(
        "agent/pre-step",
        async (_payload, next) => {
            const decision = await next();
            const index = decision.messages.findIndex((message) => message.id === user.id);
            return {
                ...decision,
                messages: decision.messages.toSpliced(index + 1, 0, instructions),
            };
        },
        { prepend: true },
    );
    const decision = await propose(f, [user, runtime], 1);
    assert.equal(decision.startsRequestSeries, true);
    assert.deepEqual(
        decision.messages.map((message) => message.source.kind),
        [
            "user",
            "agent-instructions",
            "runtime-context",
            "skill-catalog",
            "dsh-mnemon",
            "dsh-mnemon",
            ALLOCATION_SOURCE,
        ],
    );
    const numbered = decision.messages.filter(
        (message) =>
            message.source.kind !== "runtime-context" && message.source.kind !== ALLOCATION_SOURCE,
    );
    assert.deepEqual(numbered, [user, instructions, catalog, reminder, memory]);
    assert.equal(textOf(decision.messages.at(-1)), "prev: 1 2 3 4 5\nnext: 6");
    assert.equal(decision.messages[2], runtime);
    assert.equal(textOf(user), "Continue the project.", "the caller-owned input is untouched");
    assert.equal(
        f.session.deriveMessages().length,
        0,
        "empty developer bookkeeping has no model message",
    );
    assert.equal(
        f.session.snapshotEvents().some((event) => event.type === "developer/message"),
        false,
    );
    const numbering = await commit(f, decision, 1);
    assert.ok(
        f.session
            .snapshotEvents()
            .some(
                (event) =>
                    event.type === "user/message" && event.data.source.kind === ALLOCATION_SOURCE,
            ),
    );
    assert.deepEqual(
        numbering.slots.map((slot) => slot.id),
        ["1", "2", "3", "4", "5", "6"],
    );
    assert.ok(numbering.slots.every((slot) => slot.status === "bound"));
});

test("hooks added between steps are declared once without repeating a bound assistant ID", async (t) => {
    const f = await fixture();
    t.after(f.close);
    await commit(f, await propose(f, [input("user", "Continue.")], 1), 1);
    let injections = 0;
    f.ctx.on(
        "agent/pre-step",
        async ({ step }, next) => {
            const decision = await next();
            injections++;
            return {
                ...decision,
                messages: [
                    ...decision.messages,
                    input("dsh-mnemon", `Memory update ${step}.`, "recall"),
                ],
            };
        },
        { prepend: true },
    );
    for (let step = 2; step <= 4; step++) {
        const decision = await propose(f, [], step);
        assert.equal(decision.messages.length, 2);
        assert.equal(decision.messages[0].source.kind, "dsh-mnemon");
        assert.equal(textOf(decision.messages[0]), `Memory update ${step}.`);
        assert.equal(decision.messages[1].source.kind, ALLOCATION_SOURCE);
        assert.equal(textOf(decision.messages[1]), `prev: ${2 * step - 1}\nnext: ${2 * step}`);
        assert.equal((await commit(f, decision, step)).nextNumber, 2 * step + 1);
    }
    assert.equal(injections, 3);
});

test("cancellation after an injection cannot publish stale numbering or bookkeeping", async (t) => {
    const f = await fixture();
    t.after(f.close);
    const controller = new AbortController();
    f.ctx.on(
        "agent/pre-step",
        async (_payload, next) => {
            const decision = await next();
            controller.abort();
            return {
                ...decision,
                messages: [...decision.messages, input("skill-catalog", "Skills.", "catalog")],
            };
        },
        { prepend: true },
    );
    const before = f.session.seq;
    await assert.rejects(propose(f, [input("user", "Cancelled input.")], 1, controller.signal), {
        name: "AbortError",
    });
    assert.equal(f.session.seq, before);
    assert.equal(f.engine.state(f.session).numbering.nextNumber, 1);
});

test("re-admission refreshes one notice and archival recovery preserves literal ID-like text", async (t) => {
    const f = await fixture();
    t.after(f.close);
    const business = "Keep the literal [§U1§] and §T9R§ in this code. 🧠é\n  exact whitespace.\n";
    const first = await propose(f, [input("user", business)], 1);
    const repeated = await propose(f, first.messages, 1);
    assert.equal(repeated.messages.length, 2);
    assert.equal(repeated.messages[0], first.messages[0]);
    assert.deepEqual(repeated.messages[1].source.allocation, first.messages[1].source.allocation);
    assert.equal(textOf(repeated.messages[1]), textOf(first.messages[1]));
    assert.equal(repeated.messages[0].content.length, 1);
    const prepended = input("agent-instructions", "Updated instructions.");
    const reordered = await propose(f, [prepended, ...repeated.messages], 1);
    assert.deepEqual(
        reordered.messages.map((message) => message.content[0].text),
        ["Updated instructions.", business, "prev: 1 2\nnext: 3"],
    );
    assert.deepEqual(reordered.messages[1].source, first.messages[0].source);
    await commit(f, reordered, 1);
    const expanded = await f.invoke("context_expand", { id: 2 });
    assert.equal(expanded.isError, false);
    const page = JSON.parse(expanded.content[0].text);
    assert.equal(page.format, "text");
    assert.equal(page.text, business);
});
