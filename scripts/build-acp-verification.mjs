#!/usr/bin/env node
/** Build an ACP executable for conformance/interop checks, with a tsc fallback. */
import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const VERIFY_ROOT = join(ROOT, ".freesek", "acp-verification");
const MARKER = join(VERIFY_ROOT, "build.json");

function run(command, args, options = {}) {
  return spawnSync(command, args, { cwd: ROOT, stdio: "inherit", ...options });
}

function canUseNativeEsbuild() {
  const explicit = process.env.FREESEEK_ESBUILD_BIN || process.env.ESBUILD_BINARY_PATH;
  if (explicit && existsSync(explicit)) return true;
  const platformPackage = process.platform === "linux"
    ? `@esbuild/linux-${process.arch === "x64" ? "x64" : process.arch}`
    : process.platform === "win32"
      ? `@esbuild/win32-${process.arch === "x64" ? "x64" : process.arch}`
      : process.platform === "darwin"
        ? `@esbuild/darwin-${process.arch === "arm64" ? "arm64" : "x64"}`
        : "";
  return !!platformPackage
    && existsSync(join(ROOT, "node_modules", "esbuild", "package.json"))
    && existsSync(join(ROOT, "node_modules", ...platformPackage.split("/"), "package.json"));
}

function writeVscodeStub() {
  const dir = join(VERIFY_ROOT, "node_modules", "vscode");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "index.js"), `
const noop=()=>{};
const cfgGet=(_key,def)=>def;
const configuration=new Proxy({get:cfgGet,update:async()=>{}},{get:(t,k)=>k in t?t[k]:()=>{}});
module.exports={
  workspace:new Proxy({getConfiguration:()=>configuration,workspaceFolders:[]},{get:(t,k)=>k in t?t[k]:noop}),
  window:new Proxy({},{get:()=>()=>({dispose:noop})}),
  commands:new Proxy({},{get:()=>()=>({dispose:noop})}),
  Uri:{file:p=>({fsPath:p,scheme:'file',path:p}),parse:s=>({fsPath:s,scheme:'file',path:s})},
  EventEmitter:class{constructor(){this.event=()=>({dispose:noop});this.fire=noop;this.dispose=noop;}},
  ThemeIcon:class{},
  workspaceFolders:[],
  ConfigurationTarget:{Global:1,Workspace:2,WorkspaceFolder:3},
  ProgressLocation:{Notification:1},
  ViewColumn:{Active:1,Beside:2},
  StatusBarAlignment:{Left:1,Right:2},
};
`, "utf8");
}

rmSync(VERIFY_ROOT, { recursive: true, force: true });
mkdirSync(VERIFY_ROOT, { recursive: true });

let agentBin;
let kind;
if (canUseNativeEsbuild()) {
  const result = run(process.execPath, [join(ROOT, "esbuild.js"), "--production", "--build-target=acp"]);
  if (result.status === 0) {
    agentBin = join(ROOT, "dist", "freeseek-acp.js");
    kind = "esbuild-production-bundle";
  }
}

if (!agentBin) {
  const tsc = join(ROOT, "node_modules", "typescript", "bin", "tsc");
  const result = run(process.execPath, [
    tsc,
    "-p", "tsconfig.check.json",
    "--noEmit", "false",
    "--outDir", VERIFY_ROOT,
    "--rootDir", ROOT,
    "--sourceMap", "false",
  ]);
  if (result.status !== 0) process.exit(result.status ?? 1);
  copyFileSync(join(ROOT, "package.json"), join(VERIFY_ROOT, "package.json"));
  writeVscodeStub();
  const entry = join(VERIFY_ROOT, "freeseek-acp-verification.cjs");
  writeFileSync(entry, `#!/usr/bin/env node
const { runAcpCli } = require("./src/acp-server.js");
void runAcpCli(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (error) => { console.error(error); process.exitCode = 1; });
`, "utf8");
  agentBin = entry;
  kind = "tsc-verification-build";
}

writeFileSync(MARKER, JSON.stringify({ schemaVersion: 1, kind, agentBin }, null, 2) + "\n", "utf8");
console.log(`[acp-verification] ${kind}: ${agentBin}`);
