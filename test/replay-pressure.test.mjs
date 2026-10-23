import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createAssistantMessage, createUserMessage } from "@deepseek-ai/dsh-llm";
import { Session, SessionLogOffset } from "@deepseek-ai/dsh-session";
import { fixture } from "./fixture.mjs";
import {
    createPressureProjection,
    planningPressure,
    pressureStateSchema,
} from "../lib/domain/pressure.js";
import { ledgerProjection } from "../lib/domain/ledger.js";
import { releaseControlProjection } from "../lib/domain/release-controls.js";

const signal = () => new AbortController().signal;
const stateOf = (f) => f.ctx.sessionProjections.stateOf(f.session, "contextCompressionPressure");

test("shared projections replay and accept new events after the registering engine unloads", async (t) => {
    const f = await fixture();
    t.after(f.close);
    const evidence = f.appendUser("Preserve this evidence across plugin instance replacement.");
    const projections = f.ctx.sessionProjections;
    const remaining = f.ctx.plugin({
        name: "remaining-projection-consumer",
        inject: ["sessionProjections"],
        apply(ctx) {
            ctx.sessionProjections.register(ledgerProjection);
            ctx.sessionProjections.register(releaseControlProjection);
            ctx.sessionProjections.register(
                createPressureProjection((message) => f.meter.estimateMessage(message)),
            );
        },
    });
    await remaining.await();
    const replay = () =>
        projections.restore({}, f.session.snapshotEvents(), 0, f.session.header, 0).checkpoint;
    const before = replay();
    assert.ok(
        before.contextCompressionPressure.val.nodes.some((node) => node.seq === evidence.seq),
    );

    await f.pluginFiber.dispose();

    const after = replay();
    for (const key of [
        "contextCompression",
        "contextReleaseControls",
        "contextCompressionPressure",
    ])
        assert.deepEqual(
            after[key],
            before[key],
            `${key} survives its first registrant's disposal`,
        );

    const followup = f.appendUser("Continue processing after the original engine has unloaded.");
    const live = stateOf(f);
    assert.ok(live.nodes.some((node) => node.seq === followup.seq));
    assert.deepEqual(replay().contextCompressionPressure.val, live);
});
function snapshot(f, kind, source, text = "Current configuration. ".repeat(80)) {
    return f.session.append(
        "user/message",
        createUserMessage({ source: { kind, ...source }, content: [{ type: "text", text }] }),
        { surfaceOp: "append" },
    );
}
function answer(f, step, promptTokens, outputTokens = 4096, native = true) {
    f.session.append("step/start", { turn: 1, step });
    const event = f.session.append(
        "assistant/message",
        {
            turn: 1,
            step,
            message: createAssistantMessage({
                source: {
                    provider: "test",
                    model: "fixture",
                    ...(native
                        ? {
                              replayState: {
                                  response: {
                                      provider: "test",
                                      model: "fixture",
                                      api: "openai-responses",
                                  },
                                  blocks: [
                                      {
                                          type: "reasoning",
                                          thinkingSignature: JSON.stringify({
                                              type: "reasoning",
                                              encrypted_content: "opaque-fixture-".repeat(200),
                                          }),
                                      },
                                      { type: "text" },
                                  ],
                              },
                          }
                        : {}),
                },
                content: [
                    { type: "reasoning", text: "" },
                    { type: "text", text: `Finished step ${step}.` },
                ],
            }),
            stream: [
                ...[
                    { type: "reasoning", text: "" },
                    { type: "text", text: `Finished step ${step}.` },
                ].flatMap((block, index) => [
                    {
                        type: "chunk",
                        time: step,
                        chunk: { type: "block-start", index, blockType: block.type },
                    },
                    { type: "chunk", time: step, chunk: { type: "block-end", index, block } },
                ]),
                {
                    type: "chunk",
                    time: step,
                    chunk: {
                        type: "usage",
                        usage: { inputTokens: promptTokens, outputTokens, cacheReadTokens: 0 },
                    },
                },
                { type: "chunk", time: step, chunk: { type: "finish", reason: "stop" } },
            ],
            usage: { inputTokens: promptTokens, outputTokens, cacheReadTokens: 0 },
        },
        { surfaceOp: "append" },
    );
    f.session.append("step/end", { turn: 1, step });
    return event;
}
async function replayWorld(t) {
    const f = await fixture({
        compaction: { auto: true, targetTokens: 16384 },
    });
    t.after(f.close);
    f.llm.resolveModelInfo = async () => ({
        context: { contextWindow: 32768 },
        defaultMaxTokens: 1024,
    });
    f.session.append("turn/start", { turn: 1 });
    snapshot(
        f,
        "compact-checkpoint",
        { compactionId: randomUUID() },
        "Previous requirements. ".repeat(400),
    );
    snapshot(f, "agent-instructions", {
        form: "instructions",
        baseline: true,
        baselineIdentity: "same-workspace",
        changes: [],
    });
    snapshot(f, "plugin:@wingsky-1/dsh-mcp-manager", { form: "snapshot", sections: [] });
    f.appendUser("Build the requested scene and preserve the camera requirements.");
    const originals = [];
    for (let step = 1; step <= 7; step++) {
        const pressure = planningPressure(stateOf(f));
        originals.push(answer(f, step, pressure.surfaceTokens + 500));
    }
    f.appendUser("Latest user requirement: keep the current scene editable. ".repeat(30));
    return { ...f, originals };
}

