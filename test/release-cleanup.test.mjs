import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createAssistantMessage, createToolResultMessage } from "@deepseek-ai/dsh-llm";
import { assertTestRoot } from "./loop-fixture.mjs";
import { fixture } from "./fixture.mjs";
import { commitForcedReleases } from "./release-batch-fixture.mjs";

const signal = () => new AbortController().signal;
const visible = (f, event) => f.session.surface.nodes.includes(event.seq);
const nextStep = (f) =>
    1 +
    Math.max(
        0,
        ...f.session
            .snapshotEvents()
            .filter((event) => event.type === "step/start")
            .map((event) => event.data.step),
    );
const releaseCall = (ids, id = "release-test") => ({
    type: "tool-call",
    id,
    name: "context_release",
    arguments: JSON.stringify({ ids, reason: "Evidence retained in conclusions" }),
});
async function invoke(f, blocks, replayState) {
    const step = nextStep(f);
    f.advanceSteps(step);
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
                    ...(replayState === undefined ? {} : { replayState }),
                },
                content: blocks,
            }),
        },
        { surfaceOp: "append" },
    );
    const results = [];
    for (const block of blocks.filter((block) => block.type === "tool-call")) {
        f.session.append("tool/call", {
            turn: 1,
            step,
            callId: block.id,
            name: block.name,
            arguments: block.arguments,
        });
        const outcome = await f.ctx.tools.execute({
            name: block.name,
            arguments: JSON.parse(block.arguments),
            callId: block.id,
            agent: f.agent,
            signal: signal(),
        });
        const result = f.session.append(
            "tool/result",
            {
                turn: 1,
                step,
                message: createToolResultMessage({
                    callId: block.id,
                    content: outcome.content,
                    isError: outcome.isError,
                }),
                ...(outcome.meta === undefined ? {} : { meta: outcome.meta }),
            },
            { surfaceOp: "append" },
        );
        results.push({ result, outcome });
    }
    f.session.append("step/end", { turn: 1, step });
    return { assistant, results };
}
async function requestBoundary(f, apply = true) {
    if (apply) {
        await commitForcedReleases(f);
        await f.engine.compactIfNeeded(f.agent, "pressure", signal());
    }
    const step = nextStep(f);
    f.advanceSteps(step);
    f.session.append("step/start", { turn: 1, step });
    await f.ctx.waterfall(
        "agent/request",
        { agent: f.agent, turn: 1, step, signal: signal() },
        async () => ({ provider: "test", model: "fixture" }),
    );
    f.session.append("step/end", { turn: 1, step });
}
function assertBalanced(f) {
    const messages = f.session.deriveMessages();
    const calls = messages.flatMap((message) =>
        message.content.filter((block) => block.type === "tool-call").map((block) => block.id),
    );
    const results = messages
        .filter((message) => message.role === "tool")
        .map((message) => message.source.callId);
    assert.deepEqual(calls.sort(), results.sort());
    assert.equal(
        messages.some((message) => message.source.kind === "fold-context-release-cleanup"),
        false,
    );
}

for (const signed of [false, true])
    test(`successful ${signed ? "opaque replay" : "plain"} release disappears before the next request`, async (t) => {
        const f = await fixture();
        t.after(f.close);
        const goal = f.appendUser("A: preserve this business objective.");
        const evidence = f.toolRound("read", "Consumed facts. ".repeat(300));
        const id = f.idFor(evidence);
        const round = await invoke(
            f,
            [releaseCall([Number(id)])],
            signed ? { opaque: "original replay bytes" } : undefined,
        );
        const bytes = JSON.stringify(round.assistant);
        assert.ok(visible(f, round.assistant));
        assert.ok(visible(f, round.results[0].result));
        const outcome = round.results[0].outcome;
        assert.equal(JSON.stringify(outcome.value).includes("reason"), false);
        assert.equal(outcome.content[0].text.includes("reason"), false);
        assert.equal(outcome.meta.dshContextCompression.reason, "Evidence retained in conclusions");
        await requestBoundary(f);
        assert.equal(visible(f, round.assistant), false);
        assert.equal(visible(f, round.results[0].result), false);
        assert.ok(visible(f, goal));
        assert.equal(JSON.stringify(f.session.eventAt(round.assistant.seq)), bytes);
        assert.equal(
            f.engine.state(f.session).entries.find((entry) => entry.id === id).status,
            "released",
        );
        assertBalanced(f);
        const replay = f.sessions.create("cleanup-replay", { seed: f.session.snapshotEvents() });
        assert.deepEqual(replay.deriveMessages(), f.session.deriveMessages());
        assert.deepEqual(f.engine.state(replay), f.engine.state(f.session));
        assert.equal(f.calls.length, 0);
    });

