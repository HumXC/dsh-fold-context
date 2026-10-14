import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile, rm, realpath, chmod } from "node:fs/promises";
import { Session } from "@deepseek-ai/dsh-session";
import { catalog } from "../lib/domain/planner.js";
import { expandAttachment } from "../lib/integration/attachment-recovery.js";
import { ledgerProjection } from "../lib/domain/ledger.js";
import { fixture } from "./fixture.mjs";
import {
    admit,
    attachmentFixture,
    attachmentSlots,
    outputValue,
    png,
} from "./attachment-fixture.mjs";

const evidence = {
    type: "text",
    text: "Attachment conclusion and original user goal. ".repeat(700),
};
const signal = () => new AbortController().signal;
const images = (f) => attachmentSlots(f).filter((slot) => slot.kind === "image");

test("attachment occurrences use shared ordinals before generation without rewriting admitted content", async (t) => {
    const f = await attachmentFixture(t);
    const image = await f.store.saveImage({ data: png(), mediaType: "image/png", name: "red.png" });
    const file = await f.store.saveFile({
        data: Buffer.from("file evidence"),
        name: "evidence.txt",
    });
    const content = [
        evidence,
        { type: "image", attachment: image },
        { type: "file", attachment: file },
    ];
    const original = await admit(f, content);
    assert.deepEqual(original.data.content, content);
    assert.deepEqual(
        attachmentSlots(f).map((slot) => slot.id),
        ["§I2§", "§F3§"],
    );
    assert.deepEqual(
        f.engine.state(f.session).numbering.slots.map((slot) => slot.id),
        ["§U1§", "§A4§"],
    );
    assert.equal(f.engine.state(f.session).numbering.nextNumber, 5);
    const state = ledgerProjection.stateSchema.parse(f.engine.state(f.session));
    assert.deepEqual(JSON.parse(JSON.stringify(state)), state);
    const restored = Session.create(f.session.id, f.session.snapshotEvents(), f.session.header);
    assert.deepEqual(f.engine.state(restored).numbering.attachments, attachmentSlots(f));
});

test("identical attachment bytes appearing twice retain independent occurrence IDs and bounded discovery", async (t) => {
    const f = await attachmentFixture(t);
    const ref = await f.store.saveImage({ data: png(), mediaType: "image/png" });
    await admit(f, [
        evidence,
        { type: "image", attachment: ref },
        { type: "image", attachment: ref },
    ]);
    assert.deepEqual(
        images(f).map((slot) => [slot.id, slot.blockIndex]),
        [
            ["§I2§", 1],
            ["§I3§", 2],
        ],
    );
    const view = catalog(f.engine.state(f.session), { catalogLimit: 1 });
    assert.equal(view.attachments.length, 1);
    assert.equal(view.attachmentsOmitted, 1);
    const targeted = catalog(f.engine.state(f.session), { catalogLimit: 1 }, 1, ["§I2§"]);
    assert.equal(targeted.attachments[0].id, "§I2§");
});

test("individual image release filters one occurrence only; the checkpoint alone settles it", async (t) => {
    const f = await attachmentFixture(t);
    const ref = await f.store.saveImage({ data: png(), mediaType: "image/png" });
    const original = await admit(f, [
        evidence,
        { type: "image", attachment: ref },
        { type: "image", attachment: ref },
    ]);
    await f.invoke("context_release", { ids: ["§I2§"], reason: "first occurrence consumed" });
    assert.equal(
        f.engine.state(f.session).entries.find((entry) => entry.id === "§I2§").status,
        "queued",
    );
    assert.equal(
        f.session
            .deriveMessages()
            .find((message) => message.id === original.data.id)
            .content.filter((block) => block.type === "image").length,
        2,
    );
    const result = await f.engine.compactNow(f.agent, signal());
    assert.ok(result);
    assert.equal(
        f.calls[0].messages
            .flatMap((message) => message.content)
            .filter((block) => block.type === "image").length,
        1,
    );
    const state = f.engine.state(f.session);
    assert.deepEqual(state.lastSummary.excludedIds, ["§I2§"]);
    assert.deepEqual(
        state.lastSummary.projection.attachments.map((item) => item.action),
        ["marked-excluded", "native-image"],
    );
    assert.equal(state.entries.find((entry) => entry.id === "§I2§").status, "released");
    assert.equal(state.entries.find((entry) => entry.id === "§I3§").status, "summarized");
    assert.deepEqual(f.session.eventAt(original.seq).data.content, original.data.content);
    const outcome = await f.invoke("context_expand", { id: "§I2§" });
    assert.equal(outputValue(outcome).representation, "native-image");
    assert.equal(outcome.content.filter((block) => block.type === "image").length, 1);
});

