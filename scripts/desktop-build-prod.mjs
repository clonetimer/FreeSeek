#!/usr/bin/env node
/** Build the production Desktop payload and the bundled ACP sidecar. */
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function run(script, args = []) {
  const result = spawnSync(process.execPath, [resolve(ROOT, script), ...args], {
    cwd: ROOT,
    stdio: 'inherit',
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

run('esbuild.js', ['--production', '--build-target=acp']);
run('scripts/desktop-build.mjs');

for (const file of [
  'dist/freeseek-acp.js',
  'apps/desktop/dist/apps/desktop/src/main.js',
  'apps/desktop/dist/apps/desktop/src/preload.js',
  'apps/desktop/dist/apps/desktop/src/index.html',
]) {
  if (!existsSync(resolve(ROOT, file))) throw new Error(`Desktop production artifact missing: ${file}`);
}
console.log('desktop production build complete');