test("Blender-shaped replay selects high-cost assistant history and preserves native pricing and signatures", async (t) => {
    const f = await replayWorld(t);
    const originalMessages = f.originals.map((e) => structuredClone(e.data.message));
    const before = f.engine.pressureStatus(f.session);
    assert.ok(before.totalTokens > 16384);
    assert.ok(before.replayExtraTokens > 27000);
    assert.ok(
        f.meter.measure(f.session).surfaceTokens < 8192,
        "visible-price retention would miss the replay history",
    );
    const result = await f.engine.compactIfNeeded(f.agent, "pressure", signal());
    assert.ok(result);
    assert.equal(f.calls.length, 1);
    const summaries = f.session.snapshotEvents().filter((e) => e.type === "compaction/summary");
    assert.equal(summaries.length, 1);
    const selected = summaries[0].data.shadowedSeqs;
    assert.ok(
        f.originals.slice(0, 4).every((e) => selected.includes(e.seq)),
        "old native replay must enter the summarized prefix",
    );
    assert.ok(!selected.includes(f.originals.at(-1).seq), "recent replay tail remains verbatim");
    const nativeShadowPrice = selected.reduce(
        (sum, seq) =>
            sum + f.meter.estimateMessage(f.session.deriveEventMessage(f.session.eventAt(seq))),
        0,
    );
    assert.equal(summaries[0].data.shadowedTokenCount, nativeShadowPrice);
    const after = f.engine.pressureStatus(f.session);
    assert.ok(after.totalTokens < 16384, `planning pressure remains ${after.totalTokens}`);
    assert.ok(after.removedReplayTokens > 12000);
    assert.equal(
        after.effect.status,
        "awaiting_usage",
        "a new checkpoint is not provider verification",
    );
    f.originals.forEach((e, i) =>
        assert.deepEqual(f.session.eventAt(e.seq).data.message, originalMessages[i]),
    );
    const measuredInput = planningPressure(stateOf(f)).surfaceTokens + 500;
    answer(f, 8, measuredInput, 32, false);
    const verified = f.engine.pressureStatus(f.session);
    assert.equal(verified.effect.status, "effective");
    assert.equal(verified.effect.observedPromptTokens, measuredInput);
    assert.ok(verified.effect.observedSavingsTokens > 12000);
    const replay = createPressureProjection((m) => f.meter.estimateMessage(m));
    const cold = f.session
        .snapshotEvents()
        .reduce((state, e) => replay.apply(state, e), replay.init());
    assert.deepEqual(pressureStateSchema.parse(cold), pressureStateSchema.parse(stateOf(f)));
});

