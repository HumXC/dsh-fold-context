import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { interruptedTurnClosers } from "@deepseek-ai/dsh-session";
import { assertTestRoot, call, loopFixture } from "./loop-fixture.mjs";
import {
    SESSION_SUMMARY_SOURCE,
    SUBMIT_SUMMARY_TOOL,
    SUMMARY_SUBMISSION_KEY,
    sessionSummaryPlanSchema,
    sessionSummaryProjection,
    submissionArgumentsSchema,
    summaryHash,
} from "../lib/domain/session-summary.js";

const MATCHING = [
    { provider: "test", model: "mock", preferWhenSessionMatches: true, useSessionAgent: true },
];
const SUMMARY =
    "Preserve the original user objective, verified probe evidence, and the next unfinished action.";
const BUSINESS =
    "Retain the original user objective and its exact evidence until a checkpoint commits. ".repeat(
        220,
    );
const reply = (text) => ({ blocks: [{ type: "text", text }] });
const signal = () => new AbortController().signal;
const eventsOf = (handle) => handle.agent.session.snapshotEvents();
const stateOf = (f, handle) =>
    f.ctx.sessionProjections.stateOf(handle.agent.session, "contextSessionSummary");
const fold = (events, initial = sessionSummaryProjection.init()) =>
    events.reduce((state, event) => sessionSummaryProjection.apply(state, event), initial);
const json = (value) => JSON.parse(JSON.stringify(value));
const checkpointEvents = (events) =>
    events.filter(
        (event) => event.type === "user/message" && event.data.source.kind === "compact-checkpoint",
    );
const controls = (events, phase) =>
    events.filter(
        (event) =>
            event.type === "user/message" &&
            event.data.source.kind === SESSION_SUMMARY_SOURCE &&
            event.data.source.control.phase === phase,
    );
const receiptOf = (event) =>
    JSON.parse(event.data.message.content.map((block) => block.text ?? "").join(""));
const submitResults = (events) => {
    const calls = new Set(
        events
            .filter(
                (event) => event.type === "tool/call" && event.data.name === SUBMIT_SUMMARY_TOOL,
            )
            .map((event) => event.data.callId),
    );
    return events.filter(
        (event) => event.type === "tool/result" && calls.has(event.data.message.source.callId),
    );
};

async function isolated(t, options = {}) {
    const root = await mkdtemp(join(tmpdir(), "fold-context-test-"));
    const worlds = new Set();
    t.after(async () => {
        try {
            for (const world of [...worlds].reverse()) await world.close();
        } finally {
            await assertTestRoot(root);
            await rm(root, { recursive: true, force: true });
        }
    });
    const open = async (extra = {}) => {
        const world = await loopFixture(root, {
            strictSession: true,
            summaryModels: MATCHING,
            ...options,
            ...extra,
        });
        worlds.add(world);
        return world;
    };
    const close = async (world) => {
        await world.close();
        worlds.delete(world);
    };
    return { f: await open(), root, open, close };
}

function activePlan(f, handle) {
    const active = stateOf(f, handle)?.active;
    assert.equal(active?.phase, "requested");
    assert.equal(f.engine.state(handle.agent.session).activeStart, null);
    assert.equal(eventsOf(handle).filter((event) => event.type === "compaction/start").length, 0);
    return sessionSummaryPlanSchema.parse(json(active.plan));
}

function assertOneCheckpoint(events, plan) {
    const starts = events.filter((event) => event.type === "compaction/start");
    const summaries = events.filter((event) => event.type === "compaction/summary");
    const ends = events.filter((event) => event.type === "compaction/end");
    const checkpoints = checkpointEvents(events);
    assert.equal(starts.length, 1);
    assert.equal(summaries.length, 1);
    assert.equal(ends.length, 1);
    assert.equal(checkpoints.length, 1);
    assert.deepEqual(summaries[0].data.shadowedSeqs, plan.range.seqs);
    assert.deepEqual(summaries[0].data.shadowedRange, {
        start: plan.range.seqs[0],
        end: plan.range.seqs.at(-1),
    });
    assert.equal(summaries[0].data.compactionId, starts[0].data.compactionId);
    assert.equal(checkpoints[0].data.source.compactionId, starts[0].data.compactionId);
    assert.equal(ends[0].data.compactionId, starts[0].data.compactionId);
    assert.equal(ends[0].data.error, undefined);
    assert.ok(checkpoints[0].sourceEventSeqs.includes(starts[0].seq));
    assert.ok(checkpoints[0].sourceEventSeqs.includes(summaries[0].seq));
    assert.deepEqual(
        checkpoints[0].sourceEventSeqs.filter((seq) => plan.range.seqs.includes(seq)),
        plan.range.seqs,
    );
    return checkpoints[0];
}

