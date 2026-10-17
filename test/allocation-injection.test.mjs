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
function commit(f, decision, step) {
    f.advanceSteps(step);
    f.session.append("step/start", { turn: 1, step });
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

test("allocation includes instructions, skills and memory injected by outer middleware", async (t) => {
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
    const allocation = decision.messages.at(-1).source.allocation;
    assert.deepEqual(
        allocation.inputs,
        [user, instructions, catalog, reminder, memory].map((message, index) => ({
            messageId: message.id,
            id: `§U${index + 1}§`,
        })),
    );
    assert.equal(allocation.assistantId, "§A6§");
    const numbering = commit(f, decision, 1);
    assert.deepEqual(
        numbering.slots.map((slot) => slot.id),
        ["§U1§", "§U2§", "§U3§", "§U4§", "§U5§", "§A6§"],
    );
    assert.ok(numbering.slots.every((slot) => slot.status === "bound"));
    assert.equal(numbering.nextNumber, 7);
});

test("hooks added between steps are included without accumulating allocation notices", async (t) => {
    const f = await fixture();
    t.after(f.close);
    commit(f, await propose(f, [input("user", "Continue.")], 1), 1);
    let injections = 0;
    f.ctx.on(
        "agent/pre-step",
        async ({ step }, next) => {
            const decision = await next();
            injections += 1;
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
    for (let step = 2; step <= 4; step += 1) {
        const decision = await propose(f, [], step);
        assert.equal(
            decision.messages.filter((message) => message.source.kind === ALLOCATION_SOURCE).length,
            1,
        );
        const allocation = decision.messages.at(-1).source.allocation;
        assert.deepEqual(allocation.inputs, [
            { messageId: decision.messages[0].id, id: `§U${2 * step - 1}§` },
        ]);
        assert.equal(allocation.assistantId, `§A${2 * step}§`);
        assert.equal(commit(f, decision, step).nextNumber, 2 * step + 1);
    }
    assert.equal(injections, 3);
});

test("cancellation after an injection cannot publish a stale allocation", async (t) => {
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