test("regenerated instruction and MCP baselines alone never buy another summary", async (t) => {
    const f = await fixture({ compaction: { auto: true, targetTokens: 2048 } });
    t.after(f.close);
    f.llm.resolveModelInfo = async () => ({
        context: { contextWindow: 4096 },
        defaultMaxTokens: 1024,
    });
    f.session.append("turn/start", { turn: 1 });
    snapshot(
        f,
        "compact-checkpoint",
        { compactionId: randomUUID() },
        "Old checkpoint. ".repeat(1000),
    );
    snapshot(f, "agent-instructions", {
        form: "instructions",
        baseline: true,
        baselineIdentity: "same",
        changes: [],
    });
    snapshot(f, "plugin:@wingsky-1/dsh-mcp-manager", { form: "snapshot", sections: [] });
    f.appendUser("Current task. ".repeat(160));
    const original = f.session.snapshotEvents();
    for (let i = 0; i < 3; i++)
        assert.equal(await f.engine.compactIfNeeded(f.agent, "pressure", signal()), null);
    assert.equal(f.calls.length, 0);
    assert.deepEqual(f.session.snapshotEvents(), original);
    assert.equal((await f.engine.schedulingStatus(f.agent)).reason, "no_business_evidence");
    snapshot(
        f,
        "agent-instructions",
        { form: "instructions", changes: [{ action: "update", scope: "project" }] },
        "New instruction changes. ".repeat(120),
    );
    f.appendUser("Latest current requirement. ".repeat(160));
    assert.ok(await f.engine.compactIfNeeded(f.agent, "pressure", signal()));
    assert.equal(f.calls.length, 1);
});

test("route changes discard old provider calibration and replay prices", async (t) => {
    const f = await replayWorld(t);
    assert.ok(f.engine.pressureStatus(f.session).replayExtraTokens > 0);
    f.session.append("request/header", {
        header: { config: { provider: "other", model: "other", maxTokens: 1024 } },
        reason: "model-switch",
    });
    const pressure = f.engine.pressureStatus(f.session);
    assert.equal(pressure.replayExtraTokens, 0);
    assert.equal(pressure.providerPromptTokens, null);
    assert.equal(pressure.usageSeq, null);
});

test("primary usage, not summary usage, verifies ineffective compaction and adjusts future retention", async (t) => {
    const f = await fixture({ summary: "New checkpoint. ".repeat(10) });
    t.after(f.close);
    f.session.append("turn/start", { turn: 1 });
    f.appendUser("Earlier work. ".repeat(100));
    f.appendUser("Keep this latest requirement.");
    await f.engine.compactRegion(
        f.session.surface.nodes[0],
        f.session.surface.nodes[0],
        f.agent,
        signal(),
    );
    const pending = f.engine.pressureStatus(f.session).effect;
    assert.equal(pending.status, "awaiting_usage");
    assert.equal(pending.observedPromptTokens, null);
    const postSurface = planningPressure(stateOf(f)).surfaceTokens;
    f.appendUser("Additional work after the summary. ".repeat(10));
    const movement = planningPressure(stateOf(f)).surfaceTokens - postSurface;
    answer(f, 1, pending.beforeTokens + movement + 1000, 20, false);
    const checked = f.engine.pressureStatus(f.session);
    assert.equal(checked.effect.status, "ineffective");
    assert.equal(checked.effect.observedSavingsTokens, -1000);
    assert.equal(checked.retentionPenalty, 1);
});

test("observed reduction above the target remains unresolved and expands the next pressure selection", async (t) => {
    const f = await replayWorld(t);
    await f.engine.compactIfNeeded(f.agent, "pressure", signal());
    const pending = f.engine.pressureStatus(f.session).effect;
    answer(f, 8, pending.beforeTokens - 1000, 32, false);
    const status = await f.engine.schedulingStatus(f.agent);
    assert.equal(
        status.pressure.effect.status,
        "effective",
        "a reduction alone does not prove a safe budget",
    );
    assert.equal(status.pressure.verification, "above_threshold");
    assert.equal(status.pressure.estimatedBelowThreshold, false);
    const remainingReplay = f.originals.filter((e) => f.session.surface.nodes.includes(e.seq));
    assert.ok(remainingReplay.length > 0);
    const next = await f.engine.compactIfNeeded(f.agent, "pressure", signal());
    assert.ok(next, "verified budget miss must not settle for checkpoint-only suppression");
    const summaries = f.session.snapshotEvents().filter((e) => e.type === "compaction/summary");
    assert.ok(
        summaries
            .at(-1)
            .data.shadowedSeqs.some((seq) => remainingReplay.some((e) => e.seq === seq)),
    );
    assert.ok(
        remainingReplay.every((e) => !f.session.surface.nodes.includes(e.seq)),
        "verified miss uses the widest safe prefix",
    );
    answer(f, 9, planningPressure(stateOf(f)).surfaceTokens + 500, 32, false);
    assert.equal(
        (await f.engine.schedulingStatus(f.agent)).pressure.verification,
        "below_threshold",
    );
});

