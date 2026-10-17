import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Script } from "node:vm";

const root = fileURLToPath(new URL("../", import.meta.url));
const source = await readFile(resolve(root, "src/client.js"), "utf8");
new Script(source, { filename: "dsh-fold-context/client.js" });
const target = process.argv[2] ? resolve(process.argv[2]) : resolve(root, "lib/client.js");
await mkdir(dirname(target), { recursive: true });
await writeFile(target, source);
console.log(`Built Client half: ${target}`);
