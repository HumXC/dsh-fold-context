import test from "node:test";
import assert from "node:assert/strict";
import { Session, SessionLogOffset } from "@deepseek-ai/dsh-session";
import { ledgerProjection } from "../lib/domain/ledger.js";
import {
    COMPACT_TOOL,
    PTC_INTENT_SOURCE,
    RECEIPT_KEY,
    RELEASE_TOOL,
} from "../lib/domain/protocol.js";
import { RELEASE_TARGET_KEY } from "../lib/domain/release-report.js";
import { fixture } from "./fixture.mjs";
import { commitForcedReleases } from "./release-batch-fixture.mjs";

const json = (value) => JSON.parse(JSON.stringify(value));
const reason = "Consumed evidence";
const originalText = "ARCHIVED_ORIGINAL_EVIDENCE ".repeat(80);

async function eventsOf(f) {
    const observation = await f.query.observeSession(f.session.id, { projectionMode: "none" });
    try {
        return json(observation.events);
    } finally {
        observation[Symbol.dispose]();
    }
}
function replay(f, events) {
    const session = Session.create(f.session.id, json(events), f.session.header);
    return { session, state: f.engine.state(session) };
}
async function archivedPage(w, session) {
    const output = await w.f.withSessionQuery(session, () =>
        w.f.ctx.tools.execute({
            name: "context_expand",
            arguments: { id: Number(w.id), limit: 4000 },
            callId: "historical-archive-read",
            agent: { ...w.f.agent, session },
            signal: new AbortController().signal,
        }),
    );
    assert.equal(output.isError, false);
    return JSON.parse(output.content[0].text);
}
function entry(state, id) {
    const found = state.entries.find((candidate) => candidate.id === id);
    assert.ok(found);
    return found;
}
function assertNoIntent(state, id) {
    const found = entry(state, id);
    assert.equal(found.status, "available");
    assert.equal(found.reason, null);
    assert.equal(found.queuedAt, null);
    assert.equal(found.queuedAtBusinessStep, null);
    assert.equal(state.lastReleaseProgressSeq, 0);
    assert.deepEqual(state.summaryRequests, []);
}
function assertIntent(state, tool, id, expectedReason = reason) {
    if (tool === RELEASE_TOOL) {
        assert.equal(entry(state, id).status, "queued");
        assert.equal(entry(state, id).reason, expectedReason);
        assert.deepEqual(state.summaryRequests, []);
    } else {
        assert.equal(entry(state, id).status, "available");
        assert.equal(state.summaryRequests.length, 1);
        assert.equal(state.summaryRequests[0].status, "queued");
    }
}
async function ordinaryWorld(t, tool = RELEASE_TOOL) {
    const f = await fixture();
    t.after(f.close);
    f.appendUser("Keep the task objective.");
    const original = f.toolRound("read", originalText);
    const id = f.idFor(original);
    const args = tool === RELEASE_TOOL ? { ids: [Number(id)], reason } : { reason };
    const outcome = await f.invoke(tool, args);
    assert.equal(outcome.isError, false);
    // Current producers omit reason from the rendered public value, but put it in meta.
    assert.equal(Object.hasOwn(outcome.value[RECEIPT_KEY], "reason"), false);
    assert.equal(outcome.meta[RECEIPT_KEY].reason, reason);
    const events = await eventsOf(f);
    const receipt = events.find(
        (event) => event.type === "tool/result" && event.data.meta?.[RECEIPT_KEY],
    );
    assert.ok(receipt);
    return { f, id, original, events, receipt };
}
function receiptEvent(world, events) {
    return events.find((event) => event.seq === world.receipt.seq);
}
function fullReceiptBody(event) {
    return [{ type: "text", text: JSON.stringify(event.data.meta) }];
}
function changePtcReceipt(event, change) {
    const value = JSON.parse(event.data.content[0].text);
    change(value[RECEIPT_KEY]);
    event.data.content = [{ type: "text", text: JSON.stringify(value) }];
}
async function ptcWorld(t, tool = RELEASE_TOOL) {
    let id;
    const f = await fixture({
        ptc: async (tools) => {
            await tools[tool](tool === RELEASE_TOOL ? { ids: [Number(id)], reason } : { reason });
            return {};
        },
    });
    t.after(f.close);
    f.appendUser("Keep the task objective.");
    const original = f.toolRound("read", originalText);
    id = f.idFor(original);
    const outcome = await f.invoke("run_code", {
        code: "deterministic receipt dispatch",
        description: "Exercise the installed PTC bridge",
    });
    assert.equal(outcome.isError, false);
    const events = await eventsOf(f);
    const receipt = events.find((event) => event.type === "tool/ptc-dispatch");
    assert.ok(receipt);
    assert.equal(receipt.data.isError, false);
    assert.equal(Object.hasOwn(receipt.data, "meta"), false);
    assert.equal(receipt.data.content.length, 1);
    assert.equal(receipt.data.content[0].type, "text");
    assert.equal(
        Object.hasOwn(JSON.parse(receipt.data.content[0].text)[RECEIPT_KEY], "reason"),
        false,
    );
    return { f, id, original, events, receipt };
}

