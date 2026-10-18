import test from "node:test";
import assert from "node:assert/strict";
import { createAssistantMessage } from "@deepseek-ai/dsh-llm";
import { SessionLogOffset } from "@deepseek-ai/dsh-session";
import { fixture } from "./fixture.mjs";
import { ledgerProjection } from "../lib/domain/ledger.js";

const data = (outcome) => {
    assert.equal(outcome.isError, false, JSON.stringify(outcome));
    return JSON.parse(outcome.content.map((block) => block.text ?? "").join(""));
};

test("assistant control arguments cannot self-match when reasoning or text accompanies the call", async (t) => {
    const f = await fixture();
    t.after(f.close);
    const content = [
        { type: "reasoning", text: "Look for previous evidence." },
        { type: "text", text: "Useful assistant fact: alpha." },
        {
            type: "tool-call",
            id: "search-call",
            name: "context_search",
            arguments: JSON.stringify({ query: "ONLY_IN_QUERY_9471" }),
        },
    ];
    f.session.append("step/start", { turn: 1, step: 1 });
    const assistant = f.session.append(
        "assistant/message",
        {
            turn: 1,
            step: 1,
            message: createAssistantMessage({
                source: { provider: "test", model: "fixture" },
                content,
            }),
            stream: [],
        },
        { surfaceOp: "append" },
    );
    f.session.append("step/end", { turn: 1, step: 1 });
    f.advanceSteps(1);
    const absent = data(
        await f.invoke("context_search", { query: "ONLY_IN_QUERY_9471", roles: ["assistant"] }),
    );
    assert.equal(absent.hits.length, 0);
    const useful = data(
        await f.invoke("context_search", { query: "Useful assistant fact", roles: ["assistant"] }),
    );
    assert.deepEqual(
        useful.hits.map((hit) => hit.id),
        [f.idFor(assistant)],
    );
    const expanded = data(await f.invoke("context_expand", { id: Number(f.idFor(assistant)) }));
    assert.deepEqual(JSON.parse(expanded.text), content);
});

test("literal old marker text cannot settle a queued release and obsolete projection snapshots rebuild from the log", async (t) => {
    const f = await fixture();
    t.after(f.close);
    const original = f.toolRound("read", "LEGACY_RELEASE_ORIGINAL ".repeat(600));
    const id = f.idFor(original);
    await f.invoke("context_release", { ids: [Number(id)], reason: "Consumed" });
    // Reconstruct an already committed legacy tool prune without requiring a prune API.
    f.session.append("compaction/prune", {
        shadowedRange: { start: original.seq, end: original.seq },
        shadowedSeqs: [original.seq],
        shadowedTokenCount: f.meter.estimateMessage(original.data.message),
    });
    const replacement = f.session.append(
        "tool/result",
        {
            ...original.data,
            message: {
                ...original.data.message,
                content: [
                    {
                        type: "text",
                        text: `[released ${id}]`,
                    },
                ],
            },
        },
        {
            surfaceOp: { op: "replace", startSeq: original.seq, endSeq: original.seq },
            sourceEventSeqs: [original.seq],
        },
    );
    assert.equal(replacement.data.message.content[0].text, `[released ${id}]`);
    const checkpoint = f.ctx.sessionProjections.checkpoint(f.session);
    checkpoint.contextCompression.ver = 4;
    assert.equal(f.ctx.sessionProjections.restoreFloor(checkpoint), 0);
    const restored = f.ctx.sessionProjections.restore(
        checkpoint,
        f.session.snapshotEvents(),
        SessionLogOffset(0),
        f.session.header,
        f.session.inheritedEventCount,
    );
    assert.equal(restored.checkpoint.contextCompression.ver, ledgerProjection.stateVersion);
    const restoredEntry = restored.checkpoint.contextCompression.val.entries.find(
        (entry) => entry.id === id,
    );
    assert.equal(restoredEntry.status, "queued");
    assert.equal(restoredEntry.sourceSeq, original.seq);
});

test("archive observation leases are released after a post-read cancellation", async (t) => {
    const f = await fixture();
    t.after(f.close);
    f.toolRound("read", "cancellation evidence");
    const controller = new AbortController();
    const observe = f.query.observeSession.bind(f.query);
    f.query.observeSession = async (...args) => {
        const lease = await observe(...args);
        controller.abort(new Error("isolated read cancelled"));
        return lease;
    };
    const outcome = await f.ctx.tools.execute({
        name: "context_search",
        arguments: { query: "evidence" },
        agent: f.agent,
        callId: "cancelled-read",
        signal: controller.signal,
    });
    assert.equal(outcome.isError, true);
    assert.equal(f.query.activeLeases, 0);
});
