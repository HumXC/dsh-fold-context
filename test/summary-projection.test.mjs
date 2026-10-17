import test from "node:test";
import assert from "node:assert/strict";
import { createAssistantMessage, createUserMessage } from "@deepseek-ai/dsh-llm";
import { Session } from "@deepseek-ai/dsh-session";
import { fixture } from "./fixture.mjs";
import { recordLegacyRelease } from "./legacy-release-fixture.mjs";
import { catalog } from "../lib/domain/planner.js";
import { projectSummaryInput } from "../lib/domain/summary-projection.js";
import {
    projectionStamp,
    readProjectionStamp,
    resolveSummaryPolicy,
} from "../lib/domain/summary-policy.js";

function assistant(f, content, replayState = { response: { private: "opaque-signature" } }) {
    f.session.append("step/start", { turn: 1, step: 1 });
    const event = f.session.append(
        "assistant/message",
        {
            turn: 1,
            step: 1,
            stream: [],
            message: createAssistantMessage({
                source: { provider: "private-provider", model: "source-model", replayState },
                content,
            }),
        },
        { surfaceOp: "append" },
    );
    f.session.append("step/end", { turn: 1, step: 1 });
    f.advanceSteps(1);
    return event;
}
function records(messages) {
    return messages.flatMap((message) =>
        message.content.flatMap((block) =>
            block.type === "text" && block.text.startsWith("{") ? [JSON.parse(block.text)] : [],
        ),
    );
}
async function compact(f) {
    const nodes = f.session.surface.nodes;
    return f.engine.compactRegion(nodes[0], nodes.at(-1), f.agent);
}

test("default transcript omits signed assistant reasoning, records it separately and retains exact source", async (t) => {
    const f = await fixture();
    t.after(f.close);
    f.session.append("turn/start", { turn: 1 });
    f.appendUser("Task and necessary evidence. ".repeat(200));
    const content = [
        { type: "reasoning", text: "秘密🙂" },
        { type: "text", text: "Conclusion. ".repeat(100) },
    ];
    const source = assistant(f, content);
    const id = f.idFor(source);
    await compact(f);
    assert.equal(
        f.calls[0].messages.some(
            (message) => message.role === "assistant" || message.role === "tool",
        ),
        false,
    );
    assert.equal(JSON.stringify(f.calls[0].messages).includes("opaque-signature"), false);
    assert.equal(
        records(f.calls[0].messages).some((record) => record.text === content[0].text),
        false,
    );
    assert.equal(
        records(f.calls[0].messages).find(
            (record) => record.role === "assistant" && record.type === "text",
        ).text,
        content[1].text,
    );
    const report = f.engine.state(f.session).lastSummary;
    assert.deepEqual(report.excludedIds, []);
    assert.deepEqual(report.projection.omittedReasoning, [
        { id, sourceSeq: source.seq, currentSeq: source.seq, blockIndex: 0, characters: 3 },
    ]);
    assert.deepEqual(source.data.message.content, content);
    const restored = Session.create(f.session.id, f.session.snapshotEvents());
    assert.deepEqual(f.engine.state(restored).lastSummary, report);
    // Current config does not reinterpret the historical strategy.
    assert.equal(
        catalog(f.engine.state(restored), { catalogLimit: 1 }, 1, undefined, {
            reasoning: "preserve",
        }).lastSummary.projection.reasoning,
        "omit-from-summary",
    );
    assert.deepEqual(f.calls[0].tools, undefined);
});

test("preserve encodes reasoning as historical data without native signatures", async (t) => {
    const f = await fixture({ reasoning: "preserve" });
    t.after(f.close);
    f.session.append("turn/start", { turn: 1 });
    f.appendUser("Evidence. ".repeat(300));
    const source = assistant(f, [
        { type: "reasoning", text: "Exact thought\n🙂" },
        { type: "text", text: "Conclusion." },
    ]);
    await compact(f);
    assert.equal(
        records(f.calls[0].messages).find((record) => record.type === "reasoning").text,
        "Exact thought\n🙂",
    );
    assert.equal(
        f.calls[0].messages.some((message) =>
            message.content.some((block) => block.type === "reasoning"),
        ),
        false,
    );
    assert.deepEqual(f.engine.state(f.session).lastSummary.projection.omittedReasoning, []);
    assert.equal(f.engine.state(f.session).lastSummary.projection.reasoning, "preserve");
    assert.equal(source.data.message.source.replayState.response.private, "opaque-signature");
});

test("legacy marked signed explanation can be excluded without masquerading as its original response", async (t) => {
    const f = await fixture();
    t.after(f.close);
    f.session.append("turn/start", { turn: 1 });
    f.appendUser("User requirements. ".repeat(300));
    const source = assistant(f, [
        { type: "text", text: "Discard explanation." },
        { type: "reasoning", text: "Old thought" },
    ]);
    const id = f.idFor(source);
    recordLegacyRelease(f, [id], "consumed");
    await compact(f);
    assert.equal(
        records(f.calls[0].messages).some((record) =>
            ["Discard explanation.", "Old thought"].includes(record.text),
        ),
        false,
    );
    assert.equal(
        records(f.calls[0].messages).some(
            (record) => record.role === "user" && record.text === "User requirements. ".repeat(300),
        ),
        true,
    );
    assert.deepEqual(f.engine.state(f.session).lastSummary.excludedIds, [id]);
    assert.equal(f.engine.state(f.session).lastSummary.projection.omittedReasoning[0].id, id);
});

