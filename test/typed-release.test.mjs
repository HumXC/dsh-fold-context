import test from "node:test";
import assert from "node:assert/strict";
import {
    createAssistantMessage,
    createUserMessage,
    createToolResultMessage,
} from "@deepseek-ai/dsh-llm";
import * as sessionRuntime from "@deepseek-ai/dsh-session";
import * as meterRuntime from "@deepseek-ai/dsh-token-meter";
import { fixture } from "./fixture.mjs";
import { recordLegacyRelease } from "./legacy-release-fixture.mjs";
import { entryId } from "../lib/domain/protocol.js";
import { summaryRecords } from "./summary-records.mjs";

function appendAssistant(f, content, { step = 1, replayState, stream = [], usage } = {}) {
    f.session.append("step/start", { turn: 1, step });
    const message = createAssistantMessage({
        source: {
            provider: "test",
            model: "fixture",
            ...(replayState === undefined ? {} : { replayState }),
        },
        content,
    });
    const event = f.session.append(
        "assistant/message",
        {
            turn: 1,
            step,
            message,
            stream,
            ...(usage === undefined ? {} : { usage }),
        },
        { surfaceOp: "append" },
    );
    for (const block of content.filter((block) => block.type === "tool-call")) {
        const call = f.session.append("tool/call", {
            turn: 1,
            step,
            callId: block.id,
            name: block.name,
            arguments: block.arguments,
        });
        f.session.append(
            "tool/result",
            {
                turn: 1,
                step,
                message: createToolResultMessage({
                    callId: block.id,
                    content: [{ type: "text", text: "result retained" }],
                    isError: false,
                }),
            },
            { surfaceOp: "append", sourceEventSeqs: [call.seq] },
        );
    }
    f.session.append("step/end", { turn: 1, step });
    f.advanceSteps(step);
    return event;
}

function value(outcome) {
    assert.equal(outcome.isError, false, JSON.stringify(outcome));
    return JSON.parse(outcome.content[0].text);
}

async function compactSurface(f) {
    const nodes = f.session.surface.nodes;
    return f.engine.compactRegion(nodes[0], nodes.at(-1), f.agent);
}

test("role prefixes share one monotonic ordinal independently of event sequences", async (t) => {
    const f = await fixture();
    t.after(f.close);
    f.session.append("turn/start", { turn: 1 });
    const user = f.appendUser("User evidence.");
    const tool = f.toolRound("read", "tool evidence");
    assert.equal(f.idFor(user), "§U1§");
    assert.equal(f.idFor(tool), "§T3§");
    assert.deepEqual(
        f.engine.state(f.session).numbering.slots.map((slot) => slot.id),
        ["§U1§", "§A2§", "§T3§"],
    );
    assert.equal(entryId("assistant", 17), "§A17§");
    assert.throws(() => entryId("user", 0));
    assert.equal(
        value(await f.invoke("context_release", { ids: ["§A1§"], reason: "wrong role" })).accepted,
        false,
    );
});