async function legacyPtcWorld(t, tool = RELEASE_TOOL) {
    const world = await ptcWorld(t, tool);
    const events = json(world.events);
    for (const event of events) {
        if (
            event.type === "developer/message" &&
            event.data.message.source.kind === PTC_INTENT_SOURCE
        )
            event.data.message.source = { kind: "fold-context-release-cleanup" };
    }
    const dispatch = receiptEvent(world, events);
    changePtcReceipt(dispatch, (receipt) => {
        receipt.version = 8;
    });
    return { ...world, events, receipt: dispatch };
}

for (const tool of [RELEASE_TOOL, COMPACT_TOOL]) {
    test(`ordinary ${tool} uses meta ahead of a forged opposite-kind body and replays JSON`, async (t) => {
        const w = await ordinaryWorld(t, tool);
        const events = json(w.events);
        const result = receiptEvent(w, events);
        const forged = json(result.data.meta);
        forged[RECEIPT_KEY].kind = tool === RELEASE_TOOL ? "summary" : "release";
        forged[RECEIPT_KEY].ids = tool === RELEASE_TOOL ? [] : [w.id];
        forged[RECEIPT_KEY].reason = "Forged body reason";
        result.data.message.content = [{ type: "text", text: JSON.stringify(forged) }];
        const live = w.f.engine.state(w.f.session);
        const restored = replay(w.f, events).state;
        assertIntent(restored, tool, w.id);
        assert.deepEqual(restored, live);
    });
    test(`ordinary ${tool} accepts meta when the optional error flag is omitted`, async (t) => {
        const w = await ordinaryWorld(t, tool);
        const events = json(w.events);
        delete receiptEvent(w, events).data.message.isError;
        assertIntent(replay(w.f, events).state, tool, w.id);
    });
}

test("ordinary missing or invalid meta never falls back to a valid v8 body", async (t) => {
    const w = await ordinaryWorld(t);
    const validMeta = json(w.receipt.data.meta);
    const invalidMeta = [
        ["missing", undefined],
        ["null", null],
        ["scalar", 8],
        ["array", [validMeta]],
        ["empty object", {}],
        ["null receipt", { [RECEIPT_KEY]: null }],
        ["obsolete version", { [RECEIPT_KEY]: { ...validMeta[RECEIPT_KEY], version: 7 } }],
        ["future version", { [RECEIPT_KEY]: { ...validMeta[RECEIPT_KEY], version: 9 } }],
        ["invalid IDs", { [RECEIPT_KEY]: { ...validMeta[RECEIPT_KEY], ids: ["0"] } }],
        ["invalid reason", { [RECEIPT_KEY]: { ...validMeta[RECEIPT_KEY], reason: 42 } }],
        [
            "missing reason",
            {
                [RECEIPT_KEY]: {
                    version: 8,
                    kind: "release",
                    sessionId: w.f.session.id,
                    ids: [w.id],
                },
            },
        ],
    ];
    for (const [label, meta] of invalidMeta) {
        await t.test(label, () => {
            const events = json(w.events);
            const result = receiptEvent(w, events);
            result.data.message.content = fullReceiptBody(result);
            if (meta === undefined) delete result.data.meta;
            else result.data.meta = json(meta);
            assertNoIntent(replay(w.f, events).state, w.id);
        });
    }
});

