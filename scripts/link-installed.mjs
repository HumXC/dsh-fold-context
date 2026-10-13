import { createRequire } from 'node:module';
import { readFileSync, existsSync, mkdirSync, realpathSync, symlinkSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';

// Bootstrap only THIS package for offline verification. Never edit the installed Harness.
// Normal development uses pnpm install. This utility cannot activate plugins or access sessions.
const harnessRoot = process.argv[2];
if (!harnessRoot) throw new Error('Usage: node scripts/link-installed.mjs /absolute/path/to/installed/dsh');
const packageRoot = resolve(import.meta.dirname, '..');
const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'));
const fromHarness = createRequire(join(resolve(harnessRoot), 'package.json'));
const fromWorkspace = createRequire(join(packageRoot, '../../package.json'));
for (const name of Object.keys({ ...manifest.peerDependencies, ...manifest.dependencies, ...manifest.devDependencies })) {
  let entry;
  const resolveEntry = (resolver) => {
    try { return resolver.resolve(`${name}/package.json`); } catch { return resolver.resolve(name); }
  };
  try { entry = resolveEntry(fromHarness); } catch { entry = resolveEntry(fromWorkspace); }
  let directory = dirname(realpathSync(entry));
  while (directory !== dirname(directory)) {
    const path = join(directory, 'package.json');
    if (existsSync(path) && JSON.parse(readFileSync(path, 'utf8')).name === name) break;
    directory = dirname(directory);
  }
  if (directory === dirname(directory)) throw new Error(`Cannot locate package root: ${name}`);
  const target = join(packageRoot, 'node_modules', name);
  if (existsSync(target)) {
    if (realpathSync(target) !== directory) throw new Error(`Refusing to replace existing dependency: ${name}`);
  } else {
    mkdirSync(dirname(target), { recursive: true });
    symlinkSync(directory, target, 'dir');
  }
}
console.log('Linked existing dependency packages for local offline verification; no profile changed.');