for (const schedulingEnabled of [false, true]) {
    test(`current v6 tool release settles at the next boundary with scheduling ${schedulingEnabled ? "enabled" : "disabled"}`, async (t) => {
        const f = await fixture({
            scheduling: {
                enabled: schedulingEnabled,
                minIntervalSteps: 100,
                minSavingsTokens: 1000000,
            },
        });
        t.after(f.close);
        f.session.append("turn/start", { turn: 1 });
        const user = f.appendUser("Keep the user's conversation text.");
        const replayState = { response: { signature: "opaque-provider-signature" } };
        const content = [
            { type: "text", text: "Keep the assistant's explanation." },
            { type: "tool-call", id: "current-release-call", name: "read", arguments: "{}" },
        ];
        const assistant = appendAssistant(f, content, { replayState });
        const tool = f.engine.state(f.session).entries.find((entry) => entry.role === "tool");
        const ids = [f.idFor(user), f.idFor(assistant)];
        const rejected = value(
            await f.invoke("context_release", {
                ids: [...ids, tool.id],
                reason: "conversation text must reject the entire mixed request",
            }),
        );
        assert.equal(rejected.accepted, false);
        assert.equal(rejected.dshContextCompression, null);
        for (const id of [...ids, tool.id]) {
            assert.equal(
                f.engine.state(f.session).entries.find((entry) => entry.id === id).status,
                "available",
            );
        }
        const accepted = value(
            await f.invoke("context_release", {
                ids: [tool.id],
                reason: "the result body is consumed",
            }),
        );
        assert.equal(accepted.accepted, true);
        assert.equal(accepted.dshContextCompression.version, 6);
        assert.equal(
            f.engine.state(f.session).entries.find((entry) => entry.id === tool.id).releaseMode,
            "inline",
        );
        assert.equal(
            f.engine.state(f.session).entries.find((entry) => entry.id === tool.id).status,
            "queued",
        );
        await f.engine.compactIfNeeded(f.agent, "pressure", new AbortController().signal);
        assert.equal(
            f.engine.state(f.session).entries.find((entry) => entry.id === tool.id).status,
            "released",
        );
        assert.equal(f.calls.length, 0);
        assert.equal(f.engine.state(f.session).lastSummary, null);
        assert.deepEqual(f.session.deriveEventMessage(user), user.data);
        assert.deepEqual(f.session.deriveEventMessage(assistant), assistant.data.message);
        assert.deepEqual(assistant.data.message.source.replayState, replayState);
        assert.equal(
            value(await f.invoke("context_expand", { id: tool.id })).text,
            "result retained",
        );
        const restored = sessionRuntime.Session.create(f.session.id, f.session.snapshotEvents());
        assert.deepEqual(f.engine.state(restored), f.engine.state(f.session));
    });
}

test("legacy queued user text changes only the summary input and keeps original structured content recoverable", async (t) => {
    const f = await fixture();
    t.after(f.close);
    f.session.append("turn/start", { turn: 1 });
    const content = [
        { type: "text", text: "Obsolete user evidence. ".repeat(200) },
        { type: "reasoning", text: "Preserved non-text content." },
        { type: "text", text: "Second text block. ".repeat(200) },
    ];
    const original = f.session.append(
        "user/message",
        createUserMessage({ source: { kind: "user" }, content }),
        { surfaceOp: "append" },
    );
    const id = f.idFor(original);
    recordLegacyRelease(f, [id], "requirements represented");
    const before = {
        nodes: [...f.session.surface.nodes],
        replaceGeneration: f.session.surface.replaceGeneration,
        contentGeneration: f.session.surface.contentGeneration,
    };
    assert.equal(
        await f.engine.compactIfNeeded(f.agent, "pressure", new AbortController().signal),
        null,
    );
    assert.deepEqual(
        {
            nodes: [...f.session.surface.nodes],
            replaceGeneration: f.session.surface.replaceGeneration,
            contentGeneration: f.session.surface.contentGeneration,
        },
        before,
    );
    assert.deepEqual(original.data.content, content);
    await compactSurface(f);
    const supplied = summaryRecords(f.calls[0].messages).filter((record) => record.role === "user");
    assert.deepEqual(
        supplied.map(({ type, text }) => ({ type, text })),
        [content[1]],
    );
    const entry = f.engine.state(f.session).entries.find((entry) => entry.id === id);
    assert.equal(entry.status, "released");
    assert.equal(entry.currentSeq, null);
    assert.deepEqual(f.engine.state(f.session).lastSummary.excludedIds, [id]);
    const expanded = value(await f.invoke("context_expand", { id, limit: 16000 }));
    assert.deepEqual(JSON.parse(expanded.text), content);
    const restored = sessionRuntime.Session.create(f.session.id, f.session.snapshotEvents());
    assert.deepEqual(
        f.engine.state(restored).entries.find((entry) => entry.id === id),
        entry,
    );
    assert.deepEqual(restored.deriveMessages(), f.session.deriveMessages());
    assert.equal(
        f.session.snapshotEvents().some((event) => event.type === "compaction/prune"),
        false,
    );
});