test(
    "matching manual summary uses the real tool loop, commits only its frozen prefix, and survives JSONL resume",
    { timeout: 15000 },
    async (t) => {
        let handle;
        let plan;
        let outside;
        let probes = 0;
        const { f, root, open, close } = await isolated(t, {
            tools: {
                probe: (_args, _exec, world) => {
                    probes++;
                    assert.equal(stateOf(world, handle).active.phase, "requested");
                    assert.equal(world.engine.state(handle.agent.session).activeStart, null);
                    return "VERIFIED_PROBE_OUTSIDE_FROZEN_RANGE";
                },
            },
            responses: [
                reply("Verified initial business evidence; preserve the unfinished action."),
                (request, world) => {
                    plan = activePlan(world, handle);
                    assert.equal(request.maxTokens, 128);
                    assert.equal(plan.originalMaxTokens, 512);
                    assert.ok(
                        request.messages.some(
                            (message) =>
                                message.role === "user" &&
                                message.source.kind === SESSION_SUMMARY_SOURCE,
                        ),
                    );
                    assert.ok(JSON.stringify(request.messages).includes(BUSINESS));
                    assert.deepEqual(
                        plan.range.seqs,
                        plan.range.nodes.map((node) => node.seq),
                    );
                    return call("probe", {}, "probe-before-submit");
                },
                (request, world) => {
                    assert.equal(activePlan(world, handle).checkpointId, plan.checkpointId);
                    assert.ok(
                        JSON.stringify(request.messages).includes(
                            "VERIFIED_PROBE_OUTSIDE_FROZEN_RANGE",
                        ),
                    );
                    outside = handle.agent.session.surface.nodes.filter(
                        (seq) => !plan.range.seqs.includes(seq),
                    );
                    return call(
                        SUBMIT_SUMMARY_TOOL,
                        { checkpointId: plan.checkpointId, summary: SUMMARY },
                        "accepted-summary",
                    );
                },
            ],
        });
        handle = await f.create({
            agentOptions: { provider: "test", model: "mock", maxTokens: 512 },
        });
        await f.followup(handle, BUSINESS);
        const original = json(eventsOf(handle));
        const result = await f.engine.compactNow(handle.agent, signal());
        await handle.agent.whenIdle();
        assert.ok(result);
        assert.equal(probes, 1);
        assert.equal(
            f.requests.length,
            3,
            "manual submit concludes its helper turn without a final model request",
        );
        assert.equal(
            f.summaries.length,
            0,
            "a submitted main-loop summary needs no auxiliary model call",
        );
        assert.ok(f.originalCalls.every((entry) => entry.ordinary));
        const events = eventsOf(handle);
        assert.deepEqual(
            events.slice(0, original.length),
            original,
            "original business events remain immutable",
        );
        const checkpoint = assertOneCheckpoint(events, plan);
        assert.deepEqual(result.shadowedSeqs, plan.range.seqs);
        assert.ok(
            checkpoint.data.content.some(
                (block) => block.type === "text" && block.text.includes(SUMMARY),
            ),
        );
        assert.ok(
            plan.range.seqs.every((seq) => !handle.agent.session.surface.nodes.includes(seq)),
        );
        assert.ok(outside.length > 0);
        assert.ok(outside.every((seq) => handle.agent.session.surface.nodes.includes(seq)));
        const submitted = submitResults(events);
        assert.equal(submitted.length, 1);
        assert.equal(receiptOf(submitted[0]).status, "queued-for-validation");
        assert.ok(handle.agent.session.surface.nodes.includes(submitted[0].seq));
        const index = events.indexOf(submitted[0]);
        const beforeReceipt = fold(json(events.slice(0, index)));
        const afterReceipt = fold(json(events.slice(0, index + 1)));
        assert.equal(beforeReceipt.active.phase, "requested");
        assert.equal(afterReceipt.active.phase, "submitted");
        assert.equal(afterReceipt.active.summary, SUMMARY);
        assert.equal(afterReceipt.active.compactionId, null);
        assert.equal(
            events.slice(0, index + 1).some((event) => event.type === "compaction/start"),
            false,
        );
        const continued = fold(json(events.slice(index + 1)), json(afterReceipt));
        assert.equal(continued.active.phase, "committed");
        assert.equal(continued.active.compactionId, result.compactionId);
        assert.deepEqual(continued, stateOf(f, handle));

        const interrupted = [...json(events.slice(0, index + 1))];
        const recovered = fold([...interrupted, ...interruptedTurnClosers(interrupted)]);
        assert.equal(
            recovered.active.phase,
            "submitted",
            "an interrupted accepted submission remains recoverable",
        );
        assert.equal(recovered.active.summary, SUMMARY);
        const badReceipt = json(submitted[0]);
        const badValue = receiptOf(badReceipt);
        badValue[SUMMARY_SUBMISSION_KEY].hash = summaryHash("a different summary");
        badReceipt.data.message.content = [{ type: "text", text: JSON.stringify(badValue) }];
        assert.equal(
            sessionSummaryProjection.apply(beforeReceipt, badReceipt).active.phase,
            "requested",
        );
        const wrongCallReceipt = json(submitted[0]);
        wrongCallReceipt.data.message.source.callId = "probe-before-submit";
        assert.equal(
            sessionSummaryProjection.apply(beforeReceipt, wrongCallReceipt).active.phase,
            "requested",
        );
        const prematureCommitNotice = json(controls(events, "request")[0]);
        prematureCommitNotice.data.source.control = {
            phase: "committed",
            checkpointId: plan.checkpointId,
        };
        assert.equal(
            sessionSummaryProjection.apply(afterReceipt, prematureCommitNotice).active.phase,
            "submitted",
        );
        const wrongCallArguments = json(beforeReceipt);
        wrongCallArguments.calls[submitted[0].data.message.source.callId].summary =
            "a different summary";
        assert.equal(
            sessionSummaryProjection.apply(wrongCallArguments, submitted[0]).active.phase,
            "requested",
        );
        const checkpointIndex = events.indexOf(checkpoint);
        const beforeCheckpoint = fold(json(events.slice(0, checkpointIndex)));
        const foreignCheckpoint = json(checkpoint);
        foreignCheckpoint.data.source.compactionId = "unrelated-official-transaction";
        assert.equal(
            sessionSummaryProjection.apply(beforeCheckpoint, foreignCheckpoint).active.phase,
            "submitted",
        );
        assert.equal(
            submissionArgumentsSchema.safeParse({
                checkpointId: plan.checkpointId,
                summary: SUMMARY,
                range: [1, 2],
            }).success,
            false,
        );

        assert.equal(handle.agent.session.requestHeader().config.maxTokens, 512);
        await f.followup(handle, "Continue the business task after this checkpoint.");
        assert.equal(f.requests.at(-1).maxTokens, 512);
        const nextInput = f.requests.at(-1).messages;
        assert.equal(
            nextInput.some((message) => message.source?.kind === SESSION_SUMMARY_SOURCE),
            false,
        );
        assert.equal(
            nextInput.some((message) =>
                message.content.some(
                    (block) => block.type === "tool-call" && block.name === SUBMIT_SUMMARY_TOOL,
                ),
            ),
            false,
        );
        assert.equal(JSON.stringify(nextInput).split(SUMMARY).length - 1, 1);
        assert.ok(JSON.stringify(nextInput).includes("VERIFIED_PROBE_OUTSIDE_FROZEN_RANGE"));
        assert.ok(nextInput.some((message) => message.source?.kind === "compact-checkpoint"));
        assert.equal(handle.agent.session.surface.nodes.includes(submitted[0].seq), false);
        assert.deepEqual(
            eventsOf(handle).find((event) => event.seq === submitted[0].seq),
            submitted[0],
        );
        const userHeader = handle.agent.session.requestHeader();
        const stopUserChoice = f.ctx.on("agent/pre-step", (_payload, next) => {
            stopUserChoice();
            handle.agent.session.append("request/header", {
                header: { ...userHeader, config: { ...userHeader.config, maxTokens: 128 } },
                reason: "change",
            });
            return next();
        });
        await f.followup(handle, "Use the newly selected output cap for subsequent business.");
        assert.equal(
            f.requests.at(-1).maxTokens,
            128,
            "a retired plan must not restore over a later user choice matching the helper cap",
        );
        assert.equal(f.summaries.length, 0);
        await f.flush(handle);
        const persistedEvents = json(eventsOf(handle));
        const persistedState = json(stateOf(f, handle));
        const persistedSurface = [...handle.agent.session.surface.nodes];
        const sessionId = handle.agent.session.id;
        assert.ok(
            (await readdir(join(root, "sessions"), { recursive: true })).some((name) =>
                name.endsWith(".jsonl"),
            ),
        );
        await close(f);
        const cold = await open({ responses: [] });
        const resumed = await cold.resume(sessionId);
        assert.equal(cold.requests.length, 0);
        assert.equal(cold.summaries.length, 0);
        const resumedEvents = eventsOf(resumed);
        assert.deepEqual(resumedEvents.slice(0, persistedEvents.length), persistedEvents);
        // Cold restore marks the seed boundary; only the projection cursor advances.
        const resumedSuffix = resumedEvents.slice(persistedEvents.length);
        assert.equal(resumedSuffix.length, 1);
        const resumeMarker = resumedSuffix[0];
        assert.equal(resumeMarker.type, "session/end-seed");
        assert.deepEqual(resumeMarker.data, {});
        assert.equal(resumeMarker.seq, persistedEvents.length);
        assert.equal(persistedState.cursor, persistedEvents.length - 1);
        assert.deepEqual(resumed.agent.session.surface.nodes, persistedSurface);
        const resumedState = stateOf(cold, resumed);
        assert.equal(resumedState.cursor, resumeMarker.seq);
        assert.equal(resumedState.cursor, resumed.agent.session.seq - 1);
        assert.deepEqual(resumedState, { ...persistedState, cursor: persistedState.cursor + 1 });
        assert.deepEqual(fold(json(persistedEvents)), persistedState);
        assert.deepEqual(fold(json(resumedEvents)), resumedState);
    },
);