test("primary attempt usage preserves the settled native correction anchor", async (t) => {
    const f = await replayWorld(t);
    await f.engine.compactIfNeeded(f.agent, "pressure", signal());
    const before = f.engine.pressureStatus(f.session);
    const nativeBefore = f.meter.measure(f.session).totalTokens;
    f.session.append("step/start", { turn: 1, step: 8 });
    f.session.append("assistant/attempt", {
        turn: 1,
        step: 8,
        stream: [
            {
                type: "chunk",
                time: 8,
                chunk: {
                    type: "usage",
                    usage: { inputTokens: before.totalTokens, outputTokens: 0 },
                },
            },
            { type: "chunk", time: 8, chunk: { type: "finish", reason: "error" } },
        ],
    });
    f.session.append("step/end", { turn: 1, step: 8 });
    const after = f.engine.pressureStatus(f.session);
    assert.equal(f.meter.measure(f.session).totalTokens, nativeBefore);
    assert.ok(before.removedReplayTokens > 0);
    assert.equal(after.removedReplayTokens, before.removedReplayTokens);
    assert.equal(after.totalTokens, before.totalTokens);
});

test("real provider stream prices latest output once when retained and when summarized", async (t) => {
    const f = await replayWorld(t);
    const before = f.engine.pressureStatus(f.session);
    const tail = f.session.deriveEventMessage(f.session.eventAt(f.session.surface.nodes.at(-1)));
    const expected = before.providerPromptTokens + 4096 + f.meter.estimateMessage(tail);
    assert.ok(Math.abs(before.totalTokens - expected) < 64, `${before.totalTokens} vs ${expected}`);
    await f.engine.compactRegion(
        f.session.surface.nodes[0],
        f.originals.at(-1).seq,
        f.agent,
        signal(),
    );
    const after = f.engine.pressureStatus(f.session);
    assert.equal(after.replayExtraTokens, 0);
    assert.ok(after.removedReplayTokens > 27000);
    assert.ok(Math.abs(after.totalTokens - (after.surfaceTokens + 500)) < 64);
});

test("identical nonempty baseline regeneration is skipped but changed workspace identity is evidence", async (t) => {
    const f = await fixture({ compaction: { auto: true, targetTokens: 2048 } });
    t.after(f.close);
    f.llm.resolveModelInfo = async () => ({
        context: { contextWindow: 4096 },
        defaultMaxTokens: 1024,
    });
    f.session.append("turn/start", { turn: 1 });
    snapshot(
        f,
        "compact-checkpoint",
        { compactionId: randomUUID() },
        "Old checkpoint. ".repeat(1000),
    );
    const source = {
        kind: "agent-instructions",
        form: "instructions",
        baseline: true,
        baselineIdentity: "workspace-A",
        changes: [{ action: "update", scope: "project" }],
    };
    const content = [{ type: "text", text: "Actual project rules. ".repeat(100) }];
    let baseline = f.session.append("user/message", createUserMessage({ source, content }), {
        surfaceOp: "append",
    });
    f.appendUser("Latest task. ".repeat(160));
    baseline = f.session.append("user/message", createUserMessage({ source, content }), {
        surfaceOp: { op: "replace", startSeq: baseline.seq, endSeq: baseline.seq },
        sourceEventSeqs: [baseline.seq],
    });
    assert.equal(await f.engine.compactIfNeeded(f.agent, "pressure", signal()), null);
    assert.equal(f.calls.length, 0);
    f.session.append(
        "user/message",
        createUserMessage({
            source: { ...source, baselineIdentity: "workspace-B", changes: [] },
            content,
        }),
        {
            surfaceOp: { op: "replace", startSeq: baseline.seq, endSeq: baseline.seq },
            sourceEventSeqs: [baseline.seq],
        },
    );
    assert.ok(await f.engine.compactIfNeeded(f.agent, "pressure", signal()));
    assert.equal(f.calls.length, 1);
});

