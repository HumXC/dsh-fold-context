import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createUserMessage, LlmError } from "@deepseek-ai/dsh-llm";
import { assertTestRoot, call, loopFixture } from "./loop-fixture.mjs";
import {
    SESSION_SUMMARY_SOURCE,
    SUBMIT_SUMMARY_TOOL,
    sessionSummaryProjection,
} from "../lib/domain/session-summary.js";

const matching = [
    { provider: "test", model: "mock", preferWhenSessionMatches: true, useSessionAgent: true },
];
const business =
    "Preserve the original investigation, verified evidence, and unfinished user action. ".repeat(
        240,
    );
const summary = "Preserve verified evidence and continue the unfinished user action.";
const reply = (text) => ({ blocks: [{ type: "text", text }] });
const signal = () => new AbortController().signal;
const deferred = () => {
    let resolve;
    const promise = new Promise((done) => {
        resolve = done;
    });
    return { promise, resolve };
};
const events = (handle) => handle.agent.session.snapshotEvents();
const state = (world, handle) =>
    world.ctx.sessionProjections.stateOf(handle.agent.session, "contextSessionSummary");
const replay = (list) =>
    list.reduce(
        (value, event) => sessionSummaryProjection.apply(value, event),
        sessionSummaryProjection.init(),
    );
const controls = (list, phase) =>
    list.filter(
        (event) =>
            event.type === "user/message" &&
            event.data.source.kind === SESSION_SUMMARY_SOURCE &&
            event.data.source.control.phase === phase,
    );
const cancelled = (error) => error?.code === "cancelled";
const userMessage = (text) =>
    createUserMessage({ source: { kind: "user" }, content: [{ type: "text", text }] });

async function setup(t, options = {}) {
    const root = await mkdtemp(join(tmpdir(), "fold-context-test-"));
    const world = await loopFixture(root, {
        strictSession: true,
        summaryModels: matching,
        ...options,
    });
    t.after(async () => {
        try {
            await world.close();
        } finally {
            await assertTestRoot(root);
            await rm(root, { recursive: true, force: true });
        }
    });
    return world;
}

for (const mode of ["reject", "throw"]) {
    test(
        `a once-${mode}ed manual pre-step settles admission and leaves the next business request usable`,
        { timeout: 15000 },
        async (t) => {
            const world = await setup(t, {
                responses: [reply("Initial evidence."), reply("Continued business.")],
            });
            const handle = await world.create({
                agentOptions: { provider: "test", model: "mock", maxTokens: 512 },
            });
            await world.followup(handle, business);
            let intercepted = false;
            const failure = new Error("isolated pre-step failure");
            world.ctx.on("agent/pre-step", async ({ messages }, next) => {
                if (
                    !intercepted &&
                    messages.some((message) => message.source.kind === SESSION_SUMMARY_SOURCE)
                ) {
                    intercepted = true;
                    if (mode === "throw") throw failure;
                    return { kind: "reject" };
                }
                return next();
            });
            await assert.rejects(
                world.engine.compactNow(handle.agent, signal()),
                mode === "throw" ? (error) => error === failure : cancelled,
            );
            await handle.agent.whenIdle();
            assert.equal(intercepted, true);
            assert.equal(world.engine.hasSessionSummaryWork(handle.agent.session), false);
            assert.equal(handle.agent.session.requestHeader().config.maxTokens, 512);
            assert.equal(world.requests.length, 1);
            assert.equal(controls(events(handle), "request").length, 0);
            await world.followup(handle, "Continue the unrelated business task.");
            assert.equal(world.requests.length, 2);
            assert.equal(world.requests.at(-1).maxTokens, 512);
            assert.equal(world.summaries.length, 0);
            assert.equal(
                events(handle).filter((event) => event.type === "compaction/start").length,
                0,
            );
        },
    );
}