test(
    "submit rejects foreign and retired checkpoint IDs, accepts retries, and refuses conflicting summaries",
    { timeout: 15000 },
    async (t) => {
        let handle;
        let plan;
        const { f } = await isolated(t, {
            responses: [
                reply("Initial business evidence."),
                (_request, world) => {
                    plan = activePlan(world, handle);
                    return {
                        blocks: [
                            ...call(
                                SUBMIT_SUMMARY_TOOL,
                                { checkpointId: "foreign-checkpoint", summary: SUMMARY },
                                "foreign",
                            ).blocks,
                            ...call(
                                SUBMIT_SUMMARY_TOOL,
                                { checkpointId: plan.checkpointId, summary: SUMMARY },
                                "first",
                            ).blocks,
                            ...call(
                                SUBMIT_SUMMARY_TOOL,
                                { checkpointId: plan.checkpointId, summary: SUMMARY },
                                "retry",
                            ).blocks,
                            ...call(
                                SUBMIT_SUMMARY_TOOL,
                                {
                                    checkpointId: plan.checkpointId,
                                    summary: "Conflicting replacement.",
                                },
                                "conflict",
                            ).blocks,
                        ],
                    };
                },
            ],
        });
        handle = await f.create();
        await f.followup(handle, BUSINESS);
        assert.ok(await f.engine.compactNow(handle.agent, signal()));
        await handle.agent.whenIdle();
        const values = new Map(
            submitResults(eventsOf(handle)).map((event) => [
                event.data.message.source.callId,
                receiptOf(event),
            ]),
        );
        assert.equal(values.get("foreign").accepted, false);
        assert.equal(values.get("first").accepted, true);
        assert.equal(values.get("retry").accepted, true);
        assert.deepEqual(values.get("retry"), values.get("first"));
        assert.equal(values.get("conflict").accepted, false);
        assert.match(values.get("conflict").reason, /different summary/);
        assertOneCheckpoint(eventsOf(handle), plan);
        assert.equal(stateOf(f, handle).active.summary, SUMMARY);
        assert.equal(stateOf(f, handle).active.phase, "committed");
        const retired = await f.ctx.tools.execute({
            name: SUBMIT_SUMMARY_TOOL,
            arguments: { checkpointId: plan.checkpointId, summary: SUMMARY },
            callId: "retired-checkpoint",
            agent: handle.agent,
            signal: signal(),
        });
        assert.equal(retired.isError, false);
        assert.equal(
            JSON.parse(retired.content.map((block) => block.text ?? "").join("")).accepted,
            false,
        );
        assert.equal(checkpointEvents(eventsOf(handle)).length, 1);
        assert.equal(f.summaries.length, 0);
    },
);