test("an already settled release disappears without another body rewrite", async (t) => {
    const f = await fixture();
    t.after(f.close);
    const id = f.idFor(f.toolRound("read", "Evidence"));
    await invoke(f, [releaseCall([Number(id)], "first")]);
    await requestBoundary(f);
    const round = await invoke(f, [releaseCall([Number(id)], "settled")]);
    assert.deepEqual(round.results[0].outcome.value.settled, [id]);
    await requestBoundary(f);
    assert.equal(visible(f, round.assistant), false);
    assert.equal(visible(f, round.results[0].result), false);
    assertBalanced(f);
});

test("a direct release-only group waits for all targets before disappearing together", async (t) => {
    const f = await fixture();
    t.after(f.close);
    const ids = [
        Number(f.idFor(f.toolRound("read", "First evidence"))),
        Number(f.idFor(f.toolRound("grep", "Second evidence"))),
    ];
    const round = await invoke(
        f,
        ids.map((id, index) => releaseCall([id], `release-${index}`)),
    );
    await requestBoundary(f, false);
    assert.ok(visible(f, round.assistant));
    assert.ok(round.results.every(({ result }) => visible(f, result)));
    await requestBoundary(f);
    assert.equal(visible(f, round.assistant), false);
    assert.ok(round.results.every(({ result }) => !visible(f, result)));
    assertBalanced(f);
});

test("pending and rejected releases keep their feedback", async (t) => {
    const f = await fixture();
    t.after(f.close);
    const id = f.idFor(f.toolRound("read", "Evidence"));
    const pending = await invoke(f, [releaseCall([Number(id)], "pending")]);
    await requestBoundary(f, false);
    assert.ok(visible(f, pending.assistant));
    const rejected = await invoke(f, [releaseCall([999999], "rejected")]);
    await requestBoundary(f);
    assert.equal(visible(f, pending.assistant), false);
    assert.ok(visible(f, rejected.assistant));
    assert.ok(visible(f, rejected.results[0].result));
    assertBalanced(f);
});

for (const kind of ["text", "reasoning", "mixed-call"])
    test(`${kind} beside release remains intact`, async (t) => {
        const f = await fixture();
        t.after(f.close);
        const id = f.idFor(f.toolRound("read", "Evidence"));
        const extra =
            kind === "mixed-call"
                ? { type: "tool-call", id: "status", name: "context_status", arguments: "{}" }
                : kind === "reasoning"
                  ? { type: "reasoning", text: "Preserve this substantive analysis." }
                  : { type: "text", text: "Preserve this substantive finding." };
        const round = await invoke(f, [extra, releaseCall([Number(id)])]);
        await requestBoundary(f);
        assert.ok(visible(f, round.assistant));
        assert.ok(round.results.every(({ result }) => visible(f, result)));
        assertBalanced(f);
    });

test("an interleaved business message prevents range cleanup", async (t) => {
    const f = await fixture();
    t.after(f.close);
    const id = f.idFor(f.toolRound("read", "Evidence"));
    const unhook = f.ctx.on("tools/result", (exec) => {
        if (exec.name === "context_release") f.appendUser("Interleaved business context.");
    });
    const round = await invoke(f, [releaseCall([Number(id)])]);
    unhook();
    await requestBoundary(f);
    assert.ok(visible(f, round.assistant));
    assert.ok(
        f.session
            .deriveMessages()
            .some((message) =>
                message.content.some(
                    (block) =>
                        block.type === "text" && block.text === "Interleaved business context.",
                ),
            ),
    );
    assertBalanced(f);
});

for (const mode of ["void", "return", "array", "settled"])
    test(`quiet PTC ${mode} wrapper stays visible and preserves the exact reason on replay`, async (t) => {
        let ids;
        let inner;
        const f = await fixture({
            ptc: async (tools) => {
                inner = await tools.context_release({
                    ids,
                    reason: "PTC reason retained privately",
                });
                return mode === "void" ? {} : { value: mode === "array" ? [inner] : inner };
            },
        });
        t.after(f.close);
        const id = f.idFor(f.toolRound("read", "Evidence"));
        ids = [Number(id)];
        if (mode === "settled") {
            await invoke(f, [releaseCall(ids)]);
            await requestBoundary(f);
        }
        const round = await invoke(f, [
            {
                type: "tool-call",
                id: "ptc-root",
                name: "run_code",
                arguments: JSON.stringify({
                    code: "deterministic isolated program",
                    description: "Release consumed evidence",
                }),
            },
        ]);
        assert.equal(
            round.results[0].outcome.isError,
            false,
            JSON.stringify(round.results[0].outcome),
        );
        assert.equal(JSON.stringify(inner).includes("reason"), false);
        assert.equal(round.results[0].outcome.content[0].text.includes("PTC reason"), false);
        const dispatches = f.session
            .snapshotEvents()
            .filter((event) => event.type === "tool/ptc-dispatch");
        assert.equal(dispatches.length, 1);
        assert.equal(dispatches[0].data.rootCallId, "ptc-root");
        assert.equal("meta" in dispatches[0].data, false);
        if (mode !== "settled")
            assert.equal(
                f.engine.state(f.session).entries.find((entry) => entry.id === id).reason,
                "PTC reason retained privately",
            );
        await requestBoundary(f);
        assert.ok(visible(f, round.assistant));
        assert.ok(visible(f, round.results[0].result));
        assert.equal(
            f.engine.state(f.session).entries.find((entry) => entry.id === id).status,
            "released",
        );
        assertBalanced(f);
        const replay = f.sessions.create("ptc-cleanup-replay", {
            seed: f.session.snapshotEvents(),
        });
        assert.deepEqual(replay.deriveMessages(), f.session.deriveMessages());
        assert.deepEqual(f.engine.state(replay), f.engine.state(f.session));
    });

