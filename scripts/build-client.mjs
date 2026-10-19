import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Script } from "node:vm";

const root = fileURLToPath(new URL("../", import.meta.url));
const target = process.argv[2] ? resolve(process.argv[2]) : resolve(root, "lib/client.js");
const { POLICY_GROUPS, normalizePolicyOverrides } = await import(
    pathToFileURL(resolve(dirname(target), "domain/settings-catalog.js"))
);
const original = await readFile(resolve(root, "src/client.js"), "utf8");
const marker = "/*__FOLD_POLICY_SETTINGS__*/";
if (original.split(marker).length !== 2)
    throw new Error("Expected one policy settings injection point");
const policyClient = await readFile(resolve(root, "src/client-policy.js"), "utf8");
const source = original.replace(
    marker,
    `const POLICY_GROUPS = ${JSON.stringify(POLICY_GROUPS)};\nconst normalizePolicyOverrides = ${normalizePolicyOverrides.toString()};\n${policyClient}`,
);
new Script(source, { filename: "dsh-fold-context/client.js" });
await mkdir(dirname(target), { recursive: true });
await writeFile(target, source);
console.log(`Built Client half: ${target}`);
