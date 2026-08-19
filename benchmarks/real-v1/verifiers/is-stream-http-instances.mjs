import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

const workspace = process.argv[2];
assert.ok(workspace, 'workspace argument missing');
const api = await import(`${pathToFileURL(path.join(workspace, 'index.js')).href}?verify=${Date.now()}`);
const outgoing = new http.OutgoingMessage();
const incoming = new http.IncomingMessage(new net.Socket());
const response = new http.ServerResponse({method: 'GET'});
try {
  assert.equal(api.isStream(outgoing), true);
  assert.equal(api.isWritableStream(outgoing), true);
  assert.equal(api.isReadableStream(outgoing), false);
  assert.equal(api.isStream(incoming), true);
  assert.equal(api.isReadableStream(incoming), true);
  assert.equal(api.isWritableStream(incoming), false);
  assert.equal(api.isWritableStream(response), true);
  assert.equal(api.isDuplexStream(response), false);
  assert.equal(api.isReadableStream({pipe() {}, readable: true}), false, 'lookalikes without documented stream methods must be rejected');
} finally {
  outgoing.destroy();
  incoming.destroy();
  response.destroy();
}
console.log('ok');