test(
    "cancelling a queued manual checkpoint rejects its waiter without committing or hanging the driver",
    { timeout: 15000 },
    async (t) => {
        let handle;
        let plan;
        const controller = new AbortController();
        const { f } = await isolated(t, {
            responses: [
                reply("Initial business evidence."),
                (_request, world) => {
                    plan = activePlan(world, handle);
                    controller.abort(new Error("isolated manual checkpoint cancelled"));
                    return call(
                        SUBMIT_SUMMARY_TOOL,
                        { checkpointId: plan.checkpointId, summary: SUMMARY },
                        "cancelled-submission",
                    );
                },
                reply("Continue the business task after cancellation."),
            ],
        });
        handle = await f.create({
            agentOptions: { provider: "test", model: "mock", maxTokens: 512 },
        });
        await f.followup(handle, BUSINESS);
        await assert.rejects(
            f.engine.compactNow(handle.agent, controller.signal),
            (error) => error.code === "cancelled",
        );
        await handle.agent.whenIdle();
        const events = eventsOf(handle);
        assert.equal(events.filter((event) => event.type === "compaction/start").length, 0);
        assert.equal(checkpointEvents(events).length, 0);
        assert.equal(f.summaries.length, 0);
        assert.ok(plan.range.seqs.every((seq) => handle.agent.session.surface.nodes.includes(seq)));
        assert.equal(
            submitResults(events).every((event) => receiptOf(event).accepted === false),
            true,
        );
        assert.notEqual(stateOf(f, handle).active.phase, "committed");
        assert.equal(handle.agent.session.requestHeader().config.maxTokens, 512);
    },
);