test(
    "cancellation behind an asynchronous pre-step barrier removes only the helper instruction",
    { timeout: 15000 },
    async (t) => {
        const world = await setup(t, {
            responses: [reply("Initial evidence."), reply("Handled unrelated input.")],
        });
        const handle = await world.create({
            agentOptions: { provider: "test", model: "mock", maxTokens: 512 },
        });
        await world.followup(handle, business);
        const entered = deferred(),
            release = deferred();
        t.after(() => release.resolve());
        const unrelated = userMessage("Unrelated input must survive checkpoint cancellation.");
        world.ctx.on("agent/pre-step", async ({ messages }, next) => {
            const decision = await next();
            if (messages.some((message) => message.source.kind === SESSION_SUMMARY_SOURCE)) {
                entered.resolve();
                await release.promise;
                return {
                    ...decision,
                    startsRequestSeries: true,
                    messages: [...decision.messages, unrelated],
                };
            }
            return decision;
        });
        const controller = new AbortController();
        const completion = world.engine.compactNow(handle.agent, controller.signal);
        const rejected = assert.rejects(completion, cancelled);
        await entered.promise;
        controller.abort(new Error("cancel before first helper request"));
        await rejected;
        release.resolve();
        await handle.agent.whenIdle();
        assert.equal(world.engine.hasSessionSummaryWork(handle.agent.session), false);
        assert.equal(controls(events(handle), "request").length, 0);
        assert.equal(
            events(handle).filter(
                (event) => event.type === "user/message" && event.data.id === unrelated.id,
            ).length,
            1,
        );
        assert.equal(world.requests.length, 2);
        assert.ok(world.requests.at(-1).messages.some((message) => message.id === unrelated.id));
        assert.equal(world.requests.at(-1).maxTokens, 512);
        assert.equal(world.summaries.length, 0);
    },
);

test(
    "finish cancellation after an accepted submission writes a durable terminal control and restores its header",
    { timeout: 15000 },
    async (t) => {
        let handle;
        const world = await setup(t, {
            responses: [
                reply("Initial evidence."),
                (_request, fixture) =>
                    call(SUBMIT_SUMMARY_TOOL, {
                        checkpointId: state(fixture, handle).active.plan.checkpointId,
                        summary,
                    }),
                reply("Continued after cancellation."),
            ],
        });
        handle = await world.create({
            agentOptions: { provider: "test", model: "mock", maxTokens: 512 },
        });
        await world.followup(handle, business);
        let interrupted = false;
        world.ctx.on(
            "agent/turn-stopping",
            ({ agent }) => {
                if (!interrupted && state(world, handle).active?.phase === "submitted") {
                    interrupted = true;
                    agent.cancel({ kind: "user" });
                }
            },
            { prepend: true },
        );
        await assert.rejects(world.engine.compactNow(handle.agent, signal()), cancelled);
        await handle.agent.whenIdle();
        assert.equal(interrupted, true);
        const beforeClose = events(handle);
        const cancelledState = replay(beforeClose).active;
        assert.equal(cancelledState.phase, "cancelled");
        assert.equal(controls(beforeClose, "cancelled").length, 1);
        assert.equal(handle.agent.session.requestHeader().config.maxTokens, 512);
        assert.ok(
            cancelledState.plan.range.seqs.every((seq) =>
                handle.agent.session.surface.nodes.includes(seq),
            ),
        );
        assert.equal(beforeClose.filter((event) => event.type === "compaction/start").length, 0);
        const id = handle.agent.id;
        await world.flush(handle);
        await handle.dispose();
        const resumed = await world.resume(id, {
            agentOptions: { provider: "test", model: "mock", maxTokens: 512 },
        });
        assert.equal(state(world, resumed).active.phase, "cancelled");
        await world.followup(resumed, "Continue the business task after reopening.");
        assert.equal(world.requests.at(-1).maxTokens, 512);
        assert.equal(world.summaries.length, 0);
        const input = world.requests.at(-1).messages;
        assert.ok(
            input.some((message) =>
                message.content.some(
                    (block) => block.type === "tool-call" && block.name === SUBMIT_SUMMARY_TOOL,
                ),
            ),
        );
        assert.ok(input.some((message) => message.source.kind === SESSION_SUMMARY_SOURCE));
        assert.equal(
            events(resumed).some(
                (event) =>
                    event.type === "developer/message" &&
                    event.data.message.source.kind === "fold-context-summary-cleanup",
            ),
            false,
        );
    },
);

