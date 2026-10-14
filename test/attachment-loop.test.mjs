import test from "node:test";
import assert from "node:assert/strict";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { loopFixture, call } from "./loop-fixture.mjs";
import { temporaryRoot, png } from "./attachment-fixture.mjs";

function result(session, name) {
    const events = session.snapshotEvents();
    const invocation = events.findLast(
        (event) => event.type === "tool/call" && event.data.name === name,
    );
    const outcome = events.find(
        (event) => event.type === "tool/result" && event.sourceEventSeqs?.includes(invocation?.seq),
    );
    assert.ok(outcome, `missing ${name} result`);
    assert.equal(outcome.data.message.isError, false, JSON.stringify(outcome.data));
    return JSON.parse(outcome.data.message.content.find((block) => block.type === "text").text);
}

test("real AgentLoop releases attachments only at summary commit and reintroduces a native image plus a nested file handle", async (t) => {
    const root = await temporaryRoot(t);
    let ids;
    let checked = false;
    const world = await loopFixture(root, {
        attachments: true,
        inputModalities: ["text", "image"],
        responses: [
            (_request, current) => {
                const state = current.engine.state(current.sessions.list()[0]);
                ids = state.numbering.attachments.map((item) => item.id);
                assert.deepEqual(ids, ["§I2§", "§F3§"]);
                return call("context_release", { ids, reason: "both attachments consumed" });
            },
            (_request, current) => {
                assert.equal(current.summaries.length, 0);
                assert.ok(
                    current.engine
                        .state(current.sessions.list()[0])
                        .entries.filter((entry) => ids.includes(entry.id))
                        .every((entry) => entry.status === "queued"),
                );
                return call("context_compact", { reason: "cover consumed attachments" });
            },
            (_request, current) => {
                assert.ok(
                    current.engine
                        .state(current.sessions.list()[0])
                        .entries.filter((entry) => ids.includes(entry.id))
                        .every((entry) => entry.status === "released"),
                );
                return call("context_expand", { id: ids[0] });
            },
            call("nested_file"),
            (request, current) => {
                assert.ok(
                    request.messages.some((message) =>
                        message.content.some((block) => block.type === "image"),
                    ),
                );
                assert.equal(
                    request.messages.some((message) =>
                        message.content.some((block) => block.type === "file"),
                    ),
                    false,
                    "the real runtime projects files to handles",
                );
                assert.ok(
                    request.messages.some((message) =>
                        message.content.some(
                            (block) => block.type === "text" && block.text.includes("report.txt"),
                        ),
                    ),
                );
                const deferred = current.originalCalls
                    .at(-1)
                    .request.messages.find(
                        (message) => message.source.kind === "fold-context-attachment-recovery",
                    );
                assert.ok(deferred?.content.some((block) => block.type === "file"));
                checked = true;
                return { blocks: [{ type: "text", text: "Recovered attachments." }] };
            },
        ],
    });
    t.after(world.close);
    world.ctx.tools.register(
        defineTool({
            name: "nested_file",
            description: "Isolated transport forwarding",
            parameters: {},
            output: {
                schema: { type: "json" },
                render: (_args, value) => [{ type: "text", text: JSON.stringify(value) }],
            },
            execute: async (_args, exec) => {
                const outcome = await world.ctx.tools.execute({
                    name: "context_expand",
                    arguments: { id: ids[1] },
                    callId: `${exec.callId}:child`,
                    agent: exec.agent,
                    parent: exec.token,
                    signal: exec.signal,
                });
                assert.equal(outcome.isError, false);
                for (const context of outcome.additionalContexts ?? []) exec.deferContext(context);
                return JSON.parse(outcome.content.find((block) => block.type === "text").text);
            },
        }),
    );
    const image = await world.attachments.saveImage({ data: png(), mediaType: "image/png" });
    const file = await world.attachments.saveFile({
        data: Buffer.from("EXACT_FILE_BYTES\n"),
        name: "report.txt",
    });
    const handle = await world.create();
    await world.followup(handle, [
        { type: "text", text: "Keep the attachment conclusions and user goal. ".repeat(700) },
        { type: "image", attachment: image },
        { type: "file", attachment: file },
    ]);
    assert.equal(checked, true);
    assert.equal(world.summaries.length, 1);
    assert.deepEqual(
        world.engine
            .state(handle.agent.session)
            .lastSummary.projection.attachments.map((item) => item.action),
        ["marked-excluded", "marked-excluded"],
    );
    assert.equal(result(handle.agent.session, "context_expand").representation, "native-image");
    assert.equal(result(handle.agent.session, "nested_file").representation, "file-handle");
});

test("whole tool-pair exclusion reports child image omission without leaving an unmatched call", async (t) => {
    const root = await temporaryRoot(t);
    let target;
    const world = await loopFixture(root, {
        attachments: true,
        inputModalities: ["text", "image"],
        responses: [
            call("picture"),
            (_request, current) => {
                target = current.engine
                    .state(current.sessions.list()[0])
                    .entries.find((entry) => entry.role === "tool").id;
                return call("context_release", { ids: [target], reason: "visual result consumed" });
            },
            call("context_compact", { reason: "summarize prior work" }),
        ],
    });
    t.after(world.close);
    const ref = await world.attachments.saveImage({ data: png(), mediaType: "image/png" });
    world.ctx.tools.register(
        defineTool({
            name: "picture",
            description: "Isolated visual result",
            parameters: {},
            output: {
                schema: { type: "json" },
                render: () => [{ type: "image", attachment: ref }],
            },
            execute: async () => ({ produced: true }),
        }),
    );
    const handle = await world.create();
    await world.followup(handle, "Keep this completed-work objective. ".repeat(700));
    assert.equal(world.summaries.length, 1);
    const receipt = world.engine.state(handle.agent.session).lastSummary;
    assert.ok(receipt.excludedIds.includes(target));
    assert.equal(receipt.projection.attachments[0].action, "tool-pair-excluded");
    assert.equal(
        world.summaries[0].messages
            .flatMap((message) => message.content)
            .some((block) => block.type === "image"),
        false,
    );
});
