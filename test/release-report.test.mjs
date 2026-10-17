import test from "node:test";
import assert from "node:assert/strict";
import { Session } from "@deepseek-ai/dsh-session";
import { fixture } from "./fixture.mjs";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { apply } from "../lib/index.js";

const reportOf = (event) =>
    event.type === "compaction/prune" ? event.data.foldContextRelease : null;
const reports = (session) => session.snapshotEvents().filter((event) => reportOf(event));
const boundary = (f) => f.engine.compactIfNeeded(f.agent, "pressure", new AbortController().signal);

test("a completed batch records one durable presentation receipt without altering model content", async (t) => {
    const f = await fixture();
    t.after(f.close);
    const first = f.toolRound("read", "Original one. 🧠 ".repeat(1000));
    const second = f.toolRound("grep", "Original two. ".repeat(1000));
    const ids = [f.idFor(first), f.idFor(second)];
    const originals = JSON.stringify([first, second]);
    await f.invoke("context_release", { ids, reason: "Evidence consumed" });
    assert.equal(reports(f.session).length, 0, "queued intent is not a completion");
    await boundary(f);
    const completed = reports(f.session);
    assert.equal(completed.length, 1);
    const report = reportOf(completed[0]);
    assert.equal(report.version, 1);
    const replacement = f.session.eventAt(report.completionSeq);
    assert.equal(replacement.type, "tool/result");
    assert.ok(replacement.sourceEventSeqs.includes(report.targetSeq));
    assert.deepEqual(replacement.data.message.source, second.data.message.source);
    assert.deepEqual(report.released.map((item) => item.id).sort(), [...ids].sort());
    assert.ok(report.released.every((item) => item.displayId.endsWith("R§")));
    assert.ok(report.released.every((item) => item.reason === "Evidence consumed"));
    assert.ok(report.released.every((item) => Array.from(item.preview).length <= 120));
    assert.equal(report.pending.length, 0);
    assert.equal(JSON.stringify([first, second]), originals);
    for (const seq of f.session.surface.nodes) {
        const event = f.session.eventAt(seq);
        const message = f.session.deriveEventMessage(event);
        if (message) assert.ok(!JSON.stringify(message.content).includes("foldContextRelease"));
    }
    const replay = Session.create(
        f.session.id,
        JSON.parse(JSON.stringify(f.session.snapshotEvents())),
        f.session.header,
    );
    assert.deepEqual(reportOf(reports(replay)[0]), report);
    assert.deepEqual(f.engine.state(replay), f.engine.state(f.session));
    await f.invoke("context_release", { ids, reason: "Repeated intent" });
    await boundary(f);
    assert.equal(reports(f.session).length, 1, "duplicate marks do not create another completion");
});

test("attachment completion reports only newly changed occurrences across successive rewrites", async (t) => {
    const f = await fixture();
    t.after(f.close);
    const image = {
        type: "image",
        attachment: {
            attachmentId: "first",
            mediaType: "image/png",
            bytes: 128,
            width: 1,
            height: 1,
        },
    };
    const input = createUserMessage({
        source: { kind: "user" },
        content: [
            { type: "text", text: "Keep surrounding evidence" },
            image,
            { ...image, attachment: { ...image.attachment, attachmentId: "second" } },
        ],
    });
    const signal = new AbortController().signal;
    const decision = await f.ctx.waterfall(
        "agent/pre-step",
        { agent: f.agent, messages: [input], turn: 1, step: 1, signal },
        async () => ({ kind: "enter", messages: [input] }),
    );
    for (const message of decision.messages)
        f.session.append("user/message", message, { surfaceOp: "append" });
    const ids = f.engine
        .state(f.session)
        .numbering.attachments.filter((item) => item.kind === "image")
        .map((item) => item.id);
    assert.equal(ids.length, 2);
    await f.invoke("context_release", { ids: [ids[0]], reason: "First image used" });
    await boundary(f);
    const firstReport = reportOf(reports(f.session)[0]);
    assert.deepEqual(
        firstReport.released.map((item) => item.id),
        [ids[0]],
    );
    await f.invoke("context_release", { ids: [ids[1]], reason: "Second image used" });
    await boundary(f);
    const allReports = reports(f.session).map(reportOf);
    assert.equal(allReports.length, 2);
    assert.deepEqual(
        allReports[1].released.map((item) => item.id),
        [ids[1]],
    );
    assert.notEqual(allReports[0].batchId, allReports[1].batchId);
});

test("the profile UI mount has no engine side effects", () => {
    assert.doesNotThrow(() => apply({}, { uiOnly: true }));
});