for (const mode of ["explicit", "managed", "same-valued-user-choice"]) {
    test(
        `live feature unload cancels pending preparation and respects ${mode} header ownership`,
        { timeout: 15000 },
        async (t) => {
            const modelReasoning = {
                defaultEffort: "high",
                efforts: [
                    { id: "low", name: "Low" },
                    { id: "high", name: "High" },
                ],
            };
            const world = await setup(t, {
                isolatedCompression: true,
                modelReasoning,
                summaryModels: [{ ...matching[0], reasoningEffort: "low" }],
                tools: { probe: () => "Verified helper evidence." },
                responses: [
                    reply("Initial evidence."),
                    call("probe"),
                    reply("Continued after feature unload."),
                    reply("Handled the following business task."),
                ],
            });
            const handle = await world.create({
                agentOptions:
                    mode === "managed"
                        ? { provider: "test", model: "mock" }
                        : {
                              provider: "test",
                              model: "mock",
                              maxTokens: 512,
                              reasoningEffort: "high",
                          },
            });
            await world.followup(handle, business);
            const original = structuredClone(handle.agent.session.requestHeader());
            const entered = deferred(),
                release = deferred();
            t.after(() => release.resolve());
            let paused = false;
            world.ctx.on("agent/pre-step", async (_payload, next) => {
                const decision = await next();
                if (
                    !paused &&
                    world.requests.length === 2 &&
                    state(world, handle).active?.phase === "requested"
                ) {
                    paused = true;
                    entered.resolve();
                    await release.promise;
                }
                return decision;
            });
            const completion = world.engine.compactNow(handle.agent, signal());
            const rejected = assert.rejects(completion, cancelled);
            await entered.promise;
            const plan = state(world, handle).active.plan;
            assert.equal(handle.agent.session.requestHeader().config.maxTokens, 128);
            assert.equal(handle.agent.session.requestHeader().config.reasoningEffort, "low");
            let userHeader;
            if (mode === "same-valued-user-choice") {
                userHeader = structuredClone(handle.agent.session.requestHeader());
                handle.agent.session.append("request/header", {
                    header: userHeader,
                    reason: "change",
                });
                assert.equal(state(world, handle).active.restorePending, false);
            }
            await world.disposeCompression();
            await rejected;
            const current = handle.agent.session.requestHeader();
            if (userHeader) assert.deepEqual(current, userHeader);
            else {
                assert.equal(current.config.maxTokens, original.config.maxTokens);
                assert.equal(current.config.reasoningEffort, original.config.reasoningEffort);
                assert.deepEqual(current.adapterDefaults, original.adapterDefaults);
            }
            const afterUnload = replay(events(handle));
            assert.equal(afterUnload.active.phase, "cancelled");
            assert.ok(
                plan.range.seqs.every((seq) => handle.agent.session.surface.nodes.includes(seq)),
            );
            assert.equal(controls(events(handle), "cancelled").length, 1);
            if (mode === "managed") modelReasoning.defaultEffort = "low";
            release.resolve();
            await handle.agent.whenIdle();
            await world.followup(
                handle,
                "Continue an unrelated business task with compression unloaded.",
            );
            assert.equal(world.requests.at(-1).maxTokens, mode === "explicit" ? 512 : 128);
            assert.equal(
                world.requests.at(-1).reasoningEffort,
                mode === "explicit" ? "high" : "low",
            );
            assert.equal(world.summaries.length, 0);
            assert.equal(
                events(handle).filter((event) => event.type === "compaction/start").length,
                0,
            );
        },
    );
}