test(
    "tool errors and missing submission get a bounded reminder and one independent fallback",
    { timeout: 15000 },
    async (t) => {
        let handle;
        let plan;
        const { f } = await isolated(t, {
            tools: {
                probe: () => {
                    throw new Error("isolated probe failure");
                },
            },
            responses: [
                reply("Initial business evidence."),
                (_request, world) => {
                    plan = activePlan(world, handle);
                    return call("probe", {}, "failed-probe");
                },
                () => reply("The probe failed; no summary was submitted."),
                () => reply("Still no submitted checkpoint."),
            ],
        });
        handle = await f.create({
            agentOptions: { provider: "test", model: "mock", maxTokens: 512 },
        });
        await f.followup(handle, BUSINESS);
        assert.ok(await f.engine.compactNow(handle.agent, signal()));
        await handle.agent.whenIdle();
        const events = eventsOf(handle);
        assert.equal(f.requests.length, 4);
        assert.equal(controls(events, "reminder").length, 1);
        assert.equal(f.summaries.length, 1);
        assert.equal(submitResults(events).length, 0);
        const failedProbe = events.find(
            (event) =>
                event.type === "tool/result" && event.data.message.source.callId === "failed-probe",
        );
        assert.ok(failedProbe);
        assert.equal(failedProbe.data.message.isError, true);
        assertOneCheckpoint(events, plan);
        assert.equal(stateOf(f, handle).active.phase, "committed");
        assert.equal(
            stateOf(f, handle).active.summary,
            null,
            "fallback does not fabricate a submitted summary",
        );
        assert.equal(handle.agent.session.requestHeader().config.maxTokens, 512);
    },
);

test(
    "an intervening official replacement invalidates a pending range instead of committing a stale submission",
    { timeout: 15000 },
    async (t) => {
        let handle;
        let plan;
        let intervening;
        const { f } = await isolated(t, {
            tools: {
                probe: async (_args, exec, world) => {
                    const victim = plan.range.messages.find((item) => {
                        const event = handle.agent.session.eventAt(item.seq);
                        return event.type === "user/message" && event.data.source.kind === "user";
                    });
                    assert.ok(victim);
                    intervening = await world.engine.compactRegion(
                        victim.seq,
                        victim.seq,
                        handle.agent,
                        exec.signal,
                    );
                    return "The original checkpoint range was independently replaced.";
                },
            },
            responses: [
                reply("Initial business evidence."),
                (_request, world) => {
                    plan = activePlan(world, handle);
                    return call("probe", {}, "replace-selected-evidence");
                },
                reply("Continue after the obsolete checkpoint was cancelled."),
            ],
        });
        handle = await f.create();
        await f.followup(handle, BUSINESS);
        await assert.rejects(
            f.engine.compactNow(handle.agent, signal()),
            (error) => error.code === "changed",
        );
        await handle.agent.whenIdle();
        assert.ok(intervening);
        assert.equal(
            checkpointEvents(eventsOf(handle)).length,
            1,
            "only the intervening transaction commits",
        );
        assert.notDeepEqual(intervening.shadowedSeqs, plan.range.seqs);
        assert.equal(submitResults(eventsOf(handle)).length, 0);
        assert.notEqual(stateOf(f, handle).active.phase, "committed");
    },
);

