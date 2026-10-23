import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LlmError } from "@deepseek-ai/dsh-llm";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { assertTestRoot, call, loopFixture } from "./loop-fixture.mjs";
import { SESSION_SUMMARY_SOURCE, SUBMIT_SUMMARY_TOOL } from "../lib/domain/session-summary.js";
const matching = [
    { provider: "test", model: "mock", preferWhenSessionMatches: true, useSessionAgent: true },
];
const reply = (text) => ({ blocks: [{ type: "text", text }] });
const business = "Preserve the investigated source and the unfinished user action. ".repeat(400);
const signal = () => new AbortController().signal;
const state = (world, handle) =>
    world.ctx.sessionProjections.stateOf(handle.agent.session, "contextSessionSummary");
async function setup(t, options) {
    const root = await mkdtemp(join(tmpdir(), "fold-context-test-"));
    const world = await loopFixture(root, {
        strictSession: true,
        summaryModels: matching,
        ...options,
    });
    t.after(async () => {
        await world.close();
        await assertTestRoot(root);
        await rm(root, { recursive: true, force: true });
    });
    return world;
}
test(
    "scheduled matching summary admits one helper and resumes business without aging the release backlog",
    { timeout: 15000 },
    async (t) => {
        let handle, plan, beforeBusiness;
        const f = await setup(t, {
            compaction: { targetTokens: 2048, cacheReadRatio: 1 },
            scheduling: {
                summaryInputRatio: 0.01,
                summaryOutputRatio: 0.01,
            },
            tools: {
                probe: () => "Original investigated evidence. ".repeat(900),
                helper_probe: () => "Verified current detail.",
            },
            responses: [
                call("probe"),
                reply("The original evidence is verified."),
                call("context_compact", { reason: "Checkpoint the completed investigation." }),
                (request, world) => {
                    plan = state(world, handle).active.plan;
                    beforeBusiness = world.engine.state(handle.agent.session).businessSteps;
                    assert.equal(plan.manual, false);
                    assert.equal(world.engine.state(handle.agent.session).activeStart, null);
                    assert.equal(request.maxTokens, 128);
                    assert.ok(
                        request.messages.some(
                            (message) => message.source?.kind === SESSION_SUMMARY_SOURCE,
                        ),
                    );
                    return call("helper_probe");
                },
                () =>
                    call(SUBMIT_SUMMARY_TOOL, {
                        checkpointId: plan.checkpointId,
                        summary: "Keep verified evidence and continue the unfinished user task.",
                    }),
                (request, world) => {
                    assert.equal(state(world, handle).active.phase, "committed");
                    assert.equal(request.maxTokens, 512);
                    const resume = request.messages.filter(
                        (message) => message.source?.kind === SESSION_SUMMARY_SOURCE,
                    );
                    assert.deepEqual(
                        resume.map((message) => message.content),
                        [[{ type: "text", text: "Continue the user's pending task." }]],
                    );
                    assert.ok(
                        resume.every((message) => message.source.control.phase === "committed"),
                    );
                    assert.equal(
                        request.messages.some((message) =>
                            message.content.some(
                                (block) =>
                                    block.type === "tool-call" &&
                                    block.name === SUBMIT_SUMMARY_TOOL,
                            ),
                        ),
                        false,
                    );
                    assert.equal(
                        JSON.stringify(request.messages).split(
                            "Keep verified evidence and continue the unfinished user task.",
                        ).length - 1,
                        1,
                    );
                    return reply("Continued the pending business action.");
                },
            ],
        });
        handle = await f.create({
            agentOptions: { provider: "test", model: "mock", maxTokens: 512 },
        });
        await f.followup(handle, business);
        await f.followup(
            handle,
            "Checkpoint the completed investigation, then continue the pending business action.",
        );
        assert.ok(plan);
        assert.equal(f.requests.length, 6);
        assert.equal(f.summaries.length, 0);
        assert.ok(f.originalCalls.every((entry) => entry.ordinary));
        assert.equal(f.engine.state(handle.agent.session).businessSteps, beforeBusiness + 1);
        const summaries = handle.agent.session
            .snapshotEvents()
            .filter((event) => event.type === "compaction/summary");
        assert.equal(summaries.length, 1);
        assert.deepEqual(summaries[0].data.shadowedSeqs, plan.range.seqs);
    },
);
test(
    "an unrecovered helper model failure falls back once and restores the next ordinary request",
    { timeout: 15000 },
    async (t) => {
        const f = await setup(t, {
            responses: [
                reply("Original evidence."),
                () => {
                    throw new LlmError("Local helper failure", "ADAPTER_ERROR");
                },
                reply("Checkpoint completed; continue normally."),
            ],
        });
        const handle = await f.create({
            agentOptions: { provider: "test", model: "mock", maxTokens: 512 },
        });
        await f.followup(handle, business);
        const result = await f.engine.compactNow(handle.agent, signal());
        await handle.agent.whenIdle();
        assert.ok(result);
        assert.equal(f.summaries.length, 1);
        assert.equal(f.requests.length, 3);
        assert.equal(f.requests.at(-1).maxTokens, 512);
        assert.equal(state(f, handle).active.phase, "committed");
        assert.equal(
            handle.agent.session
                .snapshotEvents()
                .filter((event) => event.type === "compaction/start").length,
            1,
        );
    },
);
test(
    "registered request recovery gets its retry before independent helper fallback",
    { timeout: 15000 },
    async (t) => {
        let handle,
            retried = 0;
        const f = await setup(t, {
            responses: [
                reply("Original evidence."),
                () => {
                    throw new LlmError("Local transient failure", "ADAPTER_ERROR");
                },
                () =>
                    call(SUBMIT_SUMMARY_TOOL, {
                        checkpointId: state(f, handle).active.plan.checkpointId,
                        summary: "Preserve verified evidence after the ordinary retry.",
                    }),
            ],
        });
        f.ctx.on("agent/request-error", async (_payload, next) => {
            if (retried === 0) {
                retried++;
                return { kind: "retry" };
            }
            return next();
        });
        handle = await f.create({
            agentOptions: { provider: "test", model: "mock", maxTokens: 512 },
        });
        await f.followup(handle, business);
        assert.ok(await f.engine.compactNow(handle.agent, signal()));
        await handle.agent.whenIdle();
        assert.equal(retried, 1);
        assert.equal(f.summaries.length, 0);
        assert.equal(f.requests.length, 3);
        assert.equal(handle.agent.session.requestHeader().config.maxTokens, 512);
    },
);

