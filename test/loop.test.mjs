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
            assert.equal(
                request.messages.some(
                    (message) => message.source.kind === "fold-context-allocation",
                ),
                true,
            );
            const input = request.messages.find((message) => message.source.kind === "user");
            assert.equal(input.content[0].text, "A real-loop test input without an ID prefix.");
            const notice = request.messages.find(
                (message) => message.source.kind === "fold-context-allocation",
            );
            assert.equal(notice.content[0].text, "prev: 1\nnext: 2");
            const agentSession = world.sessions.list()[0];
            assert.ok(
                agentSession
                    .snapshotEvents()
                    .some(
                        (event) =>
                            event.type === "user/message" &&
                            event.data.source.kind === "fold-context-allocation",
                    ),
            );
            assert.ok(
                world.engine
                    .state(agentSession)
                    .numbering.slots.some((slot) => slot.id === "2" && slot.status === "reserved"),
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

test("real inline release replaces only the tool body before recovery without an auxiliary model call", async (t) => {
    const original = "RELEASE_LOOP_ORIGINAL ".repeat(700);
    let originalEvent;
    let assistantEvent;
    let callEvent;
    let beforeRelease;
    const f = await setup(t, {
        auto: false,
        tools: { probe_read: () => original },
        responses: [
            call("probe_read"),
            (request, world) => {
                const session = world.sessions.list()[0];
                const entry = world.engine
                    .state(session)
                    .entries.find((item) => item.role === "tool");
                originalEvent = session
                    .snapshotEvents()
                    .find((event) => event.seq === entry.sourceSeq);
                assistantEvent = session
                    .snapshotEvents()
                    .find(
                        (event) =>
                            event.type === "assistant/message" &&
                            event.data.message.content.some(
                                (block) =>
                                    block.type === "tool-call" &&
                                    block.id === originalEvent.data.message.toolCallId,
                            ),
                    );
                callEvent = session
                    .snapshotEvents()
                    .find(
                        (event) =>
                            event.type === "tool/call" &&
                            event.data.callId === originalEvent.data.message.toolCallId,
                    );
                beforeRelease = JSON.parse(JSON.stringify(request.messages));
                return call("context_release", { ids: [Number(entry.id)], reason: "Consumed" });
            },
            (request, world) => {
                const session = world.sessions.list()[0];
                const state = world.engine.state(session);
                const entry = state.entries.find((item) => item.role === "tool");
                assert.equal(entry.status, "released");
                assert.equal(world.summaries.length, 0);
                assert.equal(state.lastSummary, null);
                assert.equal(session.surface.nodes.includes(entry.sourceSeq), false);
                assert.ok(session.surface.nodes.includes(entry.currentSeq));
                const replacement = request.messages.find(
                    (message) => message.id === originalEvent.data.message.id,
                );
                assert.ok(replacement);
                assert.equal(replacement.role, "tool");
                assert.equal(replacement.toolCallId, originalEvent.data.message.toolCallId);
                assert.equal(replacement.content[0].text, `[released ${entry.id}]`);
                assert.equal(JSON.stringify(request.messages).includes(original), false);
                const expectedPrefix = structuredClone(beforeRelease);
                expectedPrefix.find((message) => message.id === replacement.id).content =
                    replacement.content;
                assert.deepEqual(request.messages.slice(0, expectedPrefix.length), expectedPrefix);
                for (const event of [originalEvent, assistantEvent, callEvent]) {
                    assert.equal(
                        JSON.stringify(
                            session.snapshotEvents().find((item) => item.seq === event.seq),
                        ),
                        JSON.stringify(event),
                    );
                }
                return call("context_expand", { id: Number(entry.id), limit: 64 });
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
    assert.equal(expanded.restoresSurface, false);
    const entries = f.engine
        .state(handle.agent.session)
        .entries.filter((entry) => entry.role === "tool");
    assert.equal(entries.length, 1);
    assert.equal(entries[0].status, "released");
    assert.ok(
        handle.agent.session.snapshotEvents().some((event) => event.type === "compaction/prune"),
    );
    assert.equal(f.summaries.length, 0);
    assert.equal(f.requests.length, 4);
    assert.equal(
        f.originalCalls.length,
        f.requests.length,
        "release and expansion make no auxiliary LLM requests",
    );
});

test("real eligible checkpoint request runs below threshold and search discovers folded evidence", async (t) => {
    const f = await setup(t, {
        compaction: { retainTokens: 0 },
        scheduling: { minIntervalSteps: 0 },
        tools: { probe_read: () => "SUMMARY_LOOP_HIDDEN ".repeat(1500) },
        responses: [
            call("probe_read"),
            { blocks: [{ type: "text", text: "The original evidence has been inspected." }] },
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
    assert.equal(f.summaries.length, 0);
    await f.followup(
        handle,
        "Checkpoint the completed investigation and discover its original evidence.",
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