test(
    "a nonmatching first candidate keeps the existing independent summary path",
    { timeout: 15000 },
    async (t) => {
        const { f } = await isolated(t, {
            summaryModels: [
                { provider: "test", model: "other-model", preferWhenSessionMatches: true },
            ],
        });
        const handle = await f.create();
        await f.followup(handle, BUSINESS);
        const before = f.requests.length;
        assert.ok(await f.engine.compactNow(handle.agent, signal()));
        assert.equal(f.requests.length, before);
        assert.equal(f.summaries.length, 1);
        assert.equal(f.summaries[0].model, "other-model");
        assert.equal(controls(eventsOf(handle), "request").length, 0);
        assert.equal(stateOf(f, handle).active, null);
        assert.equal(f.originalCalls.filter((entry) => !entry.ordinary).length, 1);
    },
);

test(
    "a full-context capacity failure falls back without admitting a main-loop helper",
    { timeout: 15000 },
    async (t) => {
        const { f } = await isolated(t, { contextWindow: 2048 });
        const handle = await f.create();
        await f.followup(handle, BUSINESS);
        const before = f.requests.length;
        assert.ok(await f.engine.compactNow(handle.agent, signal()));
        assert.equal(f.requests.length, before);
        assert.equal(f.summaries.length, 1);
        assert.equal(controls(eventsOf(handle), "request").length, 0);
        assert.equal(stateOf(f, handle).active, null);
        assert.equal(checkpointEvents(eventsOf(handle)).length, 1);
    },
);

test(
    "an explicit overflow trigger uses auxiliary recovery rather than another full-context helper",
    { timeout: 15000 },
    async (t) => {
        let handle;
        let result;
        const { f } = await isolated(t, {
            responses: [
                reply("Initial business evidence."),
                async (request, world) => {
                    result = await world.engine.compactIfNeeded(
                        handle.agent,
                        "context-overflow",
                        request.signal,
                    );
                    return reply("Continue the task after overflow recovery.");
                },
            ],
        });
        handle = await f.create();
        await f.followup(handle, BUSINESS);
        await f.followup(handle, "Continue the active task.");
        assert.ok(result);
        assert.ok(result.shadowedSeqs.length > 0);
        assert.equal(f.requests.length, 2);
        assert.equal(f.summaries.length, 1);
        assert.equal(controls(eventsOf(handle), "request").length, 0);
        assert.equal(stateOf(f, handle).active, null);
        assert.equal(checkpointEvents(eventsOf(handle)).length, 1);
    },
);