test("legacy assistant text exclusion omits old reasoning independently and retains unmarked calls without rewrites", async (t) => {
    const f = await fixture();
    t.after(f.close);
    f.session.append("turn/start", { turn: 1 });
    f.appendUser("Continue the task.");
    const content = [
        { type: "text", text: "Consumed assistant explanation. ".repeat(300) },
        { type: "reasoning", text: "Retained reasoning." },
        { type: "tool-call", id: "preserved-call", name: "read", arguments: "{}" },
        { type: "text", text: "Consumed follow-up explanation. ".repeat(100) },
    ];
    const usage = { inputTokens: 1000, outputTokens: 300, cacheReadTokens: 40 };
    const stream = [{ type: "chunk", time: 1, chunk: { type: "usage", usage } }];
    const original = appendAssistant(f, content, { stream, usage });
    const id = f.idFor(original);
    recordLegacyRelease(f, [id], "explanation consumed");
    await compactSurface(f);
    const supplied = summaryRecords(f.calls[0].messages);
    assert.equal(
        supplied.some((record) => [content[0].text, content[1].text].includes(record.text)),
        false,
    );
    assert.equal(
        supplied.some(
            (record) => record.type === "tool-call" && record.callId === "preserved-call",
        ),
        true,
    );
    assert.equal(
        supplied.some((record) => record.role === "tool" && record.callId === "preserved-call"),
        true,
    );
    assert.equal(f.engine.state(f.session).lastSummary.projection.omittedReasoning[0].id, id);
    assert.deepEqual(original.data.message.content, content);
    assert.deepEqual(original.data.stream, stream);
    assert.deepEqual(original.data.usage, usage);
    assert.equal(
        f.session
            .snapshotEvents()
            .filter((event) => event.type === "assistant/message" && event.surfaceOp !== "append")
            .length,
        0,
    );
    assert.deepEqual(f.engine.state(f.session).lastSummary.excludedIds, [id]);
    const expanded = value(await f.invoke("context_expand", { id, limit: 16000 }));
    assert.deepEqual(JSON.parse(expanded.text), content);
});

test("legacy signed assistant and paired result are excluded from fresh evidence while original signatures remain intact", async (t) => {
    const f = await fixture();
    t.after(f.close);
    f.session.append("turn/start", { turn: 1 });
    const user = f.appendUser("User text that can be excluded. ".repeat(200));
    const replayState = {
        response: { adapter: "opaque" },
        blocks: [{ signature: "retain" }, { signature: "tool" }],
    };
    const content = [
        { type: "text", text: "Signed text. ".repeat(200) },
        { type: "tool-call", id: "signed-call", name: "read", arguments: "{}" },
    ];
    const assistant = appendAssistant(f, content, { replayState });
    const tool = f.engine.state(f.session).entries.find((entry) => entry.role === "tool");
    const ids = [f.idFor(user), f.idFor(assistant), tool.id];
    recordLegacyRelease(f, ids, "consumed");
    await compactSurface(f);
    const supplied = summaryRecords(f.calls[0].messages);
    assert.equal(
        supplied.some(
            (record) =>
                [user.data.content[0].text, content[0].text].includes(record.text) ||
                record.callId === "signed-call",
        ),
        false,
    );
    assert.equal(JSON.stringify(f.calls[0].messages).includes("opaque"), false);
    assert.deepEqual(assistant.data.message.source.replayState, replayState);
    assert.deepEqual(f.engine.state(f.session).lastSummary.excludedIds, ids);
    for (const id of ids)
        assert.equal(
            f.engine.state(f.session).entries.find((entry) => entry.id === id).status,
            "released",
        );
});

test("legacy summary-only release runs on original rc.2 dependencies without assistant rewrite capabilities", async (t) => {
    const f = await fixture();
    t.after(f.close);
    assert.equal("ASSISTANT_CONTENT_REWRITE_VERSION" in sessionRuntime, false);
    assert.equal("ASSISTANT_CONTENT_REWRITE_VERSION" in meterRuntime, false);
    assert.equal(typeof f.engine.flushReleases, "undefined");
    f.session.append("turn/start", { turn: 1 });
    f.appendUser("Keep the ongoing task objective. ".repeat(200));
    const original = appendAssistant(f, [{ type: "text", text: "Long body. ".repeat(200) }]);
    const id = f.idFor(original);
    recordLegacyRelease(f, [id], "consumed");
    await compactSurface(f);
    assert.equal(
        f.engine.state(f.session).entries.find((entry) => entry.id === id).status,
        "released",
    );
});
