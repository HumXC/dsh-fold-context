import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SessionLogOffset } from "@deepseek-ai/dsh-session";
import { loopFixture, assertTestRoot, call } from "./loop-fixture.mjs";

async function setup(t, options) {
    const root = await mkdtemp(join(tmpdir(), "fold-context-test-"));
    let world;
    t.after(async () => {
        try {
            await world?.close();
        } finally {
            await assertTestRoot(root);
            await rm(root, { recursive: true, force: true });
        }
    });
    world = await loopFixture(root, options);
    return world;
}
const textOf = (message) => message.content.map((block) => block.text ?? "").join("");
const notices = (request) =>
    request.messages.filter((message) => message.source.kind === "fold-context-allocation");
const latestNotice = (request) => notices(request).at(-1);
function assertPrefix(previous, next) {
    assert.deepEqual(
        next.messages.slice(0, previous.messages.length),
        previous.messages,
        "the complete previous ordinary request must stay as an unchanged prefix",
    );
}

test("batched release changes only the tool body before a checkpoint while ordinary prefixes remain stable", async (t) => {
    const original = "LEDGER_RELEASE_ORIGINAL ".repeat(900);
    let target;
    let source;
    let checked = false;
    const f = await setup(t, {
        auto: false,
        compaction: { targetTokens: 2048, cacheReadRatio: 1 },
        // This scenario checks release/replay semantics with an eligible archival checkpoint.
        scheduling: {
            summaryInputRatio: 0.01,
            summaryOutputRatio: 0.01,
        },
        tools: { probe_read: () => original },
        responses: [
            call("probe_read"),
            (_request, world) => {
                const session = world.sessions.list()[0];
                const entry = world.engine
                    .state(session)
                    .entries.find((item) => item.role === "tool");
                target = entry.id;
                source = session.snapshotEvents().find((event) => event.seq === entry.sourceSeq);
                return call("context_release", {
                    ids: [Number(target)],
                    reason: "Consumed evidence",
                });
            },
            (request, world) => {
                assert.equal(world.summaries.length, 0);
                const state = world.engine.state(world.sessions.list()[0]);
                assert.equal(state.lastSummary, null);
                assert.equal(state.entries.find((entry) => entry.id === target).status, "released");
                const expected = structuredClone(world.requests.at(-2).messages);
                const priorResult = expected.find(
                    (message) => message.id === source.data.message.id,
                );
                const currentResult = request.messages.find(
                    (message) => message.id === priorResult.id,
                );
                assert.deepEqual(priorResult.content, [{ type: "text", text: original }]);
                assert.ok(textOf(currentResult).includes(`[released ${target}]`));
                priorResult.content = currentResult.content;
                assert.deepEqual(
                    request.messages.slice(0, expected.length),
                    expected,
                    "only the deliberately released tool body changes in the prior request",
                );
                assert.equal(notices(request).length, notices(world.requests.at(-2)).length + 1);
                return call("context_status", { ids: [Number(target)] });
            },
            (request, world) => {
                assert.equal(world.summaries.length, 0);
                assertPrefix(world.requests.at(-2), request);
                return {
                    blocks: [
                        {
                            type: "text",
                            text: "The released evidence and current objective are recorded.",
                        },
                    ],
                };
            },
            call("context_compact", { reason: "Checkpoint after releasing" }),
            (request, world) => {
                assert.equal(world.summaries.length, 1);
                const session = world.sessions.list()[0];
                const state = world.engine.state(session);
                assert.equal(state.entries.find((entry) => entry.id === target).status, "released");
                assert.ok(state.lastSummary.ids.includes(target));
                assert.equal(
                    state.lastSummary.excludedIds.includes(target),
                    true,
                    "a covering summary excludes original evidence already released before measurement",
                );
                assert.ok(latestNotice(request));
                assert.equal(
                    session
                        .deriveMessages()
                        .some((message) =>
                            message.content.some(
                                (block) =>
                                    block.type === "text" && block.text === `[released ${target}]`,
                            ),
                        ),
                    false,
                );
                assert.equal(
                    JSON.stringify(
                        session.snapshotEvents().find((event) => event.seq === source.seq),
                    ),
                    JSON.stringify(source),
                );
                checked = true;
                return { blocks: [{ type: "text", text: "Continue from the current summary." }] };
            },
        ],
    });
    const handle = await f.create();
    await f.followup(handle, "Preserve this goal through the checkpoint. ".repeat(180));
    assert.equal(f.summaries.length, 0);
    await f.followup(handle, "Checkpoint the completed work and preserve the objective.");
    assert.equal(checked, true);
    assert.equal(f.requests.length, 6);
    assertPrefix(f.requests[0], f.requests[1]);
    assertPrefix(f.requests[2], f.requests[3]);
    await f.followup(handle, "Continue with the covered evidence.");
    assertPrefix(f.requests[5], f.requests[6]);
    assert.ok(
        f.requests.every(
            (request) =>
                !request.messages.some(
                    (message) =>
                        message.source.kind === "runtime-context" &&
                        textOf(message).includes("Context numbering and release ledger"),
                ),
        ),
    );
});