for (const variant of [
    "pure",
    "opaque",
    "reasoning",
    "mixed-text",
    "mixed-tool",
    "interleaved",
    "result-text",
    "result-attachment",
    "result-field",
    "result-nested",
    "result-duplicate",
]) {
    test(
        `settled summary cleanup preserves records and tool pairs for ${variant}`,
        { timeout: 15000 },
        async (t) => {
            let handle;
            const { f } = await isolated(t, {
                attachments: variant === "result-attachment",
                tools: { business_probe: () => "BUSINESS_TOOL_OUTSIDE_CHECKPOINT" },
                responses: [
                    reply("Original investigated evidence."),
                    (_request, world) => {
                        const plan = activePlan(world, handle);
                        const submission = call(
                            SUBMIT_SUMMARY_TOOL,
                            { checkpointId: plan.checkpointId, summary: SUMMARY },
                            "cleanup-submit",
                        );
                        return {
                            blocks: [
                                ...(variant === "reasoning"
                                    ? [
                                          {
                                              type: "reasoning",
                                              text: "Prepare only the checkpoint submission.",
                                          },
                                      ]
                                    : []),
                                ...(variant === "mixed-text"
                                    ? [{ type: "text", text: "BUSINESS_TEXT_OUTSIDE_CHECKPOINT" }]
                                    : []),
                                ...submission.blocks,
                                ...(variant === "mixed-tool"
                                    ? call("business_probe", {}, "business-call").blocks
                                    : []),
                            ],
                            ...(variant === "opaque"
                                ? { replayState: { response: { signed: "opaque-response-bytes" } } }
                                : {}),
                        };
                    },
                    reply("Continue the business action."),
                ],
            });
            if (variant.startsWith("result-")) {
                const attachment =
                    variant === "result-attachment"
                        ? await f.attachments.saveFile({
                              data: Buffer.from("BUSINESS_RESULT_NOTE\n"),
                              name: "policy-note.txt",
                          })
                        : null;
                f.ctx.on("tools/post-execute", async (exec, result, next) => {
                    const decision = await next();
                    if (exec.name !== SUBMIT_SUMMARY_TOOL) return decision;
                    const text = result.content[0].text;
                    let content;
                    if (variant === "result-text") {
                        content = [
                            { type: "text", text: '{"businessNote":"BUSINESS_RESULT_NOTE",' },
                            { type: "text", text: text.slice(1) },
                        ];
                    } else if (variant === "result-attachment") {
                        content = [...result.content, { type: "file", attachment }];
                    } else if (variant === "result-duplicate") {
                        content = [
                            {
                                type: "text",
                                text: '{"accepted":"BUSINESS_RESULT_NOTE",' + text.slice(1),
                            },
                        ];
                    } else {
                        const value = JSON.parse(text);
                        if (variant === "result-nested")
                            value.dshSessionSummary.businessNote = "BUSINESS_RESULT_NOTE";
                        else value.businessNote = "BUSINESS_RESULT_NOTE";
                        content = [{ type: "text", text: JSON.stringify(value) }];
                    }
                    return { kind: "accept", content };
                });
            }
            if (variant === "interleaved") {
                const { createUserMessage } = await import("@deepseek-ai/dsh-llm");
                f.ctx.on("tools/pre-execute", async (exec, next) => {
                    if (exec.name === SUBMIT_SUMMARY_TOOL)
                        exec.agent.session.append(
                            "user/message",
                            createUserMessage({
                                content: [
                                    { type: "text", text: "INTERLEAVED_USER_BUSINESS_INPUT" },
                                ],
                                source: { kind: "user" },
                            }),
                            { surfaceOp: "append" },
                        );
                    return next();
                });
            }
            handle = await f.create();
            await f.followup(handle, BUSINESS);
            assert.ok(await f.engine.compactNow(handle.agent, signal()));
            await handle.agent.whenIdle();
            assert.equal(stateOf(f, handle).active.phase, "committed");
            const original = eventsOf(handle).filter(
                (event) =>
                    (event.type === "assistant/message" &&
                        event.data.message.content.some(
                            (block) =>
                                block.type === "tool-call" && block.name === SUBMIT_SUMMARY_TOOL,
                        )) ||
                    (event.type === "tool/result" &&
                        event.data.message.source.callId === "cleanup-submit"),
            );
            assert.equal(original.length, 2);
            const bytes = json(original);
            if (variant === "opaque")
                assert.deepEqual(original[0].data.message.source.replayState, {
                    response: { signed: "opaque-response-bytes" },
                });
            await f.followup(handle, "Continue the pending business task.");
            const input = f.requests.at(-1).messages;
            const pruned = ["pure", "opaque", "reasoning"].includes(variant);
            for (const event of original) {
                assert.equal(handle.agent.session.surface.nodes.includes(event.seq), !pruned);
                assert.deepEqual(
                    eventsOf(handle).find((item) => item.seq === event.seq),
                    bytes.find((item) => item.seq === event.seq),
                );
            }
            assert.equal(
                input.some((message) =>
                    message.content.some(
                        (block) => block.type === "tool-call" && block.name === SUBMIT_SUMMARY_TOOL,
                    ),
                ),
                !pruned,
            );
            assert.equal(
                input.some(
                    (message) =>
                        message.role === "tool" && message.source.callId === "cleanup-submit",
                ),
                !pruned,
            );
            assert.equal(
                input.some((message) => message.source.kind === SESSION_SUMMARY_SOURCE),
                false,
            );
            if (variant === "mixed-text")
                assert.ok(JSON.stringify(input).includes("BUSINESS_TEXT_OUTSIDE_CHECKPOINT"));
            if (variant === "mixed-tool")
                assert.ok(JSON.stringify(input).includes("BUSINESS_TOOL_OUTSIDE_CHECKPOINT"));
            if (variant === "interleaved")
                assert.ok(JSON.stringify(input).includes("INTERLEAVED_USER_BUSINESS_INPUT"));
            if (variant.startsWith("result-") && variant !== "result-attachment")
                assert.ok(JSON.stringify(input).includes("BUSINESS_RESULT_NOTE"));
            const calls = input.flatMap((message) =>
                message.content
                    .filter((block) => block.type === "tool-call")
                    .map((block) => block.id),
            );
            const results = input
                .filter((message) => message.role === "tool")
                .map((message) => message.source.callId);
            assert.deepEqual(calls.sort(), results.sort());
            assert.equal(checkpointEvents(eventsOf(handle)).length, 1);
            assert.deepEqual(fold(json(eventsOf(handle))), json(stateOf(f, handle)));
            await f.flush(handle);
            const fork = f.ctx.sessions.fork(handle.agent.session);
            await f.ctx.sessions.flush(fork);
            await f.persistence.flush();
            assert.deepEqual(fork.deriveMessages(), handle.agent.session.deriveMessages());
            assert.deepEqual(
                f.ctx.sessionProjections.stateOf(fork, "contextSessionSummaryControls"),
                f.ctx.sessionProjections.stateOf(
                    handle.agent.session,
                    "contextSessionSummaryControls",
                ),
            );
        },
    );
}