test(
    "unloading during asynchronous request preparation prevents a late helper cap",
    { timeout: 15000 },
    async (t) => {
        const world = await setup(t, {
            isolatedCompression: true,
            responses: [reply("Initial evidence."), reply("Continued business.")],
        });
        const handle = await world.create({
            agentOptions: { provider: "test", model: "mock", maxTokens: 512 },
        });
        await world.followup(handle, business);
        const entered = deferred(),
            release = deferred();
        t.after(() => release.resolve());
        let paused = false;
        world.ctx.on("agent/request", async (_payload, next) => {
            const config = await next();
            if (!paused) {
                paused = true;
                entered.resolve();
                await release.promise;
            }
            return config;
        });
        const completion = world.engine.compactNow(handle.agent, signal());
        const rejected = assert.rejects(completion, cancelled);
        await entered.promise;
        await world.disposeCompression();
        await rejected;
        release.resolve();
        await handle.agent.whenIdle();
        assert.equal(world.requests.length, 1);
        assert.equal(handle.agent.session.requestHeader().config.maxTokens, 512);
        await world.followup(
            handle,
            "Continue the business task after request preparation was cancelled.",
        );
        assert.equal(world.requests.at(-1).maxTokens, 512);
        assert.equal(world.summaries.length, 0);
    },
);

test(
    "live unload aborts an independent fallback and closes its transaction before terminal cancellation",
    { timeout: 15000 },
    async (t) => {
        const entered = deferred();
        let fallbackSignal;
        const world = await setup(t, {
            isolatedCompression: true,
            responses: [
                reply("Initial evidence."),
                () => {
                    throw new LlmError("Isolated helper failure", "ADAPTER_ERROR");
                },
                reply("Continued business."),
            ],
            onStream: async (request, _world, ordinary) => {
                if (ordinary) return;
                fallbackSignal = request.signal;
                entered.resolve();
                await new Promise((resolve) => {
                    if (request.signal.aborted) resolve();
                    else request.signal.addEventListener("abort", resolve, { once: true });
                });
                request.signal.throwIfAborted();
            },
        });
        const handle = await world.create({
            agentOptions: { provider: "test", model: "mock", maxTokens: 512 },
        });
        await world.followup(handle, business);
        const completion = world.engine.compactNow(handle.agent, signal());
        const rejected = assert.rejects(completion, cancelled);
        await entered.promise;
        await world.disposeCompression();
        await rejected;
        await handle.agent.whenIdle();
        assert.equal(fallbackSignal.aborted, true);
        assert.equal(world.summaries.length, 1);
        const list = events(handle);
        const ends = list.filter((event) => event.type === "compaction/end");
        const terminal = controls(list, "cancelled");
        assert.equal(ends.length, 1);
        assert.equal(terminal.length, 1);
        assert.ok(ends[0].seq < terminal[0].seq);
        assert.equal(replay(list).active.phase, "cancelled");
        assert.equal(
            list.filter(
                (event) =>
                    event.type === "user/message" &&
                    event.data.source.kind === "compact-checkpoint",
            ).length,
            0,
        );
        assert.equal(handle.agent.session.requestHeader().config.maxTokens, 512);
        await world.followup(
            handle,
            "Continue the original business task after fallback cancellation.",
        );
        assert.equal(world.requests.at(-1).maxTokens, 512);
    },
);

