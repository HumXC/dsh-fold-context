import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { loopFixture, call } from "./loop-fixture.mjs";

const root = process.env.FOLD_CONTEXT_TEST_ROOT;
const mode = process.env.FOLD_CONTEXT_TEST_MODE;
const userText = "USER_COLD_ORIGINAL 🧠é\n  preserve exact user whitespace.\n".repeat(80);
const assistantText =
    "ASSISTANT_COLD_ORIGINAL 🧠é\n  preserve exact assistant whitespace.\n".repeat(80);
const expectedPath = join(root, "typed-expected.json");
let targetIds;
let world;
let handle;
const namedResults = (session, name) => {
    const events = new Map(session.snapshotEvents().map((event) => [event.seq, event]));
    return world.engine
        .state(session)
        .numbering.slots.filter(
            (slot) => slot.role === "tool" && slot.tool === name && slot.sourceSeq !== null,
        )
        .map((slot) => JSON.parse(events.get(slot.sourceSeq).data.message.content[0].text));
};
const result = (session, name) => namedResults(session, name).at(-1);

try {
    if (mode === "write") {
        world = await loopFixture(root, {
            responses: [
                {
                    blocks: [
                        { type: "reasoning", text: "THOUGHT_COLD_ORIGINAL 🧠é\n" },
                        { type: "text", text: assistantText },
                    ],
                },
                (_request, current) => {
                    const state = current.engine.state(handle.agent.session);
                    targetIds = state.entries
                        .filter(
                            (entry) => entry.sourceSeq !== null && ["1", "2"].includes(entry.id),
                        )
                        .map((entry) => entry.id);
                    assert.deepEqual(targetIds, ["1", "2"]);
                    return call("context_release", {
                        ids: targetIds.map(Number),
                        reason: "request release of earlier conversation bodies",
                    });
                },
                (_request, current) => {
                    const state = current.engine.state(handle.agent.session);
                    const release = result(handle.agent.session, "context_release");
                    assert.equal(release.accepted, false);
                    assert.equal(release.dshContextCompression, null);
                    for (const id of targetIds) {
                        assert.equal(
                            state.entries.find((entry) => entry.id === id).status,
                            "available",
                        );
                    }
                    assert.equal(current.summaries.length, 0);
                    return call("context_compact", {
                        reason: "Summarize the earlier user and assistant normally",
                    });
                },
                (_request, current) => {
                    const agent = handle.agent;
                    for (const id of targetIds)
                        assert.equal(
                            current.engine
                                .state(agent.session)
                                .entries.find((entry) => entry.id === id).status,
                            "summarized",
                        );
                    return call("context_expand", { id: 2, limit: 16000 });
                },
                { blocks: [{ type: "text", text: "Finished isolated summary and recovery." }] },
            ],
        });
        handle = await world.create();
        await world.followup(handle, userText);
        await world.followup(
            handle,
            "Request release of earlier conversation bodies, then checkpoint the earlier evidence. ".repeat(
                200,
            ),
        );
        const session = handle.agent.session;
        assert.deepEqual(JSON.parse(result(session, "context_expand").text), [
            { type: "reasoning", text: "THOUGHT_COLD_ORIGINAL 🧠é\n" },
            { type: "text", text: assistantText },
        ]);
        const state = world.engine.state(session);
        assert.equal(result(session, "context_release").accepted, false);
        assert.equal(state.entries.find((entry) => entry.id === "1").status, "summarized");
        assert.equal(state.entries.find((entry) => entry.id === "2").status, "summarized");
        assert.equal(world.summaries.length, 1);
        assert.deepEqual(state.lastSummary.excludedIds, []);
        const summaryInput = JSON.stringify(world.summaries[0].messages);
        assert.ok(summaryInput.includes("USER_COLD_ORIGINAL"));
        assert.ok(summaryInput.includes("ASSISTANT_COLD_ORIGINAL"));
        assert.equal(state.lastSummary.projection.reasoning, "omit-from-summary");
        assert.equal(state.lastSummary.projection.omittedReasoning[0].id, "2");
        const usage = world.ctx.sessionProjections.stateOf(session, "tokenUsage");
        const settlements = session
            .snapshotEvents()
            .filter((event) => event.type === "assistant/message" && event.surfaceOp === "append");
        assert.equal(settlements.length, 5);
        await world.flush(handle);
        await writeFile(
            expectedPath,
            JSON.stringify({
                sessionId: session.id,
                numbering: state.numbering,
                surface: session.surface.nodes,
                usage,
                lastSummary: state.lastSummary,
            }),
        );
        console.log(JSON.stringify({ written: true, pid: process.pid }));
    } else if (mode === "read") {
        const expected = JSON.parse(await readFile(expectedPath, "utf8"));
        world = await loopFixture(root, {
            reasoning: "preserve",
            responses: [
                call("context_search", { query: "ASSISTANT_COLD_ORIGINAL", roles: ["assistant"] }),
                call("context_expand", { id: 2, limit: 16000 }),
                call("context_expand", { id: 1, limit: 16000 }),
                {
                    blocks: [
                        { type: "text", text: "Recovered exact originals after process restart." },
                    ],
                },
            ],
        });
        handle = await world.resume(expected.sessionId);
        const session = handle.agent.session;
        const state = world.engine.state(session);
        assert.deepEqual(state.numbering, expected.numbering);
        assert.equal(world.engine.summaryPolicy.reasoning, "preserve");
        assert.deepEqual(state.lastSummary, expected.lastSummary);
        assert.deepEqual(session.surface.nodes, expected.surface);
        assert.deepEqual(
            world.ctx.sessionProjections.stateOf(session, "tokenUsage"),
            expected.usage,
        );
        for (const id of ["1", "2"])
            assert.equal(state.entries.find((entry) => entry.id === id).status, "summarized");
        assert.equal(result(session, "context_release").accepted, false);
        assert.deepEqual(state.lastSummary.excludedIds, []);
        await world.followup(handle, "Discover and recover both earlier originals.");
        assert.ok(result(session, "context_search").hits.some((hit) => hit.id === "2"));
        const expanded = namedResults(session, "context_expand");
        assert.deepEqual(JSON.parse(expanded.findLast((page) => page.id === "2").text), [
            { type: "reasoning", text: "THOUGHT_COLD_ORIGINAL 🧠é\n" },
            { type: "text", text: assistantText },
        ]);
        assert.equal(expanded.findLast((page) => page.id === "1").text, userText);
        console.log(JSON.stringify({ restored: true, pid: process.pid }));
    } else {
        throw new Error("unknown isolated typed persistence mode");
    }
} finally {
    await world?.close();
}
