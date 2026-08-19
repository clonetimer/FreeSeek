import assert from 'node:assert/strict';
import path from 'node:path';
import {createRequire} from 'node:module';

const workspace = process.argv[2];
assert.ok(workspace, 'workspace argument missing');
const require = createRequire(import.meta.url);
const escapeStringRegexp = require(path.join(workspace, 'index.js'));
const escaped = escapeStringRegexp('foo - bar');
assert.doesNotMatch(escaped, /\\-/u, 'hyphen must not use a plain backslash escape');
assert.equal(new RegExp(escapeStringRegexp('-'), 'u').test('-'), true);
assert.equal(new RegExp(`^${escapeStringRegexp('a-b.c')}$`, 'u').test('a-b.c'), true);
assert.equal(escapeStringRegexp('a.b'), 'a\\.b');
console.log('ok');