test("model metadata races never escape to the unguarded native pressure selection", async (t) => {
    const f = await fixture({ compaction: { auto: true, targetTokens: 2048 } });
    t.after(f.close);
    f.session.append("turn/start", { turn: 1 });
    snapshot(
        f,
        "compact-checkpoint",
        { compactionId: randomUUID() },
        "Old checkpoint. ".repeat(1000),
    );
    snapshot(f, "agent-instructions", { form: "instructions", baseline: true, changes: [] });
    f.appendUser("Latest task. ".repeat(160));
    let changed = false;
    f.llm.resolveModelInfo = async () => {
        if (!changed) {
            changed = true;
            snapshot(f, "fold-context-release-cleanup", {}, "Management notice.");
        }
        return { context: { contextWindow: 4096 }, defaultMaxTokens: 1024 };
    };
    assert.equal(await f.engine.compactIfNeeded(f.agent, "pressure", signal()), null);
    assert.equal(f.calls.length, 0);
    assert.ok(!f.session.snapshotEvents().some((e) => e.type === "compaction/start"));
});

for (const verified of [false, true])
    test(`route changes immediately invalidate ${verified ? "observed" : "pending"} compaction verification`, async (t) => {
        const f = await replayWorld(t);
        await f.engine.compactIfNeeded(f.agent, "pressure", signal());
        if (verified) answer(f, 8, planningPressure(stateOf(f)).surfaceTokens + 500, 32, false);
        f.session.append("request/header", {
            header: { config: { provider: "other", model: "other", maxTokens: 1024 } },
            reason: "change",
        });
        assert.equal(f.engine.pressureStatus(f.session).effect.status, "route_changed");
        assert.equal(
            (await f.engine.schedulingStatus(f.agent)).pressure.verification,
            "route_changed",
        );
    });

test("verified budget miss preserves the fresh user task before trailing management notices", async (t) => {
    const f = await replayWorld(t);
    await f.engine.compactIfNeeded(f.agent, "pressure", signal());
    answer(f, 8, f.engine.pressureStatus(f.session).effect.beforeTokens - 1000, 32, false);
    const currentUser = f.appendUser("Keep this exact fresh task and its acceptance criteria.");
    snapshot(f, "fold-context-release-cleanup", {}, "Trailing management notice.");
    assert.ok(await f.engine.compactIfNeeded(f.agent, "pressure", signal()));
    assert.ok(f.session.surface.nodes.includes(currentUser.seq));
    assert.equal(
        f.session.eventAt(currentUser.seq).data.content[0].text,
        "Keep this exact fresh task and its acceptance criteria.",
    );
    assert.ok(f.originals.every((e) => !f.session.surface.nodes.includes(e.seq)));
});

test("pressure state survives cached hydration and fork with an unverified compaction", async (t) => {
    const f = await replayWorld(t);
    await f.engine.compactIfNeeded(f.agent, "pressure", signal());
    const expected = f.engine.pressureStatus(f.session);
    const checkpoint = JSON.parse(JSON.stringify(f.ctx.sessionProjections.checkpoint(f.session)));
    const seed = JSON.parse(JSON.stringify(f.session.snapshotEvents()));
    const cold = Session.create(f.session.id, seed, f.session.header);
    const floor = f.ctx.sessionProjections.restoreFloor(checkpoint) ?? SessionLogOffset(0);
    f.ctx.sessionProjections.hydrate(
        cold,
        checkpoint,
        seed.filter((e) => e.seq >= floor),
        floor,
    );
    const fork = f.sessions.fork(f.session);
    for (const session of [cold, fork]) {
        assert.deepEqual(f.engine.pressureStatus(session), expected);
        assert.deepEqual(
            f.ctx.sessionProjections.stateOf(session, "contextCompressionPressure").snapshots,
            stateOf(f).snapshots,
        );
    }
});
