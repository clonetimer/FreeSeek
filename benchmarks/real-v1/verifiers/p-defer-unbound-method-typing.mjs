import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const workspace = process.argv[2];
assert.ok(workspace, 'workspace argument missing');
const declaration = fs.readFileSync(path.join(workspace, 'index.d.ts'), 'utf8');
assert.match(declaration, /resolve\(this:\s*void,\s*value\?/);
assert.match(declaration, /reject\(this:\s*void,\s*reason\?/);
console.log('ok');
