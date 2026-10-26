import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installModelSelection } from "@deepseek-ai/dsh-agent";
import { LlmError } from "@deepseek-ai/dsh-llm";
import { assertTestRoot, call, loopFixture } from "./loop-fixture.mjs";
import { SUBMIT_SUMMARY_TOOL } from "../lib/domain/session-summary.js";

const reply = (text) => ({ blocks: [{ type: "text", text }] });
const business = "Preserve the investigated source and the unfinished user action. ".repeat(400);

for (const [caseName, initialEffort, userChoice, failHelper] of [
    ["explicit high", "high", undefined, false],
    ["adapter-default high", undefined, undefined, false],
    ["an explicit medium choice made during the helper", "high", "medium", false],
    ["high after a multi-step helper failure", "high", undefined, true],
    ["adapter-default high after helper failure", undefined, undefined, true],
    ["an explicit low choice during a failing helper", "high", "low", true],
]) {
    test(
        `automatic summary preserves ${caseName} through Web model-selection snapshots`,
        { timeout: 15000 },
        async (t) => {
            const root = await mkdtemp(join(tmpdir(), "fold-context-test-"));
            let handle, pendingChoice;
            const expectedEffort = userChoice ?? "high";
            const chooseDuringHelper = () => {
                if (userChoice === undefined) return;
                pendingChoice = { provider: "test", model: "mock", reasoningEffort: userChoice };
                handle.agent.session.append("model/selection", pendingChoice);
            };
            const world = await loopFixture(root, {
                strictSession: true,
                summaryModels: [
                    {
                        provider: "test",
                        model: "mock",
                        reasoningEffort: "low",
                        preferWhenSessionMatches: true,
                        useSessionAgent: true,
                    },
                ],
                modelReasoning: {
                    defaultEffort: "high",
                    efforts: [
                        { id: "low", name: "Low" },
                        { id: "medium", name: "Medium" },
                        { id: "high", name: "High" },
                    ],
                },
                compaction: { targetTokens: 2048, cacheReadRatio: 1 },
                scheduling: { summaryInputRatio: 0.01, summaryOutputRatio: 0.01 },
                tools: { probe: () => "Original investigated evidence. ".repeat(900) },
                responses: [
                    call("probe"),
                    reply("The original evidence is verified."),
                    call("context_compact", { reason: "Checkpoint the completed investigation." }),
                    ...(failHelper
                        ? [
                              () => {
                                  chooseDuringHelper();
                                  return call("probe");
                              },
                              () => {
                                  throw new LlmError(
                                      "Helper failed after a tool step",
                                      "ADAPTER_ERROR",
                                  );
                              },
                          ]
                        : [
                              () => {
                                  const active = world.ctx.sessionProjections.stateOf(
                                      handle.agent.session,
                                      "contextSessionSummary",
                                  ).active;
                                  assert.equal(active.plan.manual, false);
                                  chooseDuringHelper();
                                  return call(SUBMIT_SUMMARY_TOOL, {
                                      checkpointId: active.plan.checkpointId,
                                      summary:
                                          "Keep verified evidence and continue the unfinished user task.",
                                  });
                              },
                          ]),
                    reply("Continued the pending business action."),
                    reply("Continued another ordinary turn."),
                ],
            });
            t.after(async () => {
                await world.close();
                await assertTestRoot(root);
                await rm(root, { recursive: true, force: true });
            });
            handle = await world.create({
                agentOptions: {
                    provider: "test",
                    model: "mock",
                    maxTokens: 512,
                    ...(initialEffort === undefined ? {} : { reasoningEffort: initialEffort }),
                },
            });
            // Match Web's header-backed selection, including its distinction between
            // an explicit effort and a value supplied by the adapter's defaults.
            const selection = {
                get current() {
                    if (pendingChoice !== undefined) return pendingChoice;
                    const header = handle.agent.session.requestHeader();
                    const config = header?.config;
                    return {
                        provider: config?.provider ?? "test",
                        model: config?.model ?? "mock",
                        ...(config === undefined
                            ? initialEffort === undefined
                                ? {}
                                : { reasoningEffort: initialEffort }
                            : config.reasoningEffort === undefined ||
                                header.adapterDefaults?.reasoningEffort === true
                              ? {}
                              : { reasoningEffort: config.reasoningEffort }),
                    };
                },
                assembled: undefined,
            };
            const disposeSelection = installModelSelection(handle.agent.ctx, selection);
            t.after(disposeSelection);

            await world.followup(handle, business);
            const original = handle.agent.session.requestHeader();
            assert.equal(original.config.reasoningEffort, "high");
            await world.followup(
                handle,
                "Checkpoint the completed investigation, then continue the pending business action.",
            );
            assert.equal(world.summaries.length, failHelper ? 1 : 0);
            assert.equal(world.requests.length, failHelper ? 6 : 5);
            assert.equal(
                world.requests[3].reasoningEffort,
                "low",
                "helper uses its configured effort",
            );
            assert.equal(
                world.requests.at(-1).reasoningEffort,
                expectedEffort,
                "the first business request in the same turn must use the restored effort",
            );
            assert.equal(world.requests.at(-1).maxTokens, 512);
            const events = handle.agent.session.snapshotEvents();
            const helper = events.find(
                (event) =>
                    event.type === "request/header" &&
                    event.data.header.config.reasoningEffort === "low",
            );
            const resumed = events.find(
                (event) => event.seq > helper.seq && event.type === "compaction/summary",
            );
            assert.ok(resumed, "the real official checkpoint committed before business resumed");
            const state = world.ctx.sessionProjections.stateOf(
                handle.agent.session,
                "contextSessionSummary",
            );
            assert.equal(state.active.phase, "committed");
            assert.equal(
                handle.agent.session.requestHeader().adapterDefaults?.reasoningEffort,
                original.adapterDefaults?.reasoningEffort,
            );
            await world.followup(handle, "Continue another ordinary business action.");
            assert.equal(world.requests.at(-1).reasoningEffort, expectedEffort);
        },
    );
}
