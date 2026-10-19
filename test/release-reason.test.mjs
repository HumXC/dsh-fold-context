import test from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./fixture.mjs";
import { commitForcedReleases } from "./release-batch-fixture.mjs";
import { recoveryReleaseMetadata } from "../lib/domain/release-metadata.js";

const valueOf = (outcome) => {
    assert.equal(outcome.isError, false, JSON.stringify(outcome));
    return JSON.parse(
        outcome.content
            .filter((block) => block.type === "text")
            .map((block) => block.text)
            .join(""),
    );
};

test("recovery provenance distinguishes completed release from queued or summarized marking intent", () => {
    const state = {
        entries: [
            { id: "1", status: "released", reason: "Original reason 🧠", ownerId: null },
            { id: "2", status: "released", reason: null, ownerId: "1" },
            { id: "3", status: "released", reason: "Attachment-specific reason", ownerId: "1" },
            { id: "4", status: "queued", reason: "Not applied", ownerId: null },
            { id: "5", status: "summarized", reason: "Old unfulfilled marking", ownerId: null },
            { id: "6", status: "available", reason: null, ownerId: null },
            { id: "7", status: "released", reason: null, ownerId: null },
            { id: "8", status: "queued", reason: "A later owner marking", ownerId: null },
            { id: "9", status: "released", reason: null, ownerId: "8" },
        ],
    };
    assert.equal(recoveryReleaseMetadata(state, "1").releaseReason, "Original reason 🧠");
    assert.equal(recoveryReleaseMetadata(state, "2").releaseReason, "Original reason 🧠");
    assert.equal(recoveryReleaseMetadata(state, "3").releaseReason, "Attachment-specific reason");
    for (const id of ["4", "5", "6", "7", "9", "999"])
        assert.equal("releaseReason" in recoveryReleaseMetadata(state, id), false);
    assert.equal(recoveryReleaseMetadata(state, "999").releaseStatus, null);
});

test("every recovered page carries the original release reason without restoring the released source", async (t) => {
    const f = await fixture();
    t.after(f.close);
    const original = "Evidence 🧠\n".repeat(60);
    const event = f.toolRound("read", original);
    const id = Number(f.idFor(event));
    const reason = "Analysis completed; exact conclusion preserved. 🧠";
    await f.invoke("context_release", { ids: [id], reason });
    const queued = valueOf(await f.invoke("context_expand", { id, limit: 20 }));
    assert.equal(queued.releaseStatus, "queued");
    assert.equal("releaseReason" in queued, false);
    commitForcedReleases(f);
    const before = [...f.session.surface.nodes];
    let offset = 0,
        recovered = "";
    do {
        const page = valueOf(await f.invoke("context_expand", { id, offset, limit: 71 }));
        assert.equal(page.releaseReason, reason);
        assert.equal(page.releaseStatus, "released");
        assert.equal(page.restoresSurface, false);
        recovered += page.text;
        offset = page.nextOffset;
    } while (offset !== null);
    assert.equal(recovered, original);
    assert.ok(before.every((seq) => f.session.surface.nodes.includes(seq)));
    assert.equal(
        f.engine.state(f.session).entries.find((entry) => entry.id === String(id)).status,
        "released",
    );
    const searched = valueOf(await f.invoke("context_search", { query: "Evidence", limit: 1 }));
    assert.equal(searched.hits.length, 1);
    assert.equal("releaseReason" in searched.hits[0], false);
    await f.invoke("context_release", { ids: [id], reason: "A later redundant request" });
    assert.equal(
        valueOf(await f.invoke("context_expand", { id, limit: 10 })).releaseReason,
        reason,
    );
});

test("replayed released evidence recovers its stored reason from the session log", async (t) => {
    const f = await fixture();
    t.after(f.close);
    const event = f.toolRound("read", "Persistent original evidence");
    const id = Number(f.idFor(event));
    await f.invoke("context_release", { ids: [id], reason: "Saved before replay" });
    commitForcedReleases(f);
    const restored = f.sessions.create("restored-release-reason", {
        seed: f.session.snapshotEvents(),
        inheritedEventCount: f.session.seq,
        meta: { isSeeded: true, parentSession: f.session.id },
    });
    const recovered = valueOf(
        await f.ctx.tools.execute({
            name: "context_expand",
            arguments: { id },
            callId: "replayed-reason",
            agent: { ...f.agent, id: restored.id, session: restored },
            signal: new AbortController().signal,
        }),
    );
    assert.equal(recovered.text, "Persistent original evidence");
    assert.equal(recovered.releaseReason, "Saved before replay");
    assert.equal(recovered.releaseStatus, "released");
});
