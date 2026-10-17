import { cp, copyFile, mkdtemp, readdir, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const stage = await mkdtemp(join(tmpdir(), "fold-context-verify-"));
await cp(join(root, "test"), join(stage, "test"), { recursive: true });
await copyFile(join(root, "package.json"), join(stage, "package.json"));
await symlink(join(root, "node_modules"), join(stage, "node_modules"), "dir");
console.log(`Isolated build and tests: ${stage}`);

function run(args, cwd) {
    const result = spawnSync(process.execPath, args, { cwd, stdio: "inherit" });
    if (result.error) throw result.error;
    if (result.status !== 0) process.exit(result.status ?? 1);
}
run(
    [
        join(root, "node_modules/typescript/bin/tsc"),
        "-p",
        join(root, "tsconfig.json"),
        "--outDir",
        join(stage, "lib"),
    ],
    root,
);
run([join(root, "scripts/build-client.mjs"), join(stage, "lib/client.js")], root);
const selected = process.argv.slice(2).filter((argument) => argument !== "--");
const names = selected.length ? selected : await readdir(join(stage, "test"));
if (selected.some((name) => basename(name) !== name || !name.endsWith(".test.mjs"))) {
    throw new Error("Pass test basenames ending in .test.mjs");
}
run(
    [
        "--test",
        ...names
            .filter((name) => name.endsWith(".test.mjs"))
            .sort()
            .map((name) => join(stage, "test", name)),
    ],
    stage,
);