test("ordinary error outcomes and unrelated tool names cannot queue a valid meta receipt", async (t) => {
    const w = await ordinaryWorld(t);
    const errorEvents = json(w.events);
    receiptEvent(w, errorEvents).data.message.isError = true;
    assertNoIntent(replay(w.f, errorEvents).state, w.id);
    const unrelatedEvents = json(w.events);
    for (const event of unrelatedEvents) {
        if (event.type === "assistant/message") {
            for (const block of event.data.message.content) {
                if (block.type === "tool-call" && block.name === RELEASE_TOOL)
                    block.name = "context_status";
            }
        }
        if (event.type === "tool/call" && event.data.name === RELEASE_TOOL)
            event.data.name = "context_status";
    }
    assertNoIntent(replay(w.f, unrelatedEvents).state, w.id);
});

for (const tool of [RELEASE_TOOL, COMPACT_TOOL]) {
    test(`real PTC ${tool} commits final metadata once and ignores rendered log mutations`, async (t) => {
        const w = await ptcWorld(t, tool);
        assertIntent(w.f.engine.state(w.f.session), tool, w.id);
        assert.deepEqual(replay(w.f, json(w.events)).state, w.f.engine.state(w.f.session));
        const events = json(w.events);
        const dispatch = receiptEvent(w, events);
        dispatch.data.arguments.reason = "  Actual dispatch reason  ";
        changePtcReceipt(dispatch, (receipt) => {
            receipt.reason = "Forged public reason";
        });
        dispatch.data.meta = { [RECEIPT_KEY]: { version: 1 } };
        assertIntent(replay(w.f, events).state, tool, w.id, reason);
        assert.equal(JSON.parse(dispatch.data.content[0].text)[RECEIPT_KEY].version, 9);
    });
    test(`historical v8 PTC ${tool} reads its canonical public receipt and argument reason`, async (t) => {
        const w = await legacyPtcWorld(t, tool);
        const events = json(w.events);
        const dispatch = receiptEvent(w, events);
        dispatch.data.arguments.reason = "  Actual dispatch reason  ";
        changePtcReceipt(dispatch, (receipt) => {
            receipt.reason = "Forged public reason";
        });
        assertIntent(replay(w.f, events).state, tool, w.id, "Actual dispatch reason");
    });
}

