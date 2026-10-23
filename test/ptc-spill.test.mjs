import test from "node:test";
import assert from "node:assert/strict";
import * as spillPolicy from "@deepseek-ai/dsh-spill-policy";
import { Session } from "@deepseek-ai/dsh-session";
import { fixture } from "./fixture.mjs";
import { commitForcedReleases } from "./release-batch-fixture.mjs";
import {
    COMPACT_TOOL,
    PTC_INTENT_SOURCE,
    RECEIPT_KEY,
    RELEASE_TOOL,
} from "../lib/domain/protocol.js";

const json = (value) => JSON.parse(JSON.stringify(value));

async function eventsOf(f) {
    using observation = await f.query.observeSession(f.session.id, { projectionMode: "none" });
    return json(observation.events);
}
function replay(f, events) {
    const restored = Session.create(f.session.id, json(events), f.session.header);
    return { session: restored, state: f.engine.state(restored) };
}
async function installSpill(f, maxInlineTokens = 256) {
    const saved = [];
    f.ctx.provide("spillStore", {
        async saveText(input) {
            saved.push(json(input));
            return {
                locator: `memory:${input.owner.sessionId}/${saved.length}`,
                bytes: Buffer.byteLength(input.content),
                retrievalHint: `Read saved artifact ${saved.length}.`,
            };
        },
    });
    await f.ctx.plugin(spillPolicy, { maxInlineTokens }).await();
    return saved;
}

for (const tool of [RELEASE_TOOL, COMPACT_TOOL]) {
    test(`real spill cannot discard a successful PTC ${tool} intent`, async (t) => {
        let ids;
        let value;
        const reason = tool === RELEASE_TOOL ? "Consumed evidence" : "Summarize complete work";
        const f = await fixture({
            ptc: async (tools) => {
                value = await tools[tool](tool === RELEASE_TOOL ? { ids, reason } : { reason });
                return {};
            },
        });
        t.after(f.close);
        f.appendUser("Keep the task objective.");
        ids = Array.from({ length: tool === RELEASE_TOOL ? 128 : 1 }, (_, i) =>
            Number(f.idFor(f.toolRound("read", `Original evidence ${i}. `.repeat(200)))),
        );
        // Summary receipts are small, so use a budget that fits the backend's short
        // locator notice but is below that receipt's canonical JSON estimate.
        const saved = await installSpill(f, tool === RELEASE_TOOL ? 256 : 32);
        const outcome = await f.invoke("run_code", {
            code: "dispatch control",
            description: "Persist control intent",
        });
        assert.equal(outcome.isError, false);
        assert.equal(value[RECEIPT_KEY].version, 9);
        const events = await eventsOf(f);
        const dispatch = events.find(
            (event) => event.type === "tool/ptc-dispatch" && event.data.name === tool,
        );
        assert.ok(dispatch);
        assert.equal(dispatch.data.isError, false);
        assert.throws(() => JSON.parse(dispatch.data.content[0].text));
        const artifact = saved.find(
            (item) => item.source.toolName === tool && item.source.label === "dispatch",
        );
        assert.ok(artifact);
        assert.equal(JSON.parse(artifact.content)[RECEIPT_KEY].version, 9);
        const records = events.filter(
            (event) =>
                event.type === "developer/message" &&
                event.data.message.source.kind === PTC_INTENT_SOURCE,
        );
        assert.equal(records.length, 1);
        assert.equal(records[0].data.message.source.intent.reason, reason);
        assert.equal(f.session.deriveEventMessage(records[0]), null);
        assert.deepEqual(
            f.session.deriveMessages().filter((message) => message.role === "developer"),
            [],
        );
        const state = f.engine.state(f.session);
        if (tool === RELEASE_TOOL) {
            for (const id of ids)
                assert.equal(
                    state.entries.find((entry) => entry.id === String(id)).status,
                    "queued",
                );
        } else {
            assert.equal(state.summaryRequests.length, 1);
            assert.equal(state.summaryRequests[0].status, "queued");
        }
        assert.deepEqual(replay(f, events).state, state);
        // A complete v9 dispatch copy is still display data, and cannot duplicate
        // the independently committed intent on replay.
        const full = json(events);
        full.find((event) => event.seq === dispatch.seq).data.content = [
            { type: "text", text: artifact.content },
        ];
        assert.deepEqual(replay(f, full).state, state);
        if (tool === RELEASE_TOOL) {
            assert.ok(await commitForcedReleases(f));
            for (const id of ids)
                assert.equal(
                    f.engine.state(f.session).entries.find((entry) => entry.id === String(id))
                        .status,
                    "released",
                );
            assert.deepEqual(replay(f, await eventsOf(f)).state, f.engine.state(f.session));
        }
    });
}

test("failed PTC controls never persist an intent, even when a post-policy rejects after execution", async (t) => {
    let id;
    const f = await fixture({
        ptc: async (tools) => {
            await tools.context_release({ ids: [id], reason: "Consumed evidence" });
            return {};
        },
    });
    t.after(f.close);
    f.appendUser("Keep task objective.");
    id = Number(f.idFor(f.toolRound("read", "Original evidence. ".repeat(100))));
    f.ctx.on(
        "tools/post-execute",
        async (exec, result, next) => {
            const decision = await next();
            return exec.name === RELEASE_TOOL
                ? { kind: "block", feedback: [{ type: "text", text: "Test policy rejection" }] }
                : decision;
        },
        { prepend: true },
    );
    await f.invoke("run_code", {
        code: "reject inner call",
        description: "Reject after tool body",
    });
    const events = await eventsOf(f);
    assert.equal(
        events.some(
            (event) =>
                event.type === "developer/message" &&
                event.data.message.source.kind === PTC_INTENT_SOURCE,
        ),
        false,
    );
    assert.equal(
        f.engine.state(f.session).entries.find((entry) => entry.id === String(id)).status,
        "available",
    );
    assert.equal(f.engine.state(f.session).summaryRequests.length, 0);
});
