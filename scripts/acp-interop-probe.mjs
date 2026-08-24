#!/usr/bin/env node
/** Report which independent ACP interoperability clients are executable locally. */
import { spawnSync } from "node:child_process";

function commandProbe(command, args = ["--version"]) {
  const result = spawnSync(command, args, { encoding: "utf8" });
  return {
    available: result.status === 0,
    version: result.status === 0 ? (result.stdout || result.stderr).trim().split(/\s+/).pop() : null,
    error: result.status === 0 ? null : (result.error?.code || result.stderr?.trim() || `exit ${result.status}`),
  };
}

let officialSdk;
try {
  const resolved = await import.meta.resolve("@agentclientprotocol/sdk");
  officialSdk = { available: true, resolved };
} catch (error) {
  officialSdk = { available: false, error: error?.code || error?.message || String(error) };
}

process.stdout.write(JSON.stringify({
  schemaVersion: 1,
  officialTypescriptSdk: officialSdk,
  acpx: commandProbe(process.env.FREESEEK_ACPX_BIN || "acpx"),
  zed: commandProbe("zed", ["--version"]),
  note: "Only actually executed external clients count toward the RC gate.",
}, null, 2) + "\n");