for (const inputModalities of [["text"], null]) {
    test(`summary target ${inputModalities === null ? "unknown" : "text-only"} retains references and adjacent conclusions`, async (t) => {
        const f = await attachmentFixture(t, { inputModalities });
        const ref = await f.store.saveImage({ data: png(), mediaType: "image/png" });
        await admit(f, [evidence, { type: "image", attachment: ref }]);
        await f.engine.compactNow(f.agent, signal());
        const content = f.calls[0].messages.flatMap((message) => message.content);
        assert.equal(
            content.some((block) => block.type === "image"),
            false,
        );
        assert.match(
            content
                .filter((block) => block.type === "text")
                .map((block) => block.text)
                .join(""),
            /Attachment conclusion/,
        );
        assert.equal(
            f.engine.state(f.session).lastSummary.projection.attachments[0].action,
            "reference-only",
        );
        const outcome = await f.invoke("context_expand", { id: "§I2§" });
        assert.equal(outputValue(outcome).status, "capability_unsupported");
        assert.equal(
            outcome.content.some((block) => block.type === "image"),
            false,
        );
    });
}

test("file recovery verifies all bytes and returns a host-mapped handle, never native file ingestion", async (t) => {
    const f = await attachmentFixture(t);
    const bytes = Buffer.from("original file body without normalization\n");
    const ref = await f.store.saveFile({ data: bytes, name: "report.txt" });
    await admit(f, [evidence, { type: "file", attachment: ref }]);
    const outcome = await f.invoke("context_expand", { id: "§F2§" });
    assert.equal(outcome.isError, false);
    const value = outputValue(outcome);
    assert.equal(value.representation, "file-handle");
    assert.equal(value.verifiedBytes, bytes.length);
    assert.ok((await realpath(f.store.fileHostPath(ref))).startsWith(`${f.root}/`));
    assert.deepEqual(await readFile(f.store.fileHostPath(ref)), bytes);
    assert.deepEqual(outcome.content.find((block) => block.type === "file").attachment, ref);
    const result = await f.invoke("context_search", { query: "Attachment conclusion" });
    assert.ok(JSON.stringify(outputValue(result)).includes("§F2§"));
    assert.equal(
        (await f.invoke("context_release", { ids: ["§F2§"], reason: "file consumed" })).isError,
        false,
    );
    await f.engine.compactNow(f.agent, signal());
    // The independently recovered control-tool copy remains unmarked evidence.
    assert.equal(
        f.calls[0].messages
            .flatMap((message) => message.content)
            .filter((block) => block.type === "file").length,
        1,
    );
    assert.equal(
        f.engine.state(f.session).lastSummary.projection.attachments[0].action,
        "marked-excluded",
    );
});

test("binary corruption and deletion fail recovery instead of claiming verified availability", async (t) => {
    const f = await attachmentFixture(t);
    const ref = await f.store.saveFile({ data: Buffer.from("correct bytes"), name: "report.txt" });
    await admit(f, [evidence, { type: "file", attachment: ref }]);
    const path = f.store.fileHostPath(ref);
    assert.ok((await realpath(path)).startsWith(`${f.root}/`));
    await chmod(path, 0o600);
    await writeFile(path, "wrong---bytes");
    const corrupt = await f.invoke("context_expand", { id: "§F2§" });
    assert.equal(corrupt.isError, true);
    assert.equal(
        corrupt.content.some((block) => block.type === "file"),
        false,
    );
    assert.ok((await realpath(path)).startsWith(`${f.root}/`));
    await rm(path);
    const missing = await f.invoke("context_expand", { id: "§F2§" });
    assert.equal(missing.isError, true);
});

test("attachment recovery requires this session's original occurrence and an available store", async (t) => {
    const f = await attachmentFixture(t);
    const ref = await f.store.saveImage({ data: png(), mediaType: "image/png" });
    await admit(f, [evidence, { type: "image", attachment: ref }]);
    const slot = images(f)[0];
    await assert.rejects(
        expandAttachment(
            f.ctx,
            f.agent,
            f.engine.state(f.session),
            { ...slot, blockIndex: 0 },
            { signal: signal() },
        ),
        /missing or inconsistent/,
    );
    await assert.rejects(
        expandAttachment(f.ctx, f.agent, f.engine.state(f.session), slot, {
            signal: AbortSignal.abort(),
        }),
        { name: "AbortError" },
    );
    const other = await fixture();
    t.after(other.close);
    const outcome = await other.invoke("context_expand", { id: slot.id });
    assert.equal(outputValue(outcome).status, "unknown");
    const noStore = await fixture();
    t.after(noStore.close);
    await admit(noStore, [evidence, { type: "image", attachment: ref }]);
    assert.equal(
        outputValue(await noStore.invoke("context_expand", { id: "§I2§" })).status,
        "attachment_store_unavailable",
    );
});
