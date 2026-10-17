import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { temporaryRoot } from "./attachment-fixture.mjs";
const worker = fileURLToPath(new URL("./attachment-persistence-worker.mjs", import.meta.url));
function run(root, mode) {
    const outcome = spawnSync(process.execPath, [worker], {
        env: {
            PATH: process.env.PATH ?? "",
            TMPDIR: tmpdir(),
            FOLD_CONTEXT_TEST_ROOT: root,
            FOLD_CONTEXT_TEST_MODE: mode,
        },
        encoding: "utf8",
        timeout: 30000,
        maxBuffer: 1024 * 1024,
    });
    assert.equal(outcome.error, undefined, outcome.error?.message);
    assert.equal(outcome.status, 0, `${mode} failed\n${outcome.stdout}\n${outcome.stderr}`);
    return JSON.parse(outcome.stdout.trim().split("\n").at(-1));
}
test(
    "inline image/file releases, duplicate occurrence IDs and verified binaries survive process restart and fork",
    { timeout: 60000 },
    async (t) => {
        const root = await temporaryRoot(t);
        const written = run(root, "write");
        const restored = run(root, "read");
        const child = run(root, "read-child");
        assert.equal(written.written, true);
        assert.equal(written.inlineReleased, true);
        assert.equal(written.summaries, 0);
        assert.equal(restored.restored, true);
        assert.equal(restored.inlineReleased, true);
        assert.equal(restored.forkIsolated, true);
        assert.equal(child.restoredChild, true);
        assert.equal(new Set([written.pid, restored.pid, child.pid]).size, 3);
    },
);