for (const mode of ["explicit", "managed"]) {
    test(
        `idle ${mode} restoration survives feature unload and runs at the next legal ordinary pre-step`,
        { timeout: 15000 },
        async (t) => {
            const modelReasoning = {
                defaultEffort: "high",
                efforts: [
                    { id: "low", name: "Low" },
                    { id: "high", name: "High" },
                ],
            };
            const world = await setup(t, {
                isolatedCompression: true,
                modelReasoning,
                summaryModels: [{ ...matching[0], reasoningEffort: "low" }],
                tools: { probe: () => "Verified helper evidence." },
                responses: [
                    reply("Initial evidence."),
                    call("probe"),
                    reply("Continued after idle unload."),
                    reply("Continued with updated defaults."),
                ],
            });
            const handle = await world.create({
                agentOptions:
                    mode === "managed"
                        ? { provider: "test", model: "mock" }
                        : {
                              provider: "test",
                              model: "mock",
                              maxTokens: 512,
                              reasoningEffort: "high",
                          },
            });
            await world.followup(handle, business);
            const original = structuredClone(handle.agent.session.requestHeader());
            let blocked = false;
            world.ctx.on("agent/pre-step", async (_payload, next) => {
                const decision = await next();
                if (
                    !blocked &&
                    world.requests.length === 2 &&
                    state(world, handle).active?.phase === "requested"
                ) {
                    blocked = true;
                    return { kind: "reject" };
                }
                return decision;
            });
            await assert.rejects(world.engine.compactNow(handle.agent, signal()), cancelled);
            await handle.agent.whenIdle();
            assert.equal(blocked, true);
            const idle = replay(events(handle)).active;
            assert.equal(idle.phase, "cancelled");
            assert.equal(idle.restorePending, true);
            assert.equal(handle.agent.session.requestHeader().config.maxTokens, 128);
            assert.equal(handle.agent.session.requestHeader().config.reasoningEffort, "low");
            await world.disposeCompression();
            // Exercise the public-query recovery boundary after projection unregistration.
            const coordinator = world.engine.sessionSummaries;
            coordinator.detachedStates.delete(handle.agent.session);
            await coordinator.refreshDetachedState(handle.agent.session);
            assert.deepEqual(coordinator.state(handle.agent.session), replay(events(handle)));
            assert.equal(world.query.activeLeases, 0);
            assert.equal(replay(events(handle)).active.restorePending, true);
            const boundary = events(handle).findLast(
                (event) => event.type === "turn/start" || event.type === "turn/end",
            );
            assert.equal(boundary.type, "turn/end");
            assert.ok(
                events(handle).findLast((event) => event.type === "request/header").seq <
                    boundary.seq,
            );
            if (mode === "managed") modelReasoning.defaultEffort = "low";
            await world.followup(
                handle,
                "Continue ordinary work after the feature was unloaded while idle.",
            );
            assert.equal(world.requests.at(-1).maxTokens, original.config.maxTokens);
            assert.equal(
                world.requests.at(-1).reasoningEffort,
                mode === "managed" ? "low" : "high",
            );
            assert.deepEqual(
                handle.agent.session.requestHeader().adapterDefaults,
                original.adapterDefaults,
            );
            assert.equal(replay(events(handle)).active.restorePending, false);
            modelReasoning.defaultEffort = "high";
            await world.followup(handle, "Continue after the adapter default changes again.");
            assert.equal(world.requests.at(-1).reasoningEffort, "high");
            assert.equal(world.requests.at(-1).maxTokens, original.config.maxTokens);
            assert.deepEqual(
                handle.agent.session.requestHeader().adapterDefaults,
                original.adapterDefaults,
            );
            assert.equal(world.summaries.length, 0);
            assert.equal(
                events(handle).filter((event) => event.type === "compaction/start").length,
                0,
            );
        },
    );
}

test(
    "a second manual checkpoint inherits original limits while the idle predecessor still needs restoration",
    { timeout: 15000 },
    async (t) => {
        let handle;
        const world = await setup(t, {
            modelReasoning: {
                defaultEffort: "high",
                efforts: [
                    { id: "low", name: "Low" },
                    { id: "high", name: "High" },
                ],
            },
            summaryModels: [{ ...matching[0], reasoningEffort: "low" }],
            tools: { probe: () => "Verified helper evidence." },
            responses: [
                reply("Initial evidence."),
                call("probe"),
                (_request, fixture) => {
                    const plan = state(fixture, handle).active.plan;
                    assert.equal(plan.originalMaxTokens, 512);
                    assert.equal(plan.originalReasoningEffort, "high");
                    return call(SUBMIT_SUMMARY_TOOL, { checkpointId: plan.checkpointId, summary });
                },
                reply("Continued after the replacement checkpoint."),
            ],
        });
        handle = await world.create({
            agentOptions: {
                provider: "test",
                model: "mock",
                maxTokens: 512,
                reasoningEffort: "high",
            },
        });
        await world.followup(handle, business);
        let blocked = false;
        world.ctx.on("agent/pre-step", async (_payload, next) => {
            const decision = await next();
            if (
                !blocked &&
                world.requests.length === 2 &&
                state(world, handle).active?.phase === "requested"
            ) {
                blocked = true;
                return { kind: "reject" };
            }
            return decision;
        });
        await assert.rejects(world.engine.compactNow(handle.agent, signal()), cancelled);
        await handle.agent.whenIdle();
        assert.equal(replay(events(handle)).active.restorePending, true);
        assert.equal(handle.agent.session.requestHeader().config.maxTokens, 128);
        assert.ok(await world.engine.compactNow(handle.agent, signal()));
        await handle.agent.whenIdle();
        assert.equal(state(world, handle).active.phase, "committed");
        assert.equal(handle.agent.session.requestHeader().config.maxTokens, 512);
        assert.equal(handle.agent.session.requestHeader().config.reasoningEffort, "high");
        await world.followup(handle, "Continue after the second checkpoint.");
        assert.equal(world.requests.at(-1).maxTokens, 512);
        assert.equal(world.requests.at(-1).reasoningEffort, "high");
        assert.equal(world.summaries.length, 0);
    },
);

