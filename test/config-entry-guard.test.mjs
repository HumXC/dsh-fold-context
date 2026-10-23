import test from "node:test";
import assert from "node:assert/strict";
import fold from "../lib/index.js";

test("plugin entry rejects removed root vocabulary even if a caller bypasses the schema", () => {
    for (const legacy of ["compaction", "release", "summary", "scheduling", "reminders"]) {
        assert.throws(() => fold.apply({}, { [legacy]: {} }), /Unknown fold configuration field/);
    }
});
