import test from "node:test";
import assert from "node:assert/strict";
import { loopFixture, call } from "./loop-fixture.mjs";
import { temporaryRoot } from "./attachment-fixture.mjs";
import { summaryRecords } from "./summary-records.mjs";

test("allocation notices stay outside summaries while literal ID-like business text and replay remain exact", async (t) => {
    let world;
    // Drain the session before temporaryRoot removes its backing directory.
    t.after(() => world?.close());
    const root = await temporaryRoot(t);
    const business = 'const archivedId = "[§T3§]"; keep this exact code.\n'.repeat(900);
    const input = "Keep the literal [§U1§] in the project requirements.\n".repeat(700);
    let headers;
    let assistant;
    let assistantBytes;
    let checked = false;
    world = await loopFixture(root, {
        compaction: { targetTokens: 64, cacheReadRatio: 1 },
        scheduling: { summaryInputRatio: 0.01, summaryOutputRatio: 0.01 },
        tools: { probe_read: () => business },
        responses: [
            call("probe_read"),
            (request, current) => {
                const session = current.sessions.list()[0];
                const state = current.engine.state(session);
                const slot = state.numbering.slots.find(
                    (item) => item.role === "tool" && item.tool === "probe_read",
                );
                const original = session.eventAt(slot.sourceSeq).data.message;
                const result = request.messages.find((message) => message.id === original.id);
                assert.deepEqual(result.content, [{ type: "text", text: business }]);
                assert.deepEqual(result.source, original.source);
                assert.deepEqual(original.content, [{ type: "text", text: business }]);
                assert.deepEqual(
                    request.messages.find((message) => message.source.kind === "user").content,
                    [{ type: "text", text: input }],
                );
                headers = new Set(
                    request.messages
                        .filter((message) => message.source.kind === "fold-context-allocation")
                        .map((message) => message.content[0].text),
                );
                assert.ok(headers.size > 0);
                assert.ok([...headers].every((text) => /^prev: |^next: /.test(text)));
                assistant = session.eventAt(
                    state.numbering.slots.find((item) => item.id === "2").sourceSeq,
                );
                assistantBytes = JSON.stringify(assistant.data);
                return {
                    blocks: [
                        { type: "text", text: "The business code and requirements are recorded." },
                    ],
                };
            },
            call("context_compact", {
                reason: "Retain the business code and project requirements.",
            }),
            (_request, current) => {
                assert.equal(current.summaries.length, 1);
                const records = summaryRecords(current.summaries[0].messages);
                assert.ok(records.some((record) => record.text === business));
                assert.ok(records.some((record) => record.text === input));
                assert.ok(records.every((record) => !headers.has(record.text)));
                const session = current.sessions.list()[0];
                assert.equal(JSON.stringify(session.eventAt(assistant.seq).data), assistantBytes);
                checked = true;
                return { blocks: [{ type: "text", text: "Checkpoint complete." }] };
            },
        ],
    });
    const handle = await world.create();
    await world.followup(handle, input);
    assert.equal(world.summaries.length, 0);
    // The completed business frames become eligible once the next turn protects its own input.
    await world.followup(
        handle,
        "Checkpoint the completed work and continue with the retained requirements.",
    );
    assert.equal(checked, true);
});
