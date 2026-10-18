import test from "node:test";
import assert from "node:assert/strict";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { loopFixture, call } from "./loop-fixture.mjs";
import { temporaryRoot, png } from "./attachment-fixture.mjs";
import { installForcedReleaseBoundary } from "./release-batch-fixture.mjs";

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

test("real AgentLoop releases only selected attachment occurrences before recovery without a summary", async (t) => {
    let world;
    t.after(() => world?.close());
    const root = await temporaryRoot(t);
    let ids;
    let siblings;
    let originalInput;
    let content;
    let checked = false;
    world = await loopFixture(root, {
        attachments: true,
        inputModalities: ["text", "image"],
        auto: false,
        scheduling: { enabled: false },
        responses: [
            (_request, current) => {
                const session = current.sessions.list()[0];
                const state = current.engine.state(session);
                const occurrences = state.numbering.attachments;
                assert.deepEqual(
                    occurrences.map((item) => item.id),
                    ["2", "3", "4", "5"],
                );
                ids = [occurrences[0].id, occurrences[2].id];
                siblings = [occurrences[1], occurrences[3]];
                originalInput = session
                    .snapshotEvents()
                    .find((event) => event.seq === occurrences[0].sourceSeq);
                return call("context_release", {
                    ids: ids.map(Number),
                    reason: "both attachments consumed",
                });
            },
            (_request, current) => {
                assert.equal(current.summaries.length, 0);
                const session = current.sessions.list()[0];
                const state = current.engine.state(session);
                assert.equal(state.lastSummary, null);
                for (const id of ids)
                    assert.equal(state.entries.find((entry) => entry.id === id).status, "released");
                const replacement = session
                    .deriveMessages()
                    .find((message) => message.id === originalInput.data.id);
                assert.ok(replacement);
                const expected = structuredClone(originalInput.data.content);
                for (const [index, id] of [
                    [1, ids[0]],
                    [4, ids[1]],
                ]) {
                    assert.equal(replacement.content[index].text, `[released ${id}]`);
                    expected[index] = replacement.content[index];
                }
                assert.deepEqual(
                    replacement.content,
                    expected,
                    "adjacent text and duplicate siblings stay byte-identical",
                );
                for (const sibling of siblings) {
                    const slot = state.numbering.attachments.find((item) => item.id === sibling.id);
                    assert.equal(
                        state.entries.find((entry) => entry.id === sibling.id).status,
                        "available",
                    );
                    assert.equal(slot.blockIndex, sibling.blockIndex);
                    assert.equal(slot.currentBlockIndex, sibling.currentBlockIndex);
                    assert.equal(slot.sourceSeq, sibling.sourceSeq);
                    assert.deepEqual(replacement.content[slot.currentBlockIndex], sibling.block);
                }
                assert.equal(
                    JSON.stringify(
                        session.snapshotEvents().find((event) => event.seq === originalInput.seq),
                    ),
                    JSON.stringify(originalInput),
                );
                return call("context_expand", { id: Number(ids[0]) });
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
                    arguments: { id: Number(ids[1]) },
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
    installForcedReleaseBoundary(world);
    const image = await world.attachments.saveImage({ data: png(), mediaType: "image/png" });
    const file = await world.attachments.saveFile({
        data: Buffer.from("EXACT_FILE_BYTES\n"),
        name: "report.txt",
    });
    const handle = await world.create();
    content = [
        { type: "text", text: "Keep the attachment conclusions and user goal. ".repeat(700) },
        { type: "image", attachment: image },
        { type: "text", text: "Keep text between identical image occurrences." },
        { type: "image", attachment: image },
        { type: "file", attachment: file },
        { type: "text", text: "Keep text between identical file occurrences." },
        { type: "file", attachment: file },
        { type: "text", text: "Keep the final user requirement." },
    ];
    await world.followup(handle, content);
    assert.equal(checked, true);
    assert.equal(world.summaries.length, 0);
    const state = world.engine.state(handle.agent.session);
    assert.equal(state.lastSummary, null);
    for (const id of ids)
        assert.equal(state.entries.find((entry) => entry.id === id).status, "released");
    for (const sibling of siblings)
        assert.equal(state.entries.find((entry) => entry.id === sibling.id).status, "available");
    assert.equal(result(handle.agent.session, "context_expand").representation, "native-image");
    assert.equal(result(handle.agent.session, "nested_file").representation, "file-handle");
});

test("a released tool body and its child image remain archived after a covering summary without fabricated omission receipts", async (t) => {
    let world;
    t.after(() => world?.close());
    const root = await temporaryRoot(t);
    let target;
    let child;
    let originalResult;
    world = await loopFixture(root, {
        attachments: true,
        inputModalities: ["text", "image"],
        responses: [
            call("picture"),
            (_request, current) => {
                const session = current.sessions.list()[0];
                const state = current.engine.state(session);
                const entry = state.entries.find((item) => item.role === "tool");
                target = entry.id;
                child = state.numbering.attachments.find((item) => item.ownerId === target);
                assert.ok(child);
                originalResult = session
                    .snapshotEvents()
                    .find((event) => event.seq === entry.sourceSeq);
                return call("context_release", {
                    ids: [Number(target)],
                    reason: "visual result consumed",
                });
            },
            (request, current) => {
                const state = current.engine.state(current.sessions.list()[0]);
                assert.equal(current.summaries.length, 0);
                assert.equal(state.entries.find((entry) => entry.id === target).status, "released");
                const session = current.sessions.list()[0];
                const report = session
                    .snapshotEvents()
                    .find(
                        (event) =>
                            event.type === "compaction/prune" && event.data.foldContextRelease,
                    ).data.foldContextRelease;
                assert.equal(report.released.length, 2);
                assert.deepEqual(report.tokenEstimate, {
                    beforeTokens: world.ctx.tokenMeter.estimateMessage(
                        session.eventAt(report.targetSeq).data.message,
                    ),
                    afterTokens: world.ctx.tokenMeter.estimateMessage(
                        session.eventAt(report.completionSeq).data.message,
                    ),
                });
                assert.equal(
                    state.entries.find((entry) => entry.id === child.id).status,
                    "released",
                );
                assert.equal(
                    request.messages
                        .flatMap((message) => message.content)
                        .some((block) => block.type === "image"),
                    false,
                );
                return call("context_compact", { reason: "summarize prior work" });
            },
            (_request, current) => {
                assert.equal(
                    current.engine
                        .state(current.sessions.list()[0])
                        .entries.find((entry) => entry.id === child.id).status,
                    "released",
                );
                return call("context_expand", { id: Number(child.id) });
            },
        ],
    });
    installForcedReleaseBoundary(world);
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
    const state = world.engine.state(handle.agent.session);
    const receipt = state.lastSummary;
    assert.equal(state.entries.find((entry) => entry.id === target).status, "released");
    assert.equal(state.entries.find((entry) => entry.id === child.id).status, "released");
    assert.equal(receipt.excludedIds.includes(target), true);
    assert.equal(receipt.excludedIds.includes(child.id), false);
    assert.equal(
        receipt.projection.attachments.some((item) => item.id === child.id),
        false,
        "the image was removed before summary projection and has no checkpoint omission receipt",
    );
    assert.equal(
        JSON.stringify(
            handle.agent.session.snapshotEvents().find((event) => event.seq === originalResult.seq),
        ),
        JSON.stringify(originalResult),
    );
    const recovered = result(handle.agent.session, "context_expand");
    assert.deepEqual(recovered.attachment, ref);
    assert.equal(recovered.releaseStatus, "released");
    assert.equal(recovered.representation, "native-image");
    assert.equal(recovered.verifiedBytes, ref.bytes);
    assert.equal(
        world.summaries[0].messages
            .flatMap((message) => message.content)
            .some((block) => block.type === "image"),
        false,
    );
});
