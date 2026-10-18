import assert from "node:assert/strict";
import { readFile, writeFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { SessionId, SessionSeq, SessionLogOffset, buildForkSeed } from "@deepseek-ai/dsh-session";
import { loopFixture, assertTestRoot, call } from "./loop-fixture.mjs";

const root = process.env.FOLD_CONTEXT_TEST_ROOT;
await assertTestRoot(root);
const mode = process.env.FOLD_CONTEXT_TEST_MODE;
const expectedPath = join(root, "expected.json");
const original = "RESTART_ORIGINAL 🧠é\n  preserved whitespace.\n".repeat(250);
const invoke = async (f, handle, name, args) => {
    const outcome = await f.ctx.tools.execute({
        name,
        arguments: args,
        callId: "isolated-cold-read",
        agent: handle.agent,
        signal: new AbortController().signal,
    });
    assert.equal(outcome.isError, false, JSON.stringify(outcome));
    return JSON.parse(outcome.content.map((block) => block.text ?? "").join(""));
};
async function files(directory) {
    const paths = [];
    for (const entry of await readdir(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) paths.push(...(await files(path)));
        else if (entry.isFile()) paths.push(path);
    }
    return paths;
}

if (mode === "write") {
    let inlineEntry;
    const f = await loopFixture(root, {
        auto: false,
        compaction: { retainTokens: 0 },
        // Keep this cold-process archival scenario independent of production cost thresholds.
        scheduling: {
            minIntervalSteps: 0,
            minSavingsTokens: 1,
            minSavingsRatio: 0,
            expectedSummaryRatio: 0.05,
            cacheReadRatio: 1,
            summaryInputRatio: 0.01,
            summaryOutputRatio: 0.01,
            releaseMinTokens: 0,
            releaseBacklogRatio: 0.000001,
        },
        tools: { probe_read: () => original },
        responses: [
            call("probe_read"),
            (_request, world) =>
                call("context_release", {
                    ids: [
                        Number(
                            world.engine
                                .state(world.sessions.list()[0])
                                .entries.find((entry) => entry.role === "tool").id,
                        ),
                    ],
                    reason: "Consumed before restart",
                }),
            (request, world) => {
                const session = world.sessions.list()[0];
                const state = world.engine.state(session);
                inlineEntry = structuredClone(state.entries.find((entry) => entry.role === "tool"));
                assert.equal(inlineEntry.status, "released");
                assert.equal(state.lastSummary, null);
                assert.equal(world.summaries.length, 0);
                assert.ok(session.surface.nodes.includes(inlineEntry.currentSeq));
                assert.equal(session.surface.nodes.includes(inlineEntry.sourceSeq), false);
                assert.ok(
                    JSON.stringify(request.messages).includes(`[released ${inlineEntry.id}]`),
                );
                assert.equal(JSON.stringify(request.messages).includes(original), false);
                return {
                    blocks: [
                        {
                            type: "text",
                            text: "The restart objective and released evidence are recorded.",
                        },
                    ],
                };
            },
            call("context_compact", {
                reason: "Durable covering checkpoint before restart",
            }),
        ],
    });
    try {
        const handle = await f.create();
        await f.followup(handle, "Preserve the restart user objective. ".repeat(500));
        assert.equal(f.summaries.length, 0);
        await f.followup(handle, "Checkpoint the completed work before restarting this session.");
        await f.flush(handle);
        const state = f.engine.state(handle.agent.session);
        const entry = state.entries.find((entry) => entry.role === "tool");
        assert.equal(entry.status, "released");
        assert.equal(f.summaries.length, 1);
        assert.ok(state.lastSummary.ids.includes(entry.id));
        assert.equal(state.lastSummary.excludedIds.includes(entry.id), true);
        assert.equal(
            handle.agent.session
                .deriveMessages()
                .some((message) =>
                    message.content.some(
                        (block) => block.type === "text" && block.text === `[released ${entry.id}]`,
                    ),
                ),
            false,
        );
        assert.equal(
            handle.agent.session.snapshotEvents().find((event) => event.seq === entry.sourceSeq)
                .data.message.content[0].text,
            original,
        );
        const expected = {
            sessionId: handle.agent.session.id,
            events: handle.agent.session.snapshotEvents(),
            surface: [...handle.agent.session.surface.nodes],
            numbering: state.numbering,
            originalId: entry.id,
            originalSeq: entry.sourceSeq,
            inlineEntry,
            lastSummary: state.lastSummary,
            original,
        };
        await writeFile(expectedPath, JSON.stringify(expected), "utf8");
        const logs = (await files(join(root, "sessions"))).filter((path) =>
            path.endsWith(".jsonl"),
        );
        assert.ok(logs.length > 0, "an actual JSONL log exists");
        const bytes = await Promise.all(logs.map((path) => readFile(path)));
        assert.ok(bytes.some((contents) => contents.toString("utf8").includes("RESTART_ORIGINAL")));
        assert.ok(logs.every((path) => !relative(root, path).startsWith("..")));
        process.stdout.write(
            `${JSON.stringify({ mode, pid: process.pid, sessionId: expected.sessionId, eventCount: expected.events.length, nextNumber: state.numbering.nextNumber, inlineReleased: inlineEntry.status === "released", summaryCovered: state.lastSummary.ids.includes(entry.id), jsonlBytes: bytes.reduce((total, value) => total + value.length, 0) })}\n`,
        );
    } finally {
        await f.close();
    }
} else if (mode === "read-and-fork") {
    const expected = JSON.parse(await readFile(expectedPath, "utf8"));
    const f = await loopFixture(root);
    try {
        const parent = await f.resume(SessionId(expected.sessionId));
        const session = parent.agent.session;
        assert.deepEqual(
            session.snapshotEvents().slice(0, expected.events.length),
            expected.events,
        );
        assert.deepEqual(session.surface.nodes, expected.surface);
        assert.deepEqual(f.engine.state(session).numbering, expected.numbering);
        assert.equal(f.requests.length, 0, "cold resume does not manufacture a model request");
        assert.deepEqual(f.engine.state(session).lastSummary, expected.lastSummary);
        assert.equal(
            f.engine.state(session).entries.find((entry) => entry.id === expected.originalId)
                .status,
            "released",
        );
        const inlineReplacement = session
            .snapshotEvents()
            .find((event) => event.seq === expected.inlineEntry.currentSeq);
        assert.ok(
            JSON.stringify(inlineReplacement.data.message.content).includes(
                `[released ${expected.originalId}]`,
            ),
        );
        const recovered = await invoke(f, parent, "context_expand", {
            id: Number(expected.originalId),
            limit: 16000,
        });
        assert.equal(recovered.text, expected.original);
        assert.equal(recovered.sourceSeq, expected.originalSeq);
        assert.equal(recovered.releaseStatus, "released");
        assert.equal(recovered.restoresSurface, false);
        assert.deepEqual(session.surface.nodes, expected.surface);
        const found = await invoke(f, parent, "context_search", {
            query: "RESTART_ORIGINAL",
            roles: ["tool"],
        });
        assert.deepEqual(
            found.hits.map((hit) => hit.id),
            [expected.originalId],
        );
        const parentNext = f.engine.state(session).numbering.nextNumber;
        const parentEvents = session.snapshotEvents();
        const boundary = SessionSeq(parentEvents.length - 1);
        const child = await f.create({
            seed: buildForkSeed(parentEvents, boundary),
            inheritedEventCount: SessionLogOffset(boundary + 1),
            meta: { cwd: root, parentSession: session.id, isSeeded: true },
        });
        assert.equal(
            (
                await invoke(f, child, "context_expand", {
                    id: Number(expected.originalId),
                    limit: 16000,
                })
            ).text,
            expected.original,
        );
        await f.followup(child, "FORK_CHILD_PRIVATE evidence.");
        const childHits = await invoke(f, child, "context_search", {
            query: "FORK_CHILD_PRIVATE",
            roles: ["user"],
        });
        assert.equal(childHits.hits.length, 1);
        assert.equal(
            (await invoke(f, parent, "context_search", { query: "FORK_CHILD_PRIVATE" })).hits
                .length,
            0,
        );
        assert.equal(f.engine.state(session).numbering.nextNumber, parentNext);
        assert.equal(f.engine.state(child.agent.session).numbering.nextNumber, parentNext + 2);
        assert.deepEqual(
            session.snapshotEvents().slice(0, expected.events.length),
            expected.events,
        );
        await f.flush(child);
        await writeFile(
            join(root, "child.json"),
            JSON.stringify({
                sessionId: child.agent.session.id,
                privateId: childHits.hits[0].id,
                nextNumber: f.engine.state(child.agent.session).numbering.nextNumber,
            }),
            "utf8",
        );
        assert.equal(f.query.activeLeases, 0);
        process.stdout.write(
            `${JSON.stringify({ mode, pid: process.pid, nextNumber: parentNext, childNextNumber: parentNext + 2, restored: true, forkIsolated: true })}\n`,
        );
    } finally {
        await f.close();
    }
} else if (mode === "read-child") {
    const child = JSON.parse(await readFile(join(root, "child.json"), "utf8"));
    const expected = JSON.parse(await readFile(expectedPath, "utf8"));
    const f = await loopFixture(root);
    try {
        const handle = await f.resume(SessionId(child.sessionId));
        assert.equal(f.engine.state(handle.agent.session).numbering.nextNumber, child.nextNumber);
        assert.equal(
            (await invoke(f, handle, "context_expand", { id: Number(child.privateId) })).text,
            "FORK_CHILD_PRIVATE evidence.",
        );
        assert.equal(
            (
                await invoke(f, handle, "context_expand", {
                    id: Number(expected.originalId),
                    limit: 16000,
                })
            ).text,
            expected.original,
        );
        process.stdout.write(
            `${JSON.stringify({ mode, pid: process.pid, restoredChild: true, nextNumber: child.nextNumber })}\n`,
        );
    } finally {
        await f.close();
    }
} else throw new Error("unknown isolated persistence worker mode");