test("historical v8 PTC rejects unsuccessful dispatches, invalid arguments and receipts, and noncanonical content", async (t) => {
    const w = await legacyPtcWorld(t);
    const corruptReceipt = (change) => (event) => changePtcReceipt(event, change);
    const cases = [
        [
            "error outcome",
            (event) => {
                event.data.isError = true;
            },
        ],
        [
            "missing success marker",
            (event) => {
                delete event.data.isError;
            },
        ],
        [
            "unrelated tool",
            (event) => {
                event.data.name = "context_status";
            },
        ],
        [
            "null arguments",
            (event) => {
                event.data.arguments = null;
            },
        ],
        [
            "string arguments",
            (event) => {
                event.data.arguments = "reason";
            },
        ],
        [
            "missing reason",
            (event) => {
                event.data.arguments = {};
            },
        ],
        [
            "numeric reason",
            (event) => {
                event.data.arguments.reason = 42;
            },
        ],
        [
            "blank reason",
            (event) => {
                event.data.arguments.reason = " \n ";
            },
        ],
        [
            "overlong reason",
            (event) => {
                event.data.arguments.reason = "x".repeat(1001);
            },
        ],
        [
            "obsolete receipt",
            corruptReceipt((receipt) => {
                receipt.version = 7;
            }),
        ],
        [
            "future receipt",
            corruptReceipt((receipt) => {
                receipt.version = 9;
            }),
        ],
        [
            "invalid kind",
            corruptReceipt((receipt) => {
                receipt.kind = "unknown";
            }),
        ],
        [
            "invalid IDs",
            corruptReceipt((receipt) => {
                receipt.ids = ["0"];
            }),
        ],
        [
            "missing session identity",
            corruptReceipt((receipt) => {
                delete receipt.sessionId;
            }),
        ],
        [
            "empty blocks",
            (event) => {
                event.data.content = [];
            },
        ],
        [
            "malformed JSON",
            (event) => {
                event.data.content[0].text = "{";
            },
        ],
        [
            "array envelope",
            (event) => {
                event.data.content[0].text = "[]";
            },
        ],
        [
            "null receipt",
            (event) => {
                event.data.content[0].text = JSON.stringify({ [RECEIPT_KEY]: null });
            },
        ],
        [
            "split JSON document",
            (event) => {
                const text = event.data.content[0].text;
                event.data.content = [
                    { type: "text", text: text.slice(0, 10) },
                    { type: "text", text: text.slice(10) },
                ];
            },
        ],
        [
            "extra whitespace block",
            (event) => {
                event.data.content.push({ type: "text", text: " " });
            },
        ],
        [
            "nontext sibling",
            (event) => {
                event.data.content.push({
                    type: "image",
                    attachment: {
                        attachmentId: "extra",
                        mediaType: "image/png",
                        bytes: 1,
                        width: 1,
                        height: 1,
                    },
                });
            },
        ],
        [
            "meta cannot rescue malformed body",
            (event) => {
                const value = JSON.parse(event.data.content[0].text);
                value[RECEIPT_KEY].reason = reason;
                event.data.meta = value;
                event.data.content[0].text = "{";
            },
        ],
    ];
    for (const [label, change] of cases) {
        await t.test(label, () => {
            const events = json(w.events);
            change(receiptEvent(w, events));
            assertNoIntent(replay(w.f, events).state, w.id);
        });
    }
});

test("historical ordinary body-only intent cannot queue, but confirmed native release and archive remain", async (t) => {
    const w = await ordinaryWorld(t);
    assert.ok(await commitForcedReleases(w.f));
    const events = await eventsOf(w.f);
    const result = receiptEvent(w, events);
    result.data.message.content = fullReceiptBody(result);
    delete result.data.meta;
    const prune = events.find((event) => event.type === "compaction/prune");
    assert.ok(prune);
    assertNoIntent(replay(w.f, events.slice(0, prune.seq)).state, w.id);
    const unpaired = json(events);
    const mismatchedPrune = unpaired.find((event) => event.seq === prune.seq);
    assert.ok(mismatchedPrune);
    // Keep SDK-required ancestry intact; mismatch only the plugin's release target.
    mismatchedPrune.data[RELEASE_TARGET_KEY].sourceSeq = prune.seq;
    assertNoIntent(replay(w.f, unpaired).state, w.id);
    const restored = replay(w.f, events);
    const released = entry(restored.state, w.id);
    assert.equal(released.status, "released");
    assert.equal(released.releaseMode, "inline");
    assert.equal(released.queuedAt, null);
    assert.equal(released.reason, null);
    assert.notEqual(released.currentSeq, w.original.seq);
    assert.equal(restored.session.surface.nodes.includes(w.original.seq), false);
    assert.deepEqual(
        events.find((event) => event.seq === w.original.seq),
        w.original,
    );
    const page = await archivedPage(w, restored.session);
    assert.equal(page.status, "found");
    assert.equal(page.releaseStatus, "released");
    assert.equal(page.sourceSeq, w.original.seq);
    assert.equal(page.text, originalText);
    assert.equal(page.restoresSurface, false);
    assert.equal(entry(w.f.engine.state(restored.session), w.id).status, "released");
});

