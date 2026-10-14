import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { SessionSeq, SessionLogOffset, buildForkSeed } from "@deepseek-ai/dsh-session";
import { loopFixture, assertTestRoot, call } from "./loop-fixture.mjs";
import { png } from "./attachment-fixture.mjs";

const root = process.env.FOLD_CONTEXT_TEST_ROOT;
await assertTestRoot(root);
const mode = process.env.FOLD_CONTEXT_TEST_MODE;
const expectedPath = join(root, "attachment-expected.json");
let world;
async function expand(handle, id) {
    const outcome = await world.ctx.tools.execute({
        name: "context_expand",
        arguments: { id },
        callId: "isolated-attachment-read",
        agent: handle.agent,
        signal: new AbortController().signal,
    });
    assert.equal(outcome.isError, false, JSON.stringify(outcome));
    return JSON.parse(outcome.content.find((block) => block.type === "text").text);
}
try {
    if (mode === "write") {
        world = await loopFixture(root, {
            attachments: true,
            inputModalities: ["text", "image"],
            responses: [
                call("context_release", { ids: ["§I2§", "§F3§"], reason: "consumed attachments" }),
                call("context_compact", { reason: "cover original attachments" }),
            ],
        });
        const image = await world.attachments.saveImage({
            data: png(),
            mediaType: "image/png",
            name: "original.png",
        });
        const file = await world.attachments.saveFile({
            data: Buffer.from("COLD_FILE_ORIGINAL\n"),
            name: "original.txt",
        });
        const handle = await world.create();
        await world.followup(handle, [
            { type: "text", text: "Keep original attachment conclusions. ".repeat(700) },
            { type: "image", attachment: image },
            { type: "file", attachment: file },
        ]);
        const state = world.engine.state(handle.agent.session);
        assert.deepEqual(state.lastSummary.excludedIds, ["§I2§", "§F3§"]);
        await world.flush(handle);
        await writeFile(
            expectedPath,
            JSON.stringify({
                sessionId: handle.agent.session.id,
                numbering: state.numbering,
                lastSummary: state.lastSummary,
                image,
                file,
            }),
        );
        console.log(JSON.stringify({ written: true, pid: process.pid }));
    } else if (mode === "read") {
        const expected = JSON.parse(await readFile(expectedPath, "utf8"));
        world = await loopFixture(root, {
            attachments: true,
            inputModalities: ["text", "image"],
            responses: [
                call("context_expand", { id: "§I2§" }),
                call("context_expand", { id: "§F3§" }),
            ],
        });
        const parent = await world.resume(expected.sessionId);
        assert.deepEqual(world.engine.state(parent.agent.session).numbering, expected.numbering);
        assert.deepEqual(
            world.engine.state(parent.agent.session).lastSummary,
            expected.lastSummary,
        );
        assert.deepEqual((await expand(parent, "§I2§")).attachment, expected.image);
        const recovered = await expand(parent, "§F3§");
        assert.deepEqual(recovered.attachment, expected.file);
        assert.equal(recovered.verifiedBytes, expected.file.bytes);
        assert.equal(
            await readFile(world.attachments.fileHostPath(expected.file), "utf8"),
            "COLD_FILE_ORIGINAL\n",
        );
        await world.followup(parent, "Recover the original image and file after restart.");
        assert.ok(
            world.requests
                .at(-1)
                .messages.some((message) =>
                    message.content.some((block) => block.type === "image"),
                ),
        );
        const parentState = world.engine.state(parent.agent.session);
        const events = parent.agent.session.snapshotEvents();
        const boundary = SessionSeq(events.at(-1).seq);
        const child = await world.create({
            seed: buildForkSeed(events, boundary),
            inheritedEventCount: SessionLogOffset(boundary + 1),
            meta: { cwd: root, parentSession: parent.agent.session.id, isSeeded: true },
        });
        assert.deepEqual((await expand(child, "§I2§")).attachment, expected.image);
        const privateFile = await world.attachments.saveFile({
            data: Buffer.from("PRIVATE_CHILD_ATTACHMENT"),
            name: "private-child.txt",
        });
        await world.followup(child, [
            { type: "text", text: "Private child attachment evidence." },
            { type: "file", attachment: privateFile },
        ]);
        const privateId = world.engine
            .state(child.agent.session)
            .numbering.attachments.find(
                (item) => item.block.attachment.attachmentId === privateFile.attachmentId,
            ).id;
        const denied = await expand(parent, privateId);
        assert.equal(denied.status, "unknown");
        assert.equal(
            world.engine.state(parent.agent.session).numbering.nextNumber,
            parentState.numbering.nextNumber,
        );
        await world.flush(child);
        await writeFile(
            join(root, "attachment-child.json"),
            JSON.stringify({
                sessionId: child.agent.session.id,
                privateId,
                numbering: world.engine.state(child.agent.session).numbering,
            }),
        );
        console.log(JSON.stringify({ restored: true, forkIsolated: true, pid: process.pid }));
    } else if (mode === "read-child") {
        const expected = JSON.parse(await readFile(expectedPath, "utf8"));
        const child = JSON.parse(await readFile(join(root, "attachment-child.json"), "utf8"));
        world = await loopFixture(root, { attachments: true, inputModalities: ["text", "image"] });
        const handle = await world.resume(child.sessionId);
        assert.deepEqual(world.engine.state(handle.agent.session).numbering, child.numbering);
        assert.deepEqual((await expand(handle, "§I2§")).attachment, expected.image);
        assert.deepEqual((await expand(handle, "§F3§")).attachment, expected.file);
        assert.equal((await expand(handle, child.privateId)).representation, "file-handle");
        console.log(JSON.stringify({ restoredChild: true, pid: process.pid }));
    } else throw new Error("unknown attachment persistence mode");
} finally {
    await world?.close();
}