test(
    "normal Agent close retains accepted submission and restores owned limits at legal reopen without another summary call",
    { timeout: 15000 },
    async (t) => {
        let handle;
        const modelReasoning = {
            defaultEffort: "high",
            efforts: [
                { id: "low", name: "Low" },
                { id: "high", name: "High" },
            ],
        };
        const world = await setup(t, {
            modelReasoning,
            summaryModels: [{ ...matching[0], reasoningEffort: "low" }],
            responses: [
                reply("Initial evidence."),
                (_request, fixture) =>
                    call(SUBMIT_SUMMARY_TOOL, {
                        checkpointId: state(fixture, handle).active.plan.checkpointId,
                        summary,
                    }),
                reply("Resumed the business task after committing the accepted checkpoint."),
            ],
        });
        const agentOptions = {
            provider: "test",
            model: "mock",
            maxTokens: 512,
            reasoningEffort: "high",
        };
        handle = await world.create({ agentOptions });
        await world.followup(handle, business);
        const entered = deferred();
        let interrupted = false,
            closedHeader,
            closedEvents;
        world.ctx.on(
            "agent/turn-stopping",
            async ({ signal: operationSignal }) => {
                if (interrupted || state(world, handle).active?.phase !== "submitted") return;
                interrupted = true;
                entered.resolve();
                await new Promise((_resolve, reject) => {
                    if (operationSignal.aborted) reject(operationSignal.reason);
                    else
                        operationSignal.addEventListener(
                            "abort",
                            () => reject(operationSignal.reason),
                            { once: true },
                        );
                });
            },
            { prepend: true },
        );
        world.ctx.on("agent/disposed", ({ agent }) => {
            if (agent !== handle.agent) return;
            closedHeader = structuredClone(agent.session.requestHeader());
            closedEvents = agent.session.snapshotEvents();
        });
        const completion = world.engine.compactNow(handle.agent, signal());
        const rejected = assert.rejects(completion, cancelled);
        await entered.promise;
        assert.equal(state(world, handle).active.phase, "submitted");
        const plan = state(world, handle).active.plan;
        assert.equal(handle.agent.session.requestHeader().config.maxTokens, 128);
        const id = handle.agent.id;
        await handle.dispose();
        await rejected;
        const closedState = replay(closedEvents).active;
        assert.equal(closedState.phase, "submitted");
        assert.equal(closedState.restorePending, true);
        assert.equal(closedState.plan.originalMaxTokens, 512);
        assert.equal(closedState.plan.originalReasoningEffort, "high");
        assert.equal(closedHeader.config.maxTokens, 128);
        assert.equal(closedHeader.config.reasoningEffort, "low");
        const boundary = closedEvents.findLast(
            (event) => event.type === "turn/start" || event.type === "turn/end",
        );
        assert.equal(boundary.type, "turn/end");
        assert.ok(
            closedEvents.findLast((event) => event.type === "request/header").seq < boundary.seq,
        );
        assert.equal(controls(closedEvents, "cancelled").length, 0);
        const resumed = await world.resume(id, { agentOptions });
        assert.equal(state(world, resumed).active.phase, "submitted");
        await world.followup(resumed, "Continue the unfinished business task after reopening.");
        assert.equal(state(world, resumed).active.phase, "committed");
        assert.equal(state(world, resumed).active.plan.checkpointId, plan.checkpointId);
        assert.equal(state(world, resumed).active.restorePending, false);
        assert.equal(world.requests.length, 3);
        assert.equal(world.requests.at(-1).maxTokens, 512);
        assert.equal(world.requests.at(-1).reasoningEffort, "high");
        assert.equal(world.summaries.length, 0);
        const checkpoints = events(resumed).filter(
            (event) =>
                event.type === "user/message" && event.data.source.kind === "compact-checkpoint",
        );
        assert.equal(checkpoints.length, 1);
    },
);

