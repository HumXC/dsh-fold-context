import test from "node:test";
import assert from "node:assert/strict";
import { Session } from "@deepseek-ai/dsh-session";
import { fixture } from "./fixture.mjs";

const signal = () => new AbortController().signal;
const originalText = () => "HEAD🧠\n" + "ORIGINAL_MIDDLE_EVIDENCE ".repeat(4000) + "\nTAIL🧠";
const decode = (outcome) => {
    assert.equal(outcome.isError, false);
    return JSON.parse(
        outcome.content
            .filter((block) => block.type === "text")
            .map((block) => block.text)
            .join(""),
    );
};

async function recover(f, id) {
    let offset = 0;
    let text = "";
    do {
        const page = decode(await f.invoke("context_expand", { id, offset, limit: 16000 }));
        assert.equal(page.status, "found");
        text += page.text;
        offset = page.nextOffset;
    } while (offset !== null);
    return text;
}

test("optional official pruner mounts beside fold-context and leaves below-pressure results unchanged", async (t) => {
    const f = await fixture({ pruner: {}, compaction: { auto: true } });
    t.after(f.close);
    const original = originalText();
    const event = f.toolRound("read", original);
    const before = f.session.seq;
    assert.equal(await f.engine.compactIfNeeded(f.agent, "pressure", signal()), null);
    assert.equal(f.session.seq, before);
    assert.equal(f.calls.length, 0);
    assert.equal(f.session.deriveEventMessage(event).content[0].text, original);
    assert.ok(f.ctx.toolResultPruner);
});

for (const auto of [false, true]) {
    test(`v6 semantic release precedes optional pressure pruning with auto=${auto}`, async (t) => {
        const f = await fixture({
            pruner: {},
            compaction: { auto },
            scheduling: { enabled: false },
        });
        t.after(f.close);
        const original = originalText();
        const event = f.toolRound("read", original);
        const id = f.idFor(event);
        const alias = id.replace(/§$/, "R§");
        const originalEvents = f.session.snapshotEvents();
        const receipt = await f.invoke("context_release", { ids: [id], reason: "Consumed" });
        assert.equal(decode(receipt).accepted, true);
        assert.equal(receipt.meta.dshContextCompression.version, 6);
        assert.equal(
            f.engine.state(f.session).entries.find((entry) => entry.id === id).status,
            "queued",
        );
        f.llm.resolveModelInfo = async () => ({
            context: { contextWindow: 8192 },
            defaultMaxTokens: 1024,
            inputModalities: ["text"],
        });
        const observedPrunerStates = [];
        const pruneSession = f.ctx.toolResultPruner.pruneSession.bind(f.ctx.toolResultPruner);
        f.ctx.toolResultPruner.pruneSession = (...args) => {
            observedPrunerStates.push(
                f.engine.state(f.session).entries.find((entry) => entry.id === id).status,
            );
            return pruneSession(...args);
        };
        assert.equal(await f.engine.compactIfNeeded(f.agent, "pressure", signal()), null);
        assert.equal(f.calls.length, 0);
        assert.equal(f.engine.state(f.session).lastSummary, null);
        assert.ok(observedPrunerStates.every((status) => status === "released"));
        const entry = f.engine.state(f.session).entries.find((item) => item.id === id);
        assert.equal(entry.status, "released");
        const replacement = f.session
            .snapshotEvents()
            .find((candidate) => candidate.seq === entry.currentSeq);
        assert.equal(replacement.type, "tool/result");
        assert.deepEqual(replacement.sourceEventSeqs, [event.seq]);
        assert.equal(replacement.data.message.toolCallId, event.data.message.toolCallId);
        const trimmed = replacement.data.message.content
            .map((block) => (block.type === "text" ? block.text : ""))
            .join("");
        assert.match(trimmed, new RegExp(alias));
        assert.doesNotMatch(trimmed, /tool result middle pruned|ORIGINAL_MIDDLE_EVIDENCE/);
        assert.ok(Array.from(trimmed).length <= 8192);
        assert.deepEqual(
            f.session.snapshotEvents().slice(0, originalEvents.length),
            originalEvents,
        );
        const slot = f.engine.state(f.session).numbering.slots.find((item) => item.id === id);
        assert.equal(slot.sourceSeq, event.seq);
        assert.equal(slot.currentSeq, replacement.seq);
        const replay = Session.create(f.session.id, f.session.snapshotEvents(), f.session.header);
        assert.deepEqual(f.engine.state(replay), f.engine.state(f.session));
        const surface = [...f.session.surface.nodes];
        assert.equal(await recover(f, alias), original);
        assert.equal(
            f.engine.state(f.session).entries.find((item) => item.id === id).status,
            "released",
        );
        assert.deepEqual(f.session.surface.nodes.slice(0, surface.length), surface);
        assert.equal(
            f.engine.state(f.session).entries.find((item) => item.id === id).currentSeq,
            replacement.seq,
        );
    });
}

test("an official-pruned tool pair without release is summarized normally and retains its original", async (t) => {
    const f = await fixture({ pruner: {} });
    t.after(f.close);
    const original = originalText();
    const event = f.toolRound("read", original);
    const id = f.idFor(event);
    const pruned = f.ctx.toolResultPruner.pruneSession(f.session);
    assert.equal(pruned.pruned.length, 1);
    assert.equal(
        f.engine.state(f.session).entries.find((entry) => entry.id === id).status,
        "available",
    );
    f.appendUser("Keep the current task and its next action. ".repeat(100));
    assert.ok(await f.engine.compactNow(f.agent, signal()));
    const state = f.engine.state(f.session);
    assert.equal(state.entries.find((entry) => entry.id === id).status, "summarized");
    assert.ok(state.lastSummary.ids.includes(id));
    assert.equal(state.lastSummary.excludedIds.includes(id), false);
    assert.equal(JSON.stringify(f.calls[0].messages).includes("tool result middle pruned"), true);
    assert.equal(await recover(f, id), original);
});