test("a quiet PTC filesystem write and nested release both survive cleanup", async (t) => {
    const root = await mkdtemp(join(tmpdir(), "fold-context-test-"));
    const file = join(root, "business-result.txt");
    const text = "Business work completed without logging or returning a value.";
    let f;
    let ids;
    t.after(async () => {
        await f?.close();
        await assertTestRoot(root);
        await rm(root, { recursive: true, force: true });
    });
    f = await fixture({
        ptc: async (tools) => {
            await writeFile(file, text, "utf8");
            await tools.context_release({ ids, reason: "Evidence consumed by the file write" });
            return {};
        },
    });
    const id = f.idFor(f.toolRound("read", "Source evidence used in business work."));
    ids = [Number(id)];
    const round = await invoke(
        f,
        [
            {
                type: "tool-call",
                id: "ptc-filesystem-work",
                name: "run_code",
                arguments: JSON.stringify({
                    code: [
                        'const fs = await import("node:fs/promises");',
                        `await fs.writeFile(${JSON.stringify(file)}, ${JSON.stringify(text)}, "utf8");`,
                        `await tools.context_release(${JSON.stringify({
                            ids,
                            reason: "Evidence consumed by the file write",
                        })});`,
                    ].join("\n"),
                    description: "Write the business result and release its consumed evidence",
                }),
            },
        ],
        { opaque: "Original provider replay for filesystem work" },
    );
    assert.equal(round.results[0].outcome.isError, false);
    assert.deepEqual(round.results[0].outcome.value.logs, []);
    assert.equal(round.results[0].outcome.value.result, undefined);
    assert.equal(round.results[0].outcome.content[0].text, "(run_code completed with no output)");
    const original = JSON.stringify(round.assistant);
    assert.equal(await readFile(file, "utf8"), text);
    await requestBoundary(f);
    assert.equal(
        f.engine.state(f.session).entries.find((entry) => entry.id === id).status,
        "released",
    );
    assert.ok(visible(f, round.assistant));
    assert.ok(visible(f, round.results[0].result));
    assert.equal(JSON.stringify(f.session.eventAt(round.assistant.seq)), original);
    assert.equal(await readFile(file, "utf8"), text);
    assertBalanced(f);
    const replay = f.sessions.create("filesystem-work-replay", {
        seed: f.session.snapshotEvents(),
    });
    assert.deepEqual(replay.deriveMessages(), f.session.deriveMessages());
    assert.deepEqual(f.engine.state(replay), f.engine.state(f.session));
});

for (const mode of ["business-call", "logs", "custom-result", "sandbox", "policy-content"])
    test(`PTC ${mode} preserves its outer call and output`, async (t) => {
        let ids;
        const f = await fixture({
            ptc: async (tools) => {
                const receipt = await tools.context_release({ ids, reason: "Consumed" });
                if (mode === "business-call") await tools.context_status({});
                if (mode === "logs")
                    return { value: receipt, logs: ["Keep this business finding."] };
                if (mode === "custom-result")
                    return { value: { important: "Keep this custom output." } };
                if (mode === "sandbox")
                    return {
                        value: receipt,
                        sandbox: { mode: "workspace-write", denied: false, enforcement: "partial" },
                    };
                return { value: receipt };
            },
        });
        t.after(f.close);
        ids = [Number(f.idFor(f.toolRound("read", "Evidence")))];
        if (mode === "policy-content")
            f.ctx.on("tools/post-execute", async (exec, result, next) => {
                const decision = await next();
                return exec.name === "run_code"
                    ? {
                          kind: "accept",
                          content: [
                              ...result.content,
                              { type: "text", text: "Keep policy feedback." },
                          ],
                      }
                    : decision;
            });
        const round = await invoke(f, [
            {
                type: "tool-call",
                id: "ptc-root",
                name: "run_code",
                arguments: JSON.stringify({
                    code: "deterministic isolated program",
                    description: "Release with business output",
                }),
            },
        ]);
        assert.equal(
            round.results[0].outcome.isError,
            false,
            JSON.stringify(round.results[0].outcome),
        );
        await requestBoundary(f);
        assert.ok(visible(f, round.assistant));
        assert.ok(visible(f, round.results[0].result));
        assertBalanced(f);
    });
