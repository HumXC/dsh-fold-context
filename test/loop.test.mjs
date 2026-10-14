import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loopFixture, assertTestRoot, call } from "./loop-fixture.mjs";

async function setup(t, options) {
    const root = await mkdtemp(join(tmpdir(), "fold-context-test-"));
    let f;
    t.after(async () => {
        try {
            await f?.close();
        } finally {
            await assertTestRoot(root);
            await rm(root, { recursive: true, force: true });
        }
    });
    f = await loopFixture(root, options);
    return f;
}
const toolOutcome = (session, name) => {
    const events = session.snapshotEvents();
    const callEvent = events.findLast(
        (event) => event.type === "tool/call" && event.data.name === name,
    );
    const result = events.find(
        (event) => event.type === "tool/result" && event.sourceEventSeqs?.includes(callEvent?.seq),
    );
    assert.ok(result, `missing actual ${name} result`);
    assert.equal(result.data.message.isError, false, JSON.stringify(result.data));
    return JSON.parse(result.data.message.content.map((block) => block.text ?? "").join(""));
};

test("real AgentLoop declares IDs before stream and reserves tool results before execution", async (t) => {
    let checkedRequest = false;
    let checkedTool = false;
    const f = await setup(t, {
        responses: [call("probe_read")],
        tools: {
            probe_read: (_args, exec, world) => {
                const slot = world.engine
                    .state(exec.agent.session)
                    .numbering.slots.find((slot) => slot.callId === exec.callId);
                assert.equal(slot.status, "reserved");
                assert.equal(slot.sourceSeq, null);
                checkedTool = true;
                return "real-loop-original evidence";
            },
        },
        onStream: (request, world, ordinary) => {
            if (!ordinary || checkedRequest) return;
            const declaration = request.messages.find(
                (message) => message.source.kind === "fold-context-allocation",
            );
            assert.ok(declaration);
            const agentSession = world.sessions.list()[0];
            const durableDeclaration = agentSession
                .snapshotEvents()
                .find((event) => event.type === "user/message" && event.data.id === declaration.id);
            assert.ok(
                durableDeclaration,
                "declaration is committed before the adapter sees the request",
            );
            assert.ok(
                world.engine
                    .state(agentSession)
                    .numbering.slots.some(
                        (slot) =>
                            slot.id === declaration.source.allocation.assistantId &&
                            slot.status === "reserved",
                    ),
            );
            checkedRequest = true;
        },
    });
    const handle = await f.create();
    await f.followup(handle, "A real-loop test input without an ID prefix.");
    assert.equal(checkedRequest, true);
    assert.equal(checkedTool, true);
    assert.equal(f.requests.length, 2);
    assert.equal(
        f.engine.state(handle.agent.session).entries.filter((entry) => entry.role === "tool")
            .length,
        1,
    );
    assert.ok(
        handle.agent.session
            .snapshotEvents()
            .filter((event) => event.type === "assistant/message")
            .every(
                (event) =>
                    !event.data.message.content.some(
                        (block) => block.type === "text" && /^§[UAT][0-9]+§/.test(block.text),
                    ),
            ),
    );
});

test("real queued release waits for a covering summary and the original is recovered through a real tool call", async (t) => {
    const original = "RELEASE_LOOP_ORIGINAL ".repeat(700);
    const f = await setup(t, {
        tools: { probe_read: () => original },
        responses: [
            call("probe_read"),
            (_request, world) =>
                call("context_release", {
                    ids: [
                        world.engine
                            .state(world.sessions.list()[0])
                            .entries.find((entry) => entry.role === "tool").id,
                    ],
                    reason: "Consumed",
                }),
            (request, world) => {
                const session = world.sessions.list()[0];
                const entry = world.engine
                    .state(session)
                    .entries.find((entry) => entry.role === "tool");
                assert.equal(entry.status, "queued");
                assert.equal(world.summaries.length, 0);
                assert.ok(session.surface.nodes.includes(entry.sourceSeq));
                assert.ok(
                    request.messages.some((message) =>
                        message.content.some(
                            (block) => block.type === "text" && block.text === original,
                        ),
                    ),
                );
                return call("context_compact", { reason: "Cover consumed evidence" });
            },
            (_request, world) => {
                const entry = world.engine
                    .state(world.sessions.list()[0])
                    .entries.find((entry) => entry.role === "tool");
                assert.equal(entry.status, "released");
                return call("context_expand", { id: entry.id, limit: 64 });
            },
        ],
    });
    const handle = await f.create();
    await f.followup(
        handle,
        "Release then recover the original while preserving this checkpoint objective. ".repeat(
            120,
        ),
    );
    const released = toolOutcome(handle.agent.session, "context_release");
    assert.equal(released.accepted, true);
    const expanded = toolOutcome(handle.agent.session, "context_expand");
    assert.equal(expanded.text, original.slice(0, 64));
    assert.equal(expanded.releaseStatus, "released");
    assert.equal(
        f.engine.state(handle.agent.session).entries.filter((entry) => entry.role === "tool")
            .length,
        1,
    );
    assert.equal(
        handle.agent.session.snapshotEvents().some((event) => event.type === "compaction/prune"),
        false,
    );
    assert.equal(f.summaries.length, 1);
});

test("real explicit summary runs below threshold and search discovers folded evidence", async (t) => {
    const f = await setup(t, {
        tools: { probe_read: () => "SUMMARY_LOOP_HIDDEN ".repeat(1500) },
        responses: [
            call("probe_read"),
            call("context_compact", { reason: "Checkpoint" }),
            (_request, world) => {
                assert.equal(
                    world.engine.state(world.sessions.list()[0]).summaryRequests[0].status,
                    "applied",
                );
                return call("context_search", { query: "SUMMARY_LOOP_HIDDEN", roles: ["tool"] });
            },
        ],
    });
    const handle = await f.create();
    await f.followup(
        handle,
        "A large original should be retrievable after an explicit checkpoint. ".repeat(120),
    );
    assert.equal(f.summaries.length, 1);
    const searched = toolOutcome(handle.agent.session, "context_search");
    assert.equal(searched.hits.length, 1);
    assert.equal(searched.hits[0].releaseStatus, "summarized");
    assert.equal(f.query.activeLeases, 0);
});

test("automatic pressure summaries run in the real loop without manual engine invocation", async (t) => {
    const f = await setup(t, {
        auto: true,
        contextWindow: 8192,
        tools: { probe_read: () => "PRESSURE_ORIGINAL ".repeat(8000) },
        responses: [call("probe_read")],
    });
    const handle = await f.create();
    await f.followup(
        handle,
        "Trigger isolated automatic pressure using a large tool result. ".repeat(40),
    );
    assert.equal(f.requests.length, 2);
    assert.equal(f.summaries.length, 1);
    const events = handle.agent.session.snapshotEvents();
    const start = events.find((event) => event.type === "compaction/start");
    const end = events.find((event) => event.type === "compaction/end");
    assert.ok(start && end);
    assert.equal(end.data.error, undefined);
    assert.ok(start.seq > events.find((event) => event.type === "tool/result").seq);
    assert.equal(f.engine.state(handle.agent.session).activeStart, null);
});
