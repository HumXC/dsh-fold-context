import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertTestRoot, call, loopFixture } from "./loop-fixture.mjs";
import { SUBMIT_SUMMARY_TOOL } from "../lib/domain/session-summary.js";
import { SessionSummaryCoordinator } from "../lib/integration/session-summary.js";

test(
    "session summaries use the public Agent context without accessing its private scope",
    { timeout: 15000 },
    async (t) => {
        const root = await mkdtemp(join(tmpdir(), "fold-context-test-"));
        let handle;
        const world = await loopFixture(root, {
            strictSession: true,
            summaryModels: [
                {
                    provider: "test",
                    model: "mock",
                    preferWhenSessionMatches: true,
                    useSessionAgent: true,
                },
            ],
            responses: [
                { blocks: [{ type: "text", text: "Initial verified evidence." }] },
                (_request, fixture) => {
                    const active = fixture.ctx.sessionProjections.stateOf(
                        handle.agent.session,
                        "contextSessionSummary",
                    ).active;
                    return call(SUBMIT_SUMMARY_TOOL, {
                        checkpointId: active.plan.checkpointId,
                        summary: "Keep the verified evidence and continue the user's task.",
                    });
                },
            ],
        });
        t.after(async () => {
            try {
                await world.close();
            } finally {
                await assertTestRoot(root);
                await rm(root, { recursive: true, force: true });
            }
        });
        handle = await world.create({
            agentOptions: { provider: "test", model: "mock", maxTokens: 512 },
        });
        await world.followup(
            handle,
            "Keep the verified evidence and unfinished action. ".repeat(240),
        );
        const publicAgent = new Proxy(handle.agent, {
            get(target, key) {
                assert.notEqual(key, "scope", "plugin must use the public Agent.ctx lifecycle");
                const value = Reflect.get(target, key, target);
                return typeof value === "function" ? value.bind(target) : value;
            },
        });
        const result = await world.engine.compactNow(publicAgent, new AbortController().signal);
        await handle.agent.whenIdle();
        assert.ok(result);
        assert.equal(
            world.ctx.sessionProjections.stateOf(handle.agent.session, "contextSessionSummary")
                .active.phase,
            "committed",
        );
        assert.equal(handle.agent.session.requestHeader().config.maxTokens, 512);
        assert.equal(world.summaries.length, 0);
        assert.equal(world.query.activeLeases, 0);
    },
);

test("failed recovery still settles the manual waiter when public replay fails", async () => {
    const coordinator = Object.create(SessionSummaryCoordinator.prototype);
    const original = new Error("official commit failed before completion");
    const recovery = new Error("public replay unavailable");
    const plan = { checkpointId: "failed-recovery" };
    let settled;
    let disposed = false;
    coordinator.engine = {
        commitSessionSummary: async () => {
            throw original;
        },
    };
    coordinator.refreshDetachedState = async () => {
        throw recovery;
    };
    coordinator.waiters = new Map([
        [
            plan.checkpointId,
            {
                dispose: () => {
                    disposed = true;
                },
                reject: (error) => {
                    settled = error;
                },
            },
        ],
    ]);
    coordinator.claims = new Map([[plan.checkpointId, "claimed"]]);
    await assert.rejects(
        coordinator.commit({ session: {} }, plan, "Summary", new AbortController().signal, "step"),
        (error) => error === recovery,
    );
    assert.equal(settled, original);
    assert.equal(disposed, true);
    assert.equal(coordinator.waiters.size, 0);
    assert.equal(coordinator.claims.size, 0);
});
