/**
 * Plain-JS worker bootstrap passed through `node -e` inside the H4 chroot.
 * Keep this dependency-free: the worker must not import FreeSeek host modules.
 */
export const SANDBOX_WORKER_BOOTSTRAP = String.raw`
"use strict";
const MAX_TOOLS = 64;
const MAX_RESULT = 256 * 1024;
const MAX_BROKER_PAYLOAD = 256 * 1024;
const rawOut = process.stdout.write.bind(process.stdout);
const rawErr = process.stderr.write.bind(process.stderr);
const protocol = (row) => rawOut(JSON.stringify(row) + "\n");
const diagnostic = (...args) => rawErr(args.map((v) => typeof v === "string" ? v : JSON.stringify(v)).join(" ").slice(0, 4096) + "\n");
console.log = diagnostic; console.info = diagnostic; console.warn = diagnostic; console.error = diagnostic;
const argv = process.argv.slice(1);
const entryPath = String(argv[0] || "");
const manifest = JSON.parse(Buffer.from(String(argv[1] || ""), "base64url").toString("utf8"));
const generation = Number(argv[2]);
const grant = JSON.parse(Buffer.from(String(argv[3] || ""), "base64url").toString("utf8"));
if (!entryPath.startsWith("/package/")) throw new Error("sandbox entry path invalid");
process.chdir("/package");
const tools = new Map();
const effects = [];
const calls = new Map();
const brokers = new Map();
let brokerSeq = 0;
let disposed = false;
const localName = (value) => {
  const name = String(value || "").trim();
  if (!/^[A-Za-z][A-Za-z0-9_-]{0,31}$/.test(name)) throw new Error("sandbox tool name invalid: " + name);
  return name;
};
const publicName = (local) => "ext__" + String(manifest.id).replace(/[.-]/g, "_") + "__" + local;
const broker = (callId, op, payload, signal) => new Promise((resolve, reject) => {
  const brokerId = "b-" + (++brokerSeq).toString(36);
  const encoded = JSON.stringify(payload == null ? null : payload);
  if (Buffer.byteLength(encoded) > MAX_BROKER_PAYLOAD) return reject(new Error("sandbox broker payload too large"));
  brokers.set(brokerId, { resolve, reject });
  protocol({ v: 1, type: "broker", brokerId, callId, op, payload });
  if (signal) {
    const abort = () => { if (brokers.delete(brokerId)) reject(new Error("sandbox broker cancelled")); };
    if (signal.aborted) abort(); else signal.addEventListener("abort", abort, { once: true });
  }
});
const activationContext = Object.freeze({
  manifest: Object.freeze(manifest),
  generation,
  sandbox: Object.freeze({
    platform: "linux",
    packageRoot: "/package",
    filesystem: Object.freeze({ readRoots: Object.freeze(grant.readRoots || []), writeRoots: Object.freeze(grant.writeRoots || []) }),
    network: Object.freeze({ allowedOrigins: Object.freeze(grant.allowedOrigins || []) }),
    shell: false,
  }),
  effect(disposer) {
    if (typeof disposer !== "function") throw new Error("sandbox effect disposer must be function");
    effects.push(disposer);
  },
  registerTool(contribution) {
    if (tools.size >= MAX_TOOLS) throw new Error("sandbox tool count exceeds " + MAX_TOOLS);
    const name = localName(contribution && contribution.name);
    if (tools.has(name)) throw new Error("duplicate sandbox tool: " + name);
    if (!contribution || typeof contribution.execute !== "function") throw new Error("sandbox tool execute missing: " + name);
    tools.set(name, { execute: contribution.execute, descriptor: {
      name,
      description: String(contribution.description || ""),
      parameters: contribution.parameters && typeof contribution.parameters === "object" ? contribution.parameters : {},
      runtime: contribution.runtime,
    }});
    return publicName(name);
  },
  registerConnector() { throw new Error("H4 sandbox v1 rejects executable connector contributions"); },
  registerSkill() { throw new Error("H4 sandbox v1 rejects executable skill contributions"); },
  registerPolicy() { throw new Error("H4 sandbox v1 rejects executable policy contributions"); },
  registerHook() { throw new Error("H4 sandbox v1 rejects executable hook contributions"); },
  registerMcp() { throw new Error("H4 sandbox v1 rejects executable MCP contributions"); },
});
async function activate() {
  const exported = require(entryPath);
  const candidate = exported && exported.default ? exported.default : exported;
  const fn = typeof candidate === "function" ? candidate : candidate && typeof candidate.activate === "function" ? candidate.activate.bind(candidate) : undefined;
  if (!fn) throw new Error("sandbox entry must export activate(context) or function");
  const disposer = await fn(activationContext);
  if (typeof disposer === "function") effects.push(disposer);
  protocol({ v: 1, type: "ready", extensionId: manifest.id, version: manifest.version, generation, tools: [...tools.values()].map((row) => row.descriptor) });
}
async function disposeAndExit() {
  if (disposed) return;
  disposed = true;
  for (const ctrl of calls.values()) ctrl.abort();
  for (let i = effects.length - 1; i >= 0; i--) { try { await effects[i](); } catch (error) { diagnostic("dispose error", error && error.message || error); } }
  protocol({ v: 1, type: "disposed" });
  setImmediate(() => process.exit(0));
}
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
  if (Buffer.byteLength(input) > 512 * 1024) { diagnostic("protocol input overflow"); process.exit(72); return; }
  let index;
  while ((index = input.indexOf("\n")) >= 0) {
    const line = input.slice(0, index); input = input.slice(index + 1);
    if (!line.trim()) continue;
    let msg; try { msg = JSON.parse(line); } catch { process.exit(73); return; }
    if (!msg || msg.v !== 1 || typeof msg.type !== "string") { process.exit(74); return; }
    if (msg.type === "call") {
      const callId = String(msg.callId || ""); const tool = tools.get(String(msg.tool || ""));
      if (!callId || !tool) { protocol({ v: 1, type: "result", callId, ok: false, error: "unknown sandbox tool" }); continue; }
      const ctrl = new AbortController(); calls.set(callId, ctrl);
      const runtimeCtx = Object.freeze({
        signal: ctrl.signal,
        generation,
        extensionId: manifest.id,
        sandbox: activationContext.sandbox,
        fs: Object.freeze({
          readText: (target) => broker(callId, "fs.readText", { path: String(target) }, ctrl.signal),
          writeText: (target, text) => broker(callId, "fs.writeText", { path: String(target), text: String(text) }, ctrl.signal),
        }),
        net: Object.freeze({
          fetchText: (url, options) => broker(callId, "net.fetchText", { url: String(url), options: options || {} }, ctrl.signal),
        }),
      });
      Promise.resolve().then(() => tool.execute(msg.args, runtimeCtx)).then((value) => {
        if (!calls.delete(callId)) return;
        const result = String(value == null ? "" : value);
        if (Buffer.byteLength(result) > MAX_RESULT) protocol({ v: 1, type: "result", callId, ok: false, error: "sandbox result exceeds 256KiB" });
        else protocol({ v: 1, type: "result", callId, ok: true, result });
      }, (error) => {
        if (!calls.delete(callId)) return;
        protocol({ v: 1, type: "result", callId, ok: false, error: String(error && error.message || error).slice(0, 8192) });
      });
      continue;
    }
    if (msg.type === "cancel") { calls.get(String(msg.callId || ""))?.abort(); continue; }
    if (msg.type === "brokerResult") {
      const row = brokers.get(String(msg.brokerId || "")); if (!row) continue; brokers.delete(String(msg.brokerId));
      if (msg.ok) row.resolve(msg.value); else row.reject(new Error(String(msg.error || "sandbox broker failed")));
      continue;
    }
    if (msg.type === "dispose") { void disposeAndExit(); continue; }
    process.exit(75); return;
  }
});
process.stdin.on("end", () => { void disposeAndExit(); });
activate().catch((error) => { protocol({ v: 1, type: "activationError", error: String(error && error.stack || error).slice(0, 16384) }); setImmediate(() => process.exit(70)); });
`;
