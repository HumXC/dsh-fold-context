import test from "node:test";
import assert from "node:assert/strict";
import { createAssistantMessage, createUserMessage } from "@deepseek-ai/dsh-llm";
import { fixture } from "./fixture.mjs";
import { commitForcedReleases } from "./release-batch-fixture.mjs";

const data = (outcome) => {
    assert.equal(outcome.isError, false, JSON.stringify(outcome));
    return JSON.parse(
        outcome.content.map((block) => (block.type === "text" ? block.text : "")).join(""),
    );
};
const invoke = async (f, name, args) => data(await f.invoke(name, args));
const signal = () => new AbortController().signal;

test("released Unicode originals expand exactly through bounded pages without undoing release", async (t) => {
    const f = await fixture();
    t.after(f.close);
    const original = "A🧠é\n".repeat(5000);
    const event = f.toolRound("read", original);
    const id = f.idFor(event);
    await f.invoke("context_release", { ids: [Number(id)], reason: "Consumed" });
    commitForcedReleases(f);
    assert.equal(f.engine.state(f.session).entries[0].status, "released");
    const surface = [...f.session.surface.nodes];
    let offset = 0;
    let recovered = "";
    do {
        const page = await invoke(f, "context_expand", { id: Number(id), offset, limit: 1703 });
        assert.equal(page.status, "found");
        assert.equal(page.format, "text");
        assert.equal(page.sourceSeq, event.seq);
        assert.equal(page.releaseStatus, "released");
        assert.equal(page.restoresSurface, false);
        assert.ok(Array.from(page.text).length <= 1703);
        assert.equal(page.totalCharacters, Array.from(original).length);
        recovered += page.text;
        offset = page.nextOffset;
    } while (offset !== null);
    assert.equal(recovered, original);
    assert.equal(f.session.eventAt(event.seq).data.message.content[0].text, original);
    assert.equal(f.engine.state(f.session).entries[0].status, "released");
    assert.ok(surface.every((seq) => f.session.surface.nodes.includes(seq)));
    assert.equal(f.engine.state(f.session).entries.length, 1);
});

test("forgotten IDs can be found in summarized originals and expanded after replay", async (t) => {
    const f = await fixture();
    t.after(f.close);
    const event = f.toolRound("read", "ORIGINAL_ONLY_needle\n" + "evidence ".repeat(4000));
    const id = f.idFor(event);
    f.appendUser("Latest user instruction retained. ".repeat(300));
    await f.engine.compactNow(f.agent, signal());
    assert.equal(f.engine.state(f.session).entries[0].status, "summarized");
    assert.ok(
        !f.session
            .deriveMessages()
            .some((message) => JSON.stringify(message.content).includes("ORIGINAL_ONLY_needle")),
    );
    const hits = await invoke(f, "context_search", {
        query: "original_only_NEEDLE",
        roles: ["tool"],
    });
    assert.deepEqual(
        hits.hits.map((hit) => hit.id),
        [id],
    );
    assert.equal(hits.hits[0].releaseStatus, "summarized");
    const restored = f.sessions.create("restored-recovery", {
        seed: f.session.snapshotEvents(),
        inheritedEventCount: f.session.seq,
        meta: { isSeeded: true, parentSession: f.session.id },
    });
    assert.equal(f.engine.state(restored).entries[0].id, id);
    const expanded = data(
        await f.ctx.tools.execute({
            name: "context_expand",
            arguments: { id: Number(id), limit: 40 },
            callId: "restored-expansion",
            agent: { ...f.agent, id: restored.id, session: restored },
            signal: signal(),
        }),
    );
    assert.equal(f.query.reads.at(-1), restored.id);
    assert.equal(
        expanded.text,
        Array.from(event.data.message.content[0].text).slice(0, 40).join(""),
    );
    assert.equal(f.query.activeLeases, 0);
});

test("search cursors keep an original-history cut, filter roles/tools and exclude control chatter", async (t) => {
    const f = await fixture();
    t.after(f.close);
    f.appendUser("needle user evidence");
    const originals = Array.from({ length: 5 }, (_, index) =>
        f.toolRound("read", `needle original ${index}\n${"X".repeat(2000)}`),
    );
    f.toolRound("other", "needle different tool");
    const first = await invoke(f, "context_search", {
        query: "needle",
        roles: ["tool"],
        tool: "read",
        limit: 2,
    });
    assert.equal(first.hits.length, 2);
    assert.ok(first.nextCursor);
    f.toolRound("read", "needle added after first search page");
    const found = [...first.hits];
    let cursor = first.nextCursor;
    while (cursor !== null) {
        const page = await invoke(f, "context_search", {
            query: "needle",
            roles: ["tool"],
            tool: "read",
            limit: 2,
            cursor,
        });
        assert.equal(page.throughSeq, first.throughSeq);
        found.push(...page.hits);
        cursor = page.nextCursor;
    }
    assert.deepEqual(
        found.map((hit) => hit.id),
        originals.map(f.idFor),
    );
    assert.ok(found.every((hit) => Array.from(hit.snippet).length <= 162));
    const changedQuery = await f.invoke("context_search", {
        query: "different",
        roles: ["tool"],
        tool: "read",
        cursor: first.nextCursor,
    });
    assert.equal(changedQuery.isError, true);
    const all = await invoke(f, "context_search", { query: "needle", limit: 20 });
    assert.equal(all.hits.length, 8); // one user and seven ordinary tool results
    assert.ok(!all.hits.some((hit) => hit.tool?.startsWith("context_")));
    assert.equal(f.query.activeLeases, 0);
});

