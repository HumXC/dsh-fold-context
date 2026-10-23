import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertTestRoot, call, loopFixture } from "./loop-fixture.mjs";

const signal = () => new AbortController().signal;

test(
    "busy manual compaction preserves queued evidence before the SDK maintenance guard",
    { timeout: 15000 },
    async (t) => {
        const root = await mkdtemp(join(tmpdir(), "fold-context-test-"));
        const entered = Promise.withResolvers();
        const resume = Promise.withResolvers();
        let handle;
        const f = await loopFixture(root, {
            compaction: { auto: false, cacheReadRatio: 0 },
            scheduling: {
                cacheTtlMs: 0,
            },
            tools: { read_archive: () => "ORIGINAL_QUEUED_EVIDENCE ".repeat(5) },
            responses: [
                call("read_archive"),
                (_request, world) => {
                    const entry = world.engine
                        .state(handle.agent.session)
                        .entries.find((item) => item.tool === "read_archive");
                    return call("context_release", {
                        ids: [Number(entry.id)],
                        reason: "The useful facts have been retained",
                    });
                },
                {
                    blocks: [
                        {
                            type: "text",
                            text: "The evidence is consumed and the task can continue.",
                        },
                    ],
                },
                async () => {
                    entered.resolve();
                    await resume.promise;
                    return {
                        blocks: [{ type: "text", text: "The next business step completed." }],
                    };
                },
            ],
        });
        t.after(async () => {
            resume.resolve();
            try {
                await f.close();
            } finally {
                await assertTestRoot(root);
                await rm(root, { recursive: true, force: true });
            }
        });
        handle = await f.create();
        await f.followup(handle, "Investigate this task and retain its requirements. ".repeat(100));
        const session = handle.agent.session;
        const queued = f.engine.state(session).entries.find((item) => item.tool === "read_archive");
        assert.equal(queued.status, "queued");
        const pending = f.followup(handle, "Continue the next business step.");
        await entered.promise;
        const before = {
            seq: session.seq,
            nodes: [...session.surface.nodes],
            state: f.engine.state(session),
        };
        try {
            await assert.rejects(
                async () => f.engine.compactNow(handle.agent, signal()),
                /idle agent/,
            );
            assert.equal(session.seq, before.seq);
            assert.deepEqual(session.surface.nodes, before.nodes);
            assert.deepEqual(f.engine.state(session), before.state);
            assert.equal(f.summaries.length, 0);
            assert.ok(
                JSON.stringify(session.deriveMessages()).includes("ORIGINAL_QUEUED_EVIDENCE"),
            );
        } finally {
            resume.resolve();
            await pending;
        }
        await f.engine.compactNow(handle.agent, signal());
        assert.equal(f.summaries.length, 1);
        assert.ok(
            f.summaries.every(
                (request) => !JSON.stringify(request.messages).includes("ORIGINAL_QUEUED_EVIDENCE"),
            ),
        );
        assert.equal(
            f.engine.state(session).entries.find((item) => item.id === queued.id).status,
            "released",
        );
        assert.ok(session.snapshotEvents().some((event) => event.type === "compaction/end"));
    },
);