test("ordinary prefixes and unrelated runtime context survive concise notice admission", async (t) => {
    const f = await setup(t, {});
    f.ctx.systemPrompt.context({
        name: "unrelated-test-provider",
        order: 200,
        text: "Unrelated runtime provider remains discoverable.",
    });
    const handle = await f.create();
    for (const input of ["First work item", "Second work item", "Third work item"])
        await f.followup(handle, input);
    assert.equal(f.requests.length, 3);
    assertPrefix(f.requests[0], f.requests[1]);
    assertPrefix(f.requests[1], f.requests[2]);
    for (const request of f.requests) {
        assert.ok(
            request.messages.some(
                (message) =>
                    message.source.kind === "runtime-context" &&
                    textOf(message).includes("Unrelated runtime provider remains discoverable."),
            ),
        );
        assert.equal(notices(request).length, f.requests.indexOf(request) + 1);
    }
    const noticeCharacters = f.requests.reduce(
        (total, request) =>
            total + notices(request).reduce((sum, notice) => sum + textOf(notice).length, 0),
        0,
    );
    assert.ok(
        noticeCharacters < 8011 * 0.6,
        `three snapshots use ${noticeCharacters} notice characters versus old 8011 baseline`,
    );
    t.diagnostic(
        `three ordinary snapshots: ${noticeCharacters} notice characters (old ledger baseline: 8011)`,
    );
    const assembly = await f.ctx.systemPrompt.assemble({ scope: handle.agent });
    assert.ok(assembly.contexts.some((item) => item.name === "unrelated-test-provider"));
    assert.ok(!assembly.contexts.some((item) => item.name === "fold-context:ledger"));
});

test("cold resume and fork retain numbering without bootstrapping visible ledgers", async (t) => {
    const f = await setup(t, {});
    const parent = await f.create();
    await f.followup(parent, "Keep the original objective.");
    const sessionId = parent.agent.session.id;
    const before = f.engine.state(parent.agent.session).numbering;
    await f.flush(parent);
    await parent.dispose();
    const resumed = await f.resume(sessionId);
    assert.deepEqual(f.engine.state(resumed.agent.session).numbering, before);
    await f.followup(resumed, "Continue after cold resume.");
    assert.equal(notices(f.requests.at(-1)).length, 2);
    const seed = JSON.parse(JSON.stringify(resumed.agent.session.snapshotEvents()));
    const fork = await f.create({
        seed,
        inheritedEventCount: SessionLogOffset(seed.length),
        meta: { cwd: f.root, parentSession: sessionId, isSeeded: true },
    });
    await f.followup(fork, "Continue the fork.");
    assert.equal(notices(f.requests.at(-1)).length, 3);
    const numbered = f.requests
        .at(-1)
        .messages.findLast((message) => message.source.kind === "user");
    assert.equal(numbered.content[0].text, "Continue the fork.");
    assert.match(textOf(latestNotice(f.requests.at(-1))), /^prev: [1-9]\d*\nnext: [1-9]\d*$/);
});