test(
    "a tool catalog change during helper steps preserves restoration ownership",
    { timeout: 15000 },
    async (t) => {
        let handle, plan;
        const f = await setup(t, {
            tools: {
                helper_probe: (_args, _exec, world) => {
                    world.ctx.tools.register(
                        defineTool({
                            name: "late_helper_tool",
                            description: "A tool discovered during preparation.",
                            parameters: {},
                            output: {
                                schema: { type: "json" },
                                render: () => [{ type: "text", text: "available" }],
                            },
                            execute: async () => "available",
                        }),
                    );
                    return "The tool catalog now includes another tool.";
                },
            },
            responses: [
                reply("Initial evidence."),
                (_request, world) => {
                    plan = state(world, handle).active.plan;
                    return call("helper_probe");
                },
                (request) => {
                    assert.ok(request.tools.some((tool) => tool.name === "late_helper_tool"));
                    return call(SUBMIT_SUMMARY_TOOL, {
                        checkpointId: plan.checkpointId,
                        summary: "Preserve the verified evidence and unfinished work.",
                    });
                },
                reply("Continued business."),
            ],
        });
        handle = await f.create({
            agentOptions: { provider: "test", model: "mock", maxTokens: 512 },
        });
        await f.followup(handle, business);
        assert.ok(await f.engine.compactNow(handle.agent, signal()));
        await handle.agent.whenIdle();
        assert.equal(f.summaries.length, 0);
        assert.equal(handle.agent.session.requestHeader().config.maxTokens, 512);
        await f.followup(handle, "Continue with the original request limits.");
        assert.equal(f.requests.at(-1).maxTokens, 512);
    },
);

