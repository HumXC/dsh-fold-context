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
            auto: false,
            scheduling: { enabled: false },
            responses: [
                call("context_release", {
                    ids: ["§I2§", "§F4§"],
                    reason: "consumed first attachment occurrences",
                }),
                (_request, current) => {
                    assert.equal(current.summaries.length, 0);
                    const state = current.engine.state(current.sessions.list()[0]);
                    assert.equal(state.lastSummary, null);
                    for (const id of ["§I2§", "§F4§"])
                        assert.equal(
                            state.entries.find((entry) => entry.id === id).status,
                            "released",
                        );
                    for (const id of ["§I3§", "§F5§"])
                        assert.equal(
                            state.entries.find((entry) => entry.id === id).status,
                            "available",
                        );
                    return {
                        blocks: [{ type: "text", text: "Inline attachment release persisted." }],
                    };
                },
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
        const content = [
            { type: "text", text: "Keep original attachment conclusions. ".repeat(700) },
            { type: "image", attachment: image },
            { type: "image", attachment: image },
            { type: "file", attachment: file },
            { type: "file", attachment: file },
            { type: "text", text: "Preserve adjacent text and the duplicate occurrences." },
        ];
        await world.followup(handle, content);
        const session = handle.agent.session;
        const state = world.engine.state(session);
        assert.equal(world.summaries.length, 0);
        assert.equal(state.lastSummary, null);
        const sourceSeq = state.numbering.attachments.find((item) => item.id === "§I2§").sourceSeq;
        const source = session.snapshotEvents().find((event) => event.seq === sourceSeq);
        assert.deepEqual(source.data.content, content);
        const replacement = session
            .deriveMessages()
            .find((message) => message.id === source.data.id);
        assert.ok(replacement);
        const expectedContent = structuredClone(content);
        for (const [index, id] of [
            [1, "§I2R§"],
            [3, "§F4R§"],
        ]) {
            assert.match(replacement.content[index].text, new RegExp(id));
            expectedContent[index] = replacement.content[index];
        }
        assert.deepEqual(replacement.content, expectedContent);
        for (const [id, index] of [
            ["§I3§", 2],
            ["§F5§", 4],
        ]) {
            const slot = state.numbering.attachments.find((item) => item.id === id);
            assert.equal(slot.blockIndex, index);
            assert.equal(slot.currentBlockIndex, index);
            assert.deepEqual(replacement.content[index], slot.block);
        }
        await world.flush(handle);
        await writeFile(
            expectedPath,
            JSON.stringify({
                sessionId: handle.agent.session.id,
                numbering: state.numbering,
                lastSummary: state.lastSummary,
                events: session.snapshotEvents(),
                surface: [...session.surface.nodes],
                entries: state.entries,
                source,
                image,
                file,
            }),
        );
        console.log(
            JSON.stringify({
                written: true,
                inlineReleased: true,
                summaries: world.summaries.length,
                pid: process.pid,
            }),
        );
    } else if (mode === "read") {
        const expected = JSON.parse(await readFile(expectedPath, "utf8"));
        world = await loopFixture(root, {
            attachments: true,
            inputModalities: ["text", "image"],
            responses: [
                call("context_expand", { id: "§I2R§" }),
                call("context_expand", { id: "§F4R§" }),
            ],
        });
        const parent = await world.resume(expected.sessionId);
        assert.deepEqual(world.engine.state(parent.agent.session).numbering, expected.numbering);
        assert.deepEqual(
            world.engine.state(parent.agent.session).lastSummary,
            expected.lastSummary,
        );
        assert.deepEqual(
            parent.agent.session.snapshotEvents().slice(0, expected.events.length),
            expected.events,
        );
        assert.deepEqual(parent.agent.session.surface.nodes, expected.surface);
        assert.deepEqual(world.engine.state(parent.agent.session).entries, expected.entries);
        const imageRecovery = await expand(parent, "§I2R§");
        assert.deepEqual(imageRecovery.attachment, expected.image);
        assert.equal(imageRecovery.releaseStatus, "released");
        assert.equal(imageRecovery.verifiedBytes, expected.image.bytes);
        const recovered = await expand(parent, "§F4R§");
        assert.deepEqual(recovered.attachment, expected.file);
        assert.equal(recovered.releaseStatus, "released");
        assert.deepEqual(
            parent.agent.session.surface.nodes,
            expected.surface,
            "expansion leaves releases applied",
        );
        assert.deepEqual(await readFile(world.attachments.imageHostPath(expected.image)), png());
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
        assert.deepEqual((await expand(child, "§I2R§")).attachment, expected.image);
        assert.deepEqual((await expand(child, "§F4R§")).attachment, expected.file);
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
        assert.equal(world.summaries.length, 0);
        console.log(
            JSON.stringify({
                restored: true,
                inlineReleased: true,
                forkIsolated: true,
                pid: process.pid,
            }),
        );
    } else if (mode === "read-child") {
        const expected = JSON.parse(await readFile(expectedPath, "utf8"));
        const child = JSON.parse(await readFile(join(root, "attachment-child.json"), "utf8"));
        world = await loopFixture(root, { attachments: true, inputModalities: ["text", "image"] });
        const handle = await world.resume(child.sessionId);
        assert.deepEqual(world.engine.state(handle.agent.session).numbering, child.numbering);
        assert.deepEqual((await expand(handle, "§I2R§")).attachment, expected.image);
        assert.deepEqual((await expand(handle, "§F4R§")).attachment, expected.file);
        const state = world.engine.state(handle.agent.session);
        for (const id of ["§I2§", "§F4§"])
            assert.equal(state.entries.find((entry) => entry.id === id).status, "released");
        for (const id of ["§I3§", "§F5§"])
            assert.equal(state.entries.find((entry) => entry.id === id).status, "available");
        assert.equal(
            JSON.stringify(
                handle.agent.session
                    .snapshotEvents()
                    .find((event) => event.seq === expected.source.seq),
            ),
            JSON.stringify(expected.source),
        );
        assert.equal((await expand(handle, child.privateId)).representation, "file-handle");
        console.log(JSON.stringify({ restoredChild: true, pid: process.pid }));
    } else throw new Error("unknown attachment persistence mode");
} finally {
    await world?.close();
}