test("literal search, missing IDs and argument bounds remain explicit", async (t) => {
    const f = await fixture();
    t.after(f.close);
    const event = f.toolRound(
        "read",
        "Regex-like [a.*] is literal. Never execute: $(touch /unsafe).\nExact text.",
    );
    const hit = await invoke(f, "context_search", { query: "[a.*]" });
    assert.equal(hit.hits.length, 1);
    assert.equal(hit.hits[0].id, f.idFor(event));
    assert.equal((await invoke(f, "context_search", { query: "[aZZ]" })).hits.length, 0);
    const unknown = await invoke(f, "context_expand", { id: 999999 });
    assert.equal(unknown.status, "unknown");
    const beyond = await invoke(f, "context_expand", {
        id: Number(f.idFor(event)),
        offset: 100000,
    });
    assert.equal(beyond.status, "offset_out_of_range");
    assert.equal(beyond.text, "");
    for (const [name, args] of [
        ["context_expand", { id: "c1" }],
        ["context_expand", { id: f.idFor(event) }],
        ["context_expand", { id: "§T1§" }],
        ["context_expand", { id: 0 }],
        ["context_expand", { id: -1 }],
        ["context_expand", { id: 1.5 }],
        ["context_expand", { id: Number.MAX_SAFE_INTEGER + 1 }],
        ["context_expand", { id: Number(f.idFor(event)), limit: 16001 }],
        ["context_search", { query: "", limit: 1 }],
        ["context_search", { query: "Regex", limit: 21 }],
        ["context_search", { query: "Regex", cursor: "bad" }],
    ])
        assert.equal((await f.invoke(name, args)).isError, true);
});

test("user and assistant originals retain structured content without normalization", async (t) => {
    const f = await fixture();
    t.after(f.close);
    const user = f.session.append(
        "user/message",
        createUserMessage({
            source: { kind: "user" },
            content: [{ type: "text", text: "user original\n  whitespace" }],
        }),
        { surfaceOp: "append" },
    );
    const content = [
        { type: "reasoning", text: "reasoning original" },
        { type: "text", text: "answer\n    code" },
        {
            type: "image",
            attachment: {
                attachmentId: "image-ref",
                mediaType: "image/png",
                bytes: 7,
                width: 1,
                height: 1,
            },
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
    const userResult = await invoke(f, "context_expand", { id: Number(f.idFor(user)) });
    assert.equal(userResult.text, "user original\n  whitespace");
    const assistantResult = await invoke(f, "context_expand", { id: Number(f.idFor(assistant)) });
    assert.equal(assistantResult.format, "content-json");
    assert.deepEqual(JSON.parse(assistantResult.text), content);
    assert.equal(assistantResult.complete, true);
});

test("overlapping session ordinals cannot expose another session's originals or cursor", async (t) => {
    const left = await fixture();
    const right = await fixture();
    t.after(left.close);
    t.after(right.close);
    const leftEvent = left.toolRound("read", "left-private needle");
    const rightEvent = right.toolRound("read", "right-private needle");
    assert.equal(left.idFor(leftEvent), right.idFor(rightEvent));
    assert.equal((await invoke(left, "context_search", { query: "right-private" })).hits.length, 0);
    left.toolRound("read", "left-private needle second result");
    const page = await invoke(left, "context_search", {
        query: "needle",
        roles: ["tool"],
        limit: 1,
    });
    assert.ok(page.nextCursor);
    const foreign = await right.invoke("context_search", {
        query: "needle",
        roles: ["tool"],
        limit: 1,
        cursor: page.nextCursor,
    });
    assert.equal(foreign.isError, true);
    assert.equal(
        (await invoke(right, "context_expand", { id: Number(left.idFor(leftEvent)) })).text,
        "right-private needle",
    );
    assert.ok(left.query.reads.every((id) => id === left.session.id));
    assert.ok(right.query.reads.every((id) => id === right.session.id));
});

test("literal search preserves query whitespace and bounds impossible identifiers", async (t) => {
    const f = await fixture();
    t.after(f.close);
    const original = f.toolRound("read", "BOUNDARY_NEEDLE\n\tindented");
    const bare = await invoke(f, "context_search", { query: "BOUNDARY_NEEDLE", roles: ["tool"] });
    assert.equal(bare.hits[0].id, f.idFor(original));
    const spaced = await invoke(f, "context_search", {
        query: " BOUNDARY_NEEDLE ",
        roles: ["tool"],
    });
    assert.equal(spaced.query, " BOUNDARY_NEEDLE ");
    assert.equal(spaced.hits.length, 0);
    const whitespace = await invoke(f, "context_search", { query: "\n\t", roles: ["tool"] });
    assert.equal(whitespace.hits[0].id, f.idFor(original));
    assert.equal((await f.invoke("context_expand", { id: "9".repeat(1000) })).isError, true);
});