for (const [name, models, summaryModel] of [
    ["empty model list", [], "mock"],
    [
        "legacy model entry",
        [{ provider: "test", model: "mock", preferWhenSessionMatches: true }],
        "mock",
    ],
    ["explicitly disabled entry", [{ ...matching[0], useSessionAgent: false }], "mock"],
    ["enabled but different model", [{ ...matching[0], model: "other-model" }], "other-model"],
]) {
    test(
        `${name} uses an independent summary without a helper turn`,
        { timeout: 15000 },
        async (t) => {
            const f = await setup(t, {
                summaryModels: models,
                responses: [
                    reply("Verified original evidence."),
                    reply("Continue after the checkpoint."),
                ],
            });
            const handle = await f.create({
                agentOptions: { provider: "test", model: "mock", maxTokens: 512 },
            });
            await f.followup(handle, business);
            await f.followup(
                handle,
                "Preserve the preceding investigation and continue the next action.",
            );
            assert.equal(f.engine.sessionSummaryTarget(handle.agent), null);
            assert.ok(await f.engine.compactNow(handle.agent, signal()));
            await handle.agent.whenIdle();
            assert.equal(f.requests.length, 2);
            assert.equal(f.summaries.length, 1);
            assert.equal(f.summaries[0].model, summaryModel);
            assert.equal(f.summaries[0].sessionId, undefined);
            assert.equal(state(f, handle).active, null);
            assert.equal(handle.agent.session.requestHeader().config.maxTokens, 512);
        },
    );
}

for (const effort of [undefined, "low"]) {
    test(
        `helper effort ${effort ?? "automatic"} restores adapter defaults for later requests`,
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
            const f = await setup(t, {
                modelReasoning,
                summaryModels: [
                    {
                        ...matching[0],
                        ...(effort === undefined ? {} : { reasoningEffort: effort }),
                    },
                ],
                responses: [
                    reply("Verified original evidence."),
                    (request) => {
                        assert.equal(request.maxTokens, 128);
                        assert.equal(request.reasoningEffort, effort ?? "high");
                        return call(SUBMIT_SUMMARY_TOOL, {
                            checkpointId: state(f, handle).active.plan.checkpointId,
                            summary: "Preserve verified evidence and the unfinished user task.",
                        });
                    },
                    (request) => {
                        assert.equal(
                            request.reasoningEffort,
                            "low",
                            "a later adapter default remains live after maintenance",
                        );
                        return reply("Continued with the updated provider default.");
                    },
                ],
            });
            handle = await f.create({ agentOptions: { provider: "test", model: "mock" } });
            await f.followup(handle, business);
            const original = handle.agent.session.requestHeader();
            assert.equal(original.config.reasoningEffort, "high");
            assert.deepEqual(original.adapterDefaults, { reasoningEffort: true, maxTokens: true });
            assert.ok(await f.engine.compactNow(handle.agent, signal()));
            await handle.agent.whenIdle();
            assert.equal(handle.agent.session.requestHeader().config.reasoningEffort, "high");
            assert.deepEqual(
                handle.agent.session.requestHeader().adapterDefaults,
                original.adapterDefaults,
            );
            modelReasoning.defaultEffort = "low";
            await f.followup(handle, "Continue the unfinished user task.");
            assert.equal(f.summaries.length, 0);
            assert.equal(f.requests.length, 3);
            assert.equal(state(f, handle).active.phase, "committed");
        },
    );
}