test(
    "an earlier committed checkpoint stays cleanable after a later preparation is cancelled",
    { timeout: 15000 },
    async (t) => {
        let handle, firstId;
        const world = await setup(t, {
            tools: { probe: () => "BUSINESS_EVIDENCE_FOR_LATER_CHECKPOINT ".repeat(1200) },
            responses: [
                reply("Initial evidence."),
                call("probe"),
                (_request, fixture) => {
                    firstId = state(fixture, handle).active.plan.checkpointId;
                    return call(
                        SUBMIT_SUMMARY_TOOL,
                        { checkpointId: firstId, summary },
                        "older-submit",
                    );
                },
                (_request, fixture) =>
                    call(
                        SUBMIT_SUMMARY_TOOL,
                        {
                            checkpointId: state(fixture, handle).active.plan.checkpointId,
                            summary: "The later preparation will be cancelled.",
                        },
                        "cancelled-submit",
                    ),
                reply("Continue the user task."),
            ],
        });
        handle = await world.create();
        await world.followup(handle, business);
        assert.ok(await world.engine.compactNow(handle.agent, signal()));
        await handle.agent.whenIdle();
        assert.deepEqual(state(world, handle).committedCheckpoints, [firstId]);
        const older = events(handle).find(
            (event) =>
                event.type === "assistant/message" &&
                event.data.message.content.some(
                    (block) => block.type === "tool-call" && block.id === "older-submit",
                ),
        );
        assert.ok(handle.agent.session.surface.nodes.includes(older.seq));
        world.ctx.on(
            "agent/turn-stopping",
            ({ agent }) => {
                if (state(world, handle).active?.phase === "submitted")
                    agent.cancel({ kind: "user" });
            },
            { prepend: true },
        );
        await assert.rejects(world.engine.compactNow(handle.agent, signal()), cancelled);
        await handle.agent.whenIdle();
        assert.equal(state(world, handle).active.phase, "cancelled");
        assert.deepEqual(replay(events(handle)).committedCheckpoints, [firstId]);
        assert.ok(handle.agent.session.surface.nodes.includes(older.seq));
        const id = handle.agent.id;
        await world.flush(handle);
        await handle.dispose();
        const resumed = await world.resume(id);
        await world.followup(
            resumed,
            "Continue the business task after the later checkpoint was cancelled.",
        );
        const calls = world.requests
            .at(-1)
            .messages.flatMap((message) =>
                message.content
                    .filter((block) => block.type === "tool-call")
                    .map((block) => block.id),
            );
        assert.equal(calls.includes("older-submit"), false);
        assert.equal(calls.includes("cancelled-submit"), true);
        assert.equal(resumed.agent.session.surface.nodes.includes(older.seq), false);
        assert.deepEqual(
            events(resumed).find((event) => event.seq === older.seq),
            older,
        );
    },
);

test(
    "unloading compression during ordinary request preparation preserves the business request",
    { timeout: 15000 },
    async (t) => {
        const entered = deferred(),
            release = deferred();
        const world = await setup(t, {
            isolatedCompression: true,
            responses: [reply("Completed the business task."), reply("Continued normally.")],
        });
        const handle = await world.create({
            agentOptions: { provider: "test", model: "mock", maxTokens: 512 },
        });
        let paused = false;
        world.ctx.on("agent/request", async (_payload, next) => {
            const config = await next();
            if (!paused) {
                paused = true;
                entered.resolve();
                await release.promise;
            }
            return config;
        });
        const completion = world.followup(handle, business);
        await entered.promise;
        await world.disposeCompression();
        release.resolve();
        await completion;
        assert.equal(world.requests.length, 1);
        assert.equal(world.requests[0].maxTokens, 512);
        await world.followup(handle, "Continue normally after unloading compression.");
        assert.equal(world.requests.length, 2);
        assert.equal(world.summaries.length, 0);
    },
);
