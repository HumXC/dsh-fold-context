import assert from "node:assert/strict";

/** Append an obsolete v4 intent and prove replay ignores its release request. */
export function recordLegacyRelease(f, ids, reason) {
    assert.ok(Array.isArray(ids) && ids.length > 0, "legacy release needs known IDs");
    assert.equal(new Set(ids).size, ids.length, "legacy release IDs must be unique");
    assert.ok(typeof reason === "string" && reason.trim(), "legacy release needs a reason");
    const state = f.engine.state(f.session);
    for (const id of ids) {
        const entry = state.entries.find((candidate) => candidate.id === id);
        assert.ok(entry, `unknown legacy release ID: ${id}`);
        assert.equal(entry.status, "available", `legacy release ID is not available: ${id}`);
        assert.notEqual(entry.sourceSeq, null, `legacy release ID has no original: ${id}`);
        assert.notEqual(entry.currentSeq, null, `legacy release ID is not on the surface: ${id}`);
    }
    const callId = `legacy-release-${f.session.seq}`;
    const receipt = {
        dshContextCompression: {
            version: 4,
            kind: "release",
            sessionId: f.session.id,
            ids,
            reason,
        },
    };
    f.session.append("tool/ptc-dispatch", {
        rootCallId: callId,
        parentCallId: callId,
        subCallId: `${callId}-intent`,
        name: "context_release",
        arguments: { ids, reason },
        isError: false,
        content: [{ type: "text", text: JSON.stringify(receipt) }],
    });
    const after = f.engine.state(f.session);
    assert.deepEqual(after.entries, state.entries, "obsolete receipts cannot queue evidence");
    assert.deepEqual(after.summaryRequests, state.summaryRequests);
    return receipt;
}