for (const feedback of ["pure", "text", "field", "nested", "duplicate", "scope"]) {
    test(
        `applied compact request cleanup preserves ${feedback} feedback on the independent path`,
        { timeout: 15000 },
        async (t) => {
            const { f } = await isolated(t, {
                summaryModels: [{ ...MATCHING[0], useSessionAgent: false }],
                compaction: { targetTokens: 2048, cacheReadRatio: 1 },
                scheduling: {
                    summaryInputRatio: 0.01,
                    summaryOutputRatio: 0.01,
                },
                tools: { probe: () => "Original investigated evidence. ".repeat(900) },
                responses: [
                    call("probe"),
                    reply("Original evidence."),
                    call(
                        "context_compact",
                        { reason: "Preserve the investigated facts." },
                        "cleanup-compact",
                    ),
                    reply("Ready for the next user action."),
                ],
            });
            if (feedback !== "pure") {
                f.ctx.on("tools/post-execute", async (exec, result, next) => {
                    const decision = await next();
                    if (exec.name !== "context_compact") return decision;
                    const text = result.content[0].text;
                    let content;
                    if (feedback === "text") {
                        content = [
                            ...result.content,
                            { type: "text", text: "BUSINESS_COMPACT_NOTE" },
                        ];
                    } else if (feedback === "duplicate") {
                        content = [
                            {
                                type: "text",
                                text: '{"scope":"BUSINESS_COMPACT_NOTE",' + text.slice(1),
                            },
                        ];
                    } else {
                        const value = JSON.parse(text);
                        if (feedback === "nested")
                            value.dshContextCompression.businessNote = "BUSINESS_COMPACT_NOTE";
                        else if (feedback === "scope") value.scope = "BUSINESS_COMPACT_NOTE";
                        else value.businessNote = "BUSINESS_COMPACT_NOTE";
                        content = [{ type: "text", text: JSON.stringify(value) }];
                    }
                    return { kind: "accept", content };
                });
            }
            const handle = await f.create();
            const session = handle.agent.session;
            let queued = false;
            let original;
            f.ctx.on("session/event", (_session, event) => {
                if (
                    event.type === "tool/result" &&
                    event.data.message.source.callId === "cleanup-compact"
                ) {
                    assert.equal(f.engine.state(session).summaryRequests[0].status, "queued");
                    queued = true;
                }
            });
            // The inner request hook observes the official commit before cleanup unwinds.
            f.ctx.on("agent/request", async (_payload, next) => {
                const config = await next();
                const request = f.engine.state(session).summaryRequests[0];
                if (!original && request?.status === "applied") {
                    const result = session.eventAt(request.seq);
                    const assistant = eventsOf(handle).find(
                        (event) =>
                            event.type === "assistant/message" &&
                            event.data.message.content.some(
                                (block) =>
                                    block.type === "tool-call" && block.id === "cleanup-compact",
                            ),
                    );
                    assert.ok(session.surface.nodes.includes(assistant.seq));
                    assert.ok(session.surface.nodes.includes(result.seq));
                    original = json([assistant, result]);
                }
                return config;
            });
            await f.followup(handle, BUSINESS);
            await f.followup(
                handle,
                "Remember the investigated facts and keep this recent user request.",
            );
            assert.equal(queued, true);
            assert.ok(original, "the recent group must survive the official prefix replacement");
            assert.equal(f.engine.state(session).summaryRequests[0].status, "applied");
            for (const event of original) {
                assert.equal(session.surface.nodes.includes(event.seq), feedback !== "pure");
                assert.deepEqual(session.eventAt(event.seq), event);
            }
            const input = f.requests.at(-1).messages;
            assert.equal(
                input.some((message) =>
                    message.content.some(
                        (block) => block.type === "tool-call" && block.name === "context_compact",
                    ),
                ),
                feedback !== "pure",
            );
            if (feedback !== "pure")
                assert.ok(JSON.stringify(input).includes("BUSINESS_COMPACT_NOTE"));
            assert.equal(f.summaries.length, 1);
            assert.equal(checkpointEvents(eventsOf(handle)).length, 1);
        },
    );
}