test("legacy attachment references stay native beside history records; failed target does not settle marks", async (t) => {
    const f = await fixture({
        onStream: () => {
            throw new Error("image target unsupported");
        },
    });
    t.after(f.close);
    f.session.append("turn/start", { turn: 1 });
    f.appendUser("Evidence. ".repeat(300));
    const source = assistant(f, [{ type: "text", text: "Old text" }]);
    const image = {
        type: "image",
        attachment: {
            attachmentId: "image",
            mediaType: "image/png",
            bytes: 1,
            width: 1,
            height: 1,
        },
    };
    f.session.append(
        "user/message",
        createUserMessage({ source: { kind: "user" }, content: [image] }),
        { surfaceOp: "append" },
    );
    const state = f.engine.state(f.session);
    const messages = f.session.deriveMessages();
    const projected = projectSummaryInput(state, messages, f.session.seq, {
        reasoning: "omit-from-summary",
        images: "native",
    });
    assert.deepEqual(
        projected.at(-1).content.find((block) => block.type === "image"),
        image,
    );
    assert.equal(
        records(projected).find((record) => record.type === "image").attachment.attachmentId,
        "image",
    );
    recordLegacyRelease(f, [f.idFor(source)], "consumed");
    await assert.rejects(compact(f), /image target unsupported/);
    assert.deepEqual(
        f.calls[0].messages
            .flatMap((message) => message.content)
            .find((block) => block.type === "image"),
        image,
    );
    assert.equal(f.engine.state(f.session).lastSummary, null);
    assert.equal(
        f.engine.state(f.session).entries.find((entry) => entry.id === f.idFor(source)).status,
        "queued",
    );
});

test("historical omission report is independently bounded and exact-ID discoverable", async (t) => {
    const f = await fixture();
    t.after(f.close);
    const state = structuredClone(f.engine.state(f.session));
    state.lastSummary = {
        seq: 5001,
        ids: [],
        excludedIds: [],
        projection: {
            version: 1,
            reasoning: "omit-from-summary",
            omittedReasoning: Array.from({ length: 5000 }, (_, i) => ({
                id: `§A${i + 1}§`,
                sourceSeq: i,
                currentSeq: i,
                blockIndex: 0,
                characters: 3,
            })),
        },
    };
    const view = catalog(state, { catalogLimit: 1 }, 1);
    assert.equal(view.lastSummary.projection.omittedReasoning.length, 1);
    assert.equal(view.lastSummary.projection.omittedReasoningOmitted, 4999);
    assert.equal(view.lastSummary.projection.omittedReasoningCharacters, 15000);
    assert.equal(JSON.stringify(view).length < 1800, true);
    assert.equal(
        catalog(state, { catalogLimit: 1 }, 1, ["§A1§"]).lastSummary.projection.omittedReasoning[0]
            .id,
        "§A1§",
    );
});

test("tool results retain success/failure and empty outcomes in historical evidence", async (t) => {
    const f = await fixture();
    t.after(f.close);
    f.session.append("turn/start", { turn: 1 });
    const original = f.toolRound("read", "42");
    const state = f.engine.state(f.session);
    const messages = f.session.deriveMessages();
    const project = (isError, content = original.data.message.content) =>
        projectSummaryInput(
            state,
            messages.map((message) =>
                message.id === original.data.message.id
                    ? { ...message, isError, content }
                    : message,
            ),
            f.session.seq,
            resolveSummaryPolicy(),
        );
    const success = records(project(false)).find(
        (record) => record.role === "tool" && record.callId === original.data.message.toolCallId,
    );
    const failure = records(project(true)).find(
        (record) => record.role === "tool" && record.callId === original.data.message.toolCallId,
    );
    assert.equal(success.text, failure.text);
    assert.equal(success.isError, false);
    assert.equal(failure.isError, true);
    assert.equal(failure.callId, original.data.message.toolCallId);
    assert.deepEqual(
        records(project(true, [])).find(
            (record) =>
                record.role === "tool" && record.callId === original.data.message.toolCallId,
        ),
        {
            id: null,
            role: "tool",
            type: "tool-result",
            callId: original.data.message.toolCallId,
            isError: true,
            empty: true,
        },
    );
});

test("ambiguous input identities and unknown content fail before native data is forwarded", async (t) => {
    const f = await fixture();
    t.after(f.close);
    f.session.append("turn/start", { turn: 1 });
    const original = f.appendUser("Evidence.");
    const state = f.engine.state(f.session);
    assert.throws(
        () =>
            projectSummaryInput(
                state,
                [original.data, original.data],
                f.session.seq,
                resolveSummaryPolicy(),
            ),
        /ambiguous message/,
    );
    const mutated = { ...original.data, content: [{ type: "future-unsupported-kind" }] };
    assert.throws(
        () => projectSummaryInput(state, [mutated], f.session.seq, resolveSummaryPolicy()),
        /unsupported summary content block/,
    );
    f.session.append("user/message", original.data, { surfaceOp: "append" });
    assert.throws(
        () =>
            projectSummaryInput(
                f.engine.state(f.session),
                [original.data],
                f.session.seq,
                resolveSummaryPolicy(),
            ),
        /ambiguous live message/,
    );
});

test("policy stamp validates transaction identity and refuses unsupported recipes", () => {
    const policy = resolveSummaryPolicy();
    const stamp = projectionStamp(policy, "compaction");
    assert.deepEqual(readProjectionStamp(stamp, "compaction"), {
        reasoning: policy.reasoning,
        images: "references",
        stampVersion: 2,
    });
    assert.equal(readProjectionStamp(stamp, "different"), null);
    assert.equal(readProjectionStamp("[fold-context-projection:2 {}]", "compaction"), null);
    assert.equal(readProjectionStamp("ordinary historical summary", "compaction"), undefined);
    assert.equal(
        readProjectionStamp(
            '[fold-context-projection:1 {"compactionId":"compaction"}]',
            "compaction",
        ),
        null,
    );
    assert.throws(() => resolveSummaryPolicy({ reasoning: "unsafe" }));
});
