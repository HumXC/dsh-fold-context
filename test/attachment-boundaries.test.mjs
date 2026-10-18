import test from "node:test";
import assert from "node:assert/strict";
import { Session } from "@deepseek-ai/dsh-session";
import { createAssistantMessage } from "@deepseek-ai/dsh-llm";
import { imageOffloadProjection } from "@deepseek-ai/dsh-compaction-image-offload/projection";
import { planRelease } from "../lib/domain/planner.js";
import { ledgerProjection } from "../lib/domain/ledger.js";
import { attachmentFixture, admit, png } from "./attachment-fixture.mjs";

const signal = () => new AbortController().signal;
const evidence = { type: "text", text: "Retained attachment conclusion. ".repeat(700) };
const folded = (session) =>
    session
        .snapshotEvents()
        .reduce((state, event) => ledgerProjection.apply(state, event), ledgerProjection.init());

test("logged image offload produces a reference receipt in live state and cold replay, while original recovery stays visual", async (t) => {
    const f = await attachmentFixture(t);
    f.sessions.registerMessageProjection(imageOffloadProjection);
    const ref = await f.store.saveImage({ data: png(), mediaType: "image/png" });
    const original = await admit(f, [evidence, { type: "image", attachment: ref }]);
    f.session.append("image/offload", { targets: [{ seq: original.seq, imageIndexes: [0] }] });
    assert.equal(
        f.session
            .deriveMessages()
            .find((message) => message.id === original.data.id)
            .content.find((block) => block.type === "image").offloaded,
        true,
    );
    await f.engine.compactNow(f.agent, signal());
    assert.equal(
        f.calls[0].messages
            .flatMap((message) => message.content)
            .some((block) => block.type === "image"),
        false,
    );
    const state = f.engine.state(f.session);
    assert.equal(state.lastSummary.projection.attachments[0].action, "reference-only");
    assert.deepEqual(folded(f.session), state);
    const outcome = await f.invoke("context_expand", { id: 2 });
    assert.equal(outcome.isError, false);
    assert.deepEqual(
        outcome.content.find((block) => block.type === "image"),
        { type: "image", attachment: ref },
    );
    assert.equal(
        f.session.eventAt(original.seq).data.content.find((block) => block.type === "image")
            .offloaded,
        undefined,
    );
});

test("same-owner replacement exposes its new attachment immediately and cannot resurrect it after a checkpoint", async (t) => {
    const f = await attachmentFixture(t);
    const first = await f.store.saveFile({ data: Buffer.from("first"), name: "first.txt" });
    const second = await f.store.saveFile({ data: Buffer.from("second"), name: "second.txt" });
    const original = await admit(f, [evidence, { type: "file", attachment: first }]);
    const replacement = f.session.append(
        "user/message",
        { ...original.data, content: [evidence, { type: "file", attachment: second }] },
        {
            surfaceOp: { op: "replace", startSeq: original.seq, endSeq: original.seq },
            sourceEventSeqs: [original.seq],
        },
    );
    const state = f.engine.state(f.session);
    const item = state.numbering.attachments.find(
        (slot) => slot.block.attachment.attachmentId === second.attachmentId,
    );
    assert.ok(item);
    assert.equal(item.sourceSeq, replacement.seq);
    assert.equal(state.entries.find((entry) => entry.id === item.id).status, "available");
    assert.deepEqual(planRelease(state, [item.id]).queued, [item.id]);
    await f.engine.compactNow(f.agent, signal());
    assert.ok(f.engine.state(f.session).lastSummary.ids.includes(item.id));
    assert.equal(
        f.engine.state(f.session).entries.find((entry) => entry.id === item.id).status,
        "summarized",
    );
    f.session.append("step/start", { turn: 1, step: 2 });
    f.session.append(
        "assistant/message",
        {
            turn: 1,
            step: 2,
            stream: [],
            message: createAssistantMessage({
                source: { provider: "test", model: "fixture" },
                content: [{ type: "text", text: "Later work." }],
            }),
        },
        { surfaceOp: "append" },
    );
    f.session.append("step/end", { turn: 1, step: 2 });
    assert.equal(
        f.engine.state(f.session).entries.find((entry) => entry.id === item.id).status,
        "summarized",
    );
    assert.deepEqual(folded(f.session), f.engine.state(f.session));
    const restored = Session.create(f.session.id, f.session.snapshotEvents(), f.session.header);
    assert.equal(
        f.engine.state(restored).entries.find((entry) => entry.id === item.id).status,
        "summarized",
    );
});

test("the exact conversation model policy controls summary image capability", async (t) => {
    const f = await attachmentFixture(t, {
        compaction: {
            modelPolicies: [
                {
                    provider: "test",
                    model: "fixture",
                    summarizationProvider: "test",
                    summarizationModel: "text-summary",
                },
            ],
        },
    });
    const requested = [];
    f.llm.resolveModelInfo = async (provider, model) => {
        requested.push([provider, model]);
        return {
            context: { contextWindow: 131072 },
            inputModalities: model === "text-summary" ? ["text"] : ["text", "image"],
            defaultMaxTokens: 1024,
        };
    };
    const ref = await f.store.saveImage({ data: png(), mediaType: "image/png" });
    await admit(f, [evidence, { type: "image", attachment: ref }]);
    await f.engine.compactNow(f.agent, signal());
    assert.ok(requested.some(([, model]) => model === "text-summary"));
    assert.equal(f.calls[0].model, "text-summary");
    assert.equal(
        f.calls[0].messages
            .flatMap((message) => message.content)
            .some((block) => block.type === "image"),
        false,
    );
    assert.equal(
        f.engine.state(f.session).lastSummary.projection.attachments[0].action,
        "reference-only",
    );
});