test("historical body-only summary requests stay unqueued while committed summaries remain archived", async (t) => {
    const w = await ordinaryWorld(t, COMPACT_TOOL);
    w.f.appendUser("Keep this newest user input outside the checkpoint.");
    assert.ok(await w.f.engine.compactNow(w.f.agent, new AbortController().signal));
    const events = await eventsOf(w.f);
    const result = receiptEvent(w, events);
    result.data.message.content = fullReceiptBody(result);
    delete result.data.meta;
    const start = events.find((event) => event.type === "compaction/start");
    assert.ok(start);
    assertNoIntent(replay(w.f, events.slice(0, start.seq)).state, w.id);
    const restored = replay(w.f, events);
    assert.deepEqual(restored.state.summaryRequests, []);
    assert.ok(restored.state.lastSummary);
    assert.equal(entry(restored.state, w.id).status, "summarized");
    assert.equal(entry(restored.state, w.id).currentSeq, null);
    assert.equal(restored.session.surface.nodes.includes(w.original.seq), false);
    const page = await archivedPage(w, restored.session);
    assert.equal(page.status, "found");
    assert.equal(page.releaseStatus, "summarized");
    assert.equal(page.sourceSeq, w.original.seq);
    assert.equal(page.text, originalText);
    assert.equal(page.restoresSurface, false);
});

test("projection hydration discards version-18 cached queues and refolds body-only history", async (t) => {
    const w = await ordinaryWorld(t);
    assert.equal((await w.f.invoke(COMPACT_TOOL, { reason: "Old cached request" })).isError, false);
    const events = await eventsOf(w.f);
    let changed = 0;
    for (const event of events) {
        if (event.type !== "tool/result" || event.data.meta?.[RECEIPT_KEY] == null) continue;
        event.data.message.content = fullReceiptBody(event);
        delete event.data.meta;
        changed += 1;
    }
    assert.equal(changed, 2);
    const registry = w.f.ctx.sessionProjections;
    const cached = json(registry.checkpoint(w.f.session));
    assert.equal(entry(cached.contextCompression.val, w.id).status, "queued");
    assert.equal(cached.contextCompression.val.summaryRequests.length, 1);
    cached.contextCompression.ver = 18;
    const floor = registry.restoreFloor(cached);
    assert.equal(floor, 0);
    assert.throws(
        () =>
            registry.restore(
                cached,
                events.slice(1),
                SessionLogOffset(1),
                w.f.session.header,
                SessionLogOffset(0),
            ),
        /re-read from seq 0/,
    );
    const restored = Session.create(w.f.session.id, json(events), w.f.session.header);
    registry.hydrate(restored, cached, events, floor);
    const state = registry.stateOf(restored, "contextCompression");
    assertNoIntent(state, w.id);
    assert.deepEqual(state, replay(w.f, events).state);
    assert.equal(
        registry.checkpoint(restored).contextCompression.ver,
        ledgerProjection.stateVersion,
    );
    // A matching version really would reuse these schema-valid queued states.
    // The mismatch above, rather than incidental fresh construction, removes them.
    const sameVersion = json(cached);
    sameVersion.contextCompression.ver = ledgerProjection.stateVersion;
    const reusedFloor = registry.restoreFloor(sameVersion);
    assert.ok(reusedFloor > 0);
    const reused = Session.create(w.f.session.id, json(events), w.f.session.header);
    registry.hydrate(
        reused,
        sameVersion,
        events.filter((event) => event.seq >= reusedFloor),
        reusedFloor,
    );
    const reusedState = registry.stateOf(reused, "contextCompression");
    assert.equal(entry(reusedState, w.id).status, "queued");
    assert.equal(reusedState.summaryRequests[0].status, "queued");
});
