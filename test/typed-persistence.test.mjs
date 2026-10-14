import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { assertTestRoot } from "./loop-fixture.mjs";

const worker = fileURLToPath(new URL("./typed-persistence-worker.mjs", import.meta.url));
function run(root, mode) {
    const result = spawnSync(process.execPath, [worker], {
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
    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(
        result.status,
        0,
        `isolated typed ${mode} failed\n${result.stdout}\n${result.stderr}`,
    );
    return JSON.parse(result.stdout.trim().split("\n").at(-1));
}

test(
    "user and assistant text releases survive real AgentLoop writes and cold-process JSONL recovery",
    { timeout: 45000 },
    async (t) => {
        const root = await mkdtemp(join(tmpdir(), "fold-context-test-"));
        t.after(async () => {
            await assertTestRoot(root);
            await rm(root, { recursive: true, force: true });
        });
        const written = run(root, "write");
        assert.equal(written.written, true);
        const resumed = run(root, "read");
        assert.equal(resumed.restored, true);
        assert.notEqual(resumed.pid, written.pid);
    },
);
