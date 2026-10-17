import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SessionLogOffset } from "@deepseek-ai/dsh-session";
import { loopFixture, assertTestRoot, call } from "./loop-fixture.mjs";
import { previousAdmissionLedger } from "../lib/domain/admission-ledger.js";

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

test("inline release changes only the T body before a covering checkpoint, with stable intervening prefixes", async (t) => {
    const original = "LEDGER_RELEASE_ORIGINAL ".repeat(900);
    let target;
    let source;
    let checked = false;
    const f = await setup(t, {
        auto: false,
        scheduling: { enabled: false },
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
                return call("context_release", { ids: [target], reason: "Consumed evidence" });
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
                assert.match(textOf(currentResult), new RegExp(target.replace(/§$/, "R§")));
                priorResult.content = currentResult.content;
                assert.deepEqual(
                    request.messages.slice(0, expected.length),
                    expected,
                    "only the deliberately released T body changes in the prior request",
                );
                const notice = latestNotice(request);
                assert.match(textOf(notice), new RegExp(`${target.replace(/§$/, "R§")} released`));
                assert.ok(notice.source.ledgerView.rows.length <= 8);
                return call("context_status", { ids: [target] });
            },
            (request, world) => {
                assert.equal(world.summaries.length, 0);
                assertPrefix(world.requests.at(-2), request);
                return call("context_compact", { reason: "Checkpoint after releasing" });
            },
            (request, world) => {
                assert.equal(world.summaries.length, 1);
                const session = world.sessions.list()[0];
                const state = world.engine.state(session);
                assert.equal(
                    state.entries.find((entry) => entry.id === target).status,
                    "summarized",
                );
                assert.ok(state.lastSummary.ids.includes(target));
                assert.equal(
                    state.lastSummary.excludedIds.includes(target),
                    false,
                    "the covering summary cannot exclude an original body already released inline",
                );
                const notice = latestNotice(request);
                const text = textOf(notice);
                assert.match(text, new RegExp(`${target} summarized`));
                assert.match(text, /lastSummary: coverage/);
                assert.equal(notice.source.ledgerView.summaryWatermark, state.lastSummary.seq);
                assert.doesNotMatch(text, new RegExp(`${target} queued`));
                assert.ok(notice.source.ledgerView.rows.length <= 8);
                assert.equal(
                    session
                        .deriveMessages()
                        .some((message) =>
                            message.content.some(
                                (block) =>
                                    block.type === "text" &&
                                    block.text.startsWith(
                                        `[${target.replace(/§$/, "R§")} body released;`,
                                    ),
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
                const durable = session
                    .snapshotEvents()
                    .find((event) => event.type === "user/message" && event.data.id === notice.id);
                assert.deepEqual(durable.data.source.ledgerView, notice.source.ledgerView);
                checked = true;
                return { blocks: [{ type: "text", text: "Continue from the current summary." }] };
            },
        ],
    });
    const handle = await f.create();
    await f.followup(handle, "Preserve this goal through the checkpoint. ".repeat(180));
    assert.equal(checked, true);
    assert.equal(f.requests.length, 5);
    assertPrefix(f.requests[0], f.requests[1]);
    assertPrefix(f.requests[2], f.requests[3]);
    await f.followup(handle, "Continue with the covered evidence.");
    assertPrefix(f.requests[4], f.requests[5]);
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

test("ordinary request prefixes and unrelated runtime context survive concise ledger admission", async (t) => {
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
        const notice = latestNotice(request);
        assert.equal(notice.source.allocation.version, 3);
        assert.ok(notice.source.ledgerView.rows.length <= 8);
        assert.deepEqual(JSON.parse(JSON.stringify(notice.source)), notice.source);
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

test("cold resume reuses committed source view while legacy fork bootstraps", async (t) => {
    const f = await setup(t, {});
    const parent = await f.create();
    await f.followup(parent, "Keep the original objective.");
    const sessionId = parent.agent.session.id;
    const before = previousAdmissionLedger(parent.agent.session);
    await f.flush(parent);
    await parent.dispose();
    const resumed = await f.resume(sessionId);
    assert.deepEqual(previousAdmissionLedger(resumed.agent.session), before);
    await f.followup(resumed, "Continue after cold resume.");
    const resumedNotice = latestNotice(f.requests.at(-1));
    assert.doesNotMatch(textOf(resumedNotice), /ledger bootstrap/);
    const seed = JSON.parse(JSON.stringify(resumed.agent.session.snapshotEvents()));
    for (const event of seed)
        if (event.type === "user/message" && event.data.source.kind === "fold-context-allocation")
            delete event.data.source.ledgerView;
    const fork = await f.create({
        seed,
        inheritedEventCount: SessionLogOffset(seed.length),
        meta: { cwd: f.root, parentSession: sessionId, isSeeded: true },
    });
    assert.equal(previousAdmissionLedger(fork.agent.session), null);
    await f.followup(fork, "Continue the legacy fork.");
    const bootstrap = latestNotice(f.requests.at(-1));
    assert.match(textOf(bootstrap), /Release ledger bootstrap \(bounded\)/);
    assert.ok(bootstrap.source.ledgerView.rows.length <= 8);
    assert.deepEqual(
        JSON.parse(JSON.stringify(bootstrap.source.ledgerView)),
        bootstrap.source.ledgerView,
    );
});
