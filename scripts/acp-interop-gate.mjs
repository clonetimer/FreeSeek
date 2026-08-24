#!/usr/bin/env node
/** Enforce the M4 RC independent ACP-client evidence gate. */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const files = [];
let minClients = 2;
let expectedVersion = "";
let expectedCommit = "";
const argv = process.argv.slice(2);
for (let index = 0; index < argv.length; index++) {
  const arg = argv[index];
  if (arg === "--min-clients") {
    const value = argv[++index];
    if (value === undefined || !Number.isInteger(Number(value)) || Number(value) < 1) {
      console.error("--min-clients requires a positive integer");
      process.exit(2);
    }
    minClients = Number(value);
  } else if (arg === "--expected-version") {
    expectedVersion = argv[++index] ?? "";
    if (!expectedVersion) { console.error("--expected-version requires a value"); process.exit(2); }
  } else if (arg === "--expected-commit") {
    expectedCommit = argv[++index] ?? "";
    if (!/^[a-f0-9]{40}$/i.test(expectedCommit)) { console.error("--expected-commit requires a full Git commit SHA"); process.exit(2); }
  } else if (arg.startsWith("--")) {
    console.error(`Unknown option: ${arg}`);
    process.exit(2);
  } else {
    files.push(arg);
  }
}
if (!files.length) {
  console.error("Usage: node scripts/acp-interop-gate.mjs <report.json>... [--min-clients 2]");
  process.exit(2);
}

const rows = [];
const errors = [];
for (const file of files) {
  let report;
  try { report = JSON.parse(readFileSync(resolve(file), "utf8")); }
  catch (error) { errors.push(`${file}: invalid JSON (${error.message})`); continue; }
  const e = report?.evidence;
  const key = e?.implementationOwner && e?.implementationId
    ? `${e.implementationOwner}/${e.implementationId}`
    : "";
  const baseline = report?.accepted === true
    && e?.freesekAcpInterop === 1
    && e?.initialize === true
    && e?.newSession === true
    && e?.prompt === true
    && e?.sessionUpdate === true
    && typeof e?.clientVersion === "string" && e.clientVersion.length > 0
    && key.length > 1;
  if (!baseline) {
    errors.push(`${file}: missing accepted baseline evidence`);
    continue;
  }
  if (expectedVersion && report?.freesekVersion !== expectedVersion) {
    errors.push(`${file}: FreeSeek version ${report?.freesekVersion ?? "<missing>"} does not match candidate ${expectedVersion}`);
    continue;
  }
  if (expectedCommit && String(report?.gitCommit ?? "").toLowerCase() !== expectedCommit.toLowerCase()) {
    errors.push(`${file}: FreeSeek commit ${report?.gitCommit ?? "<missing>"} does not match candidate ${expectedCommit}`);
    continue;
  }
  rows.push({ file, key, advanced: Array.isArray(e.advancedCapabilities) ? e.advancedCapabilities : [] });
}

const unique = new Map(rows.map((row) => [row.key, row]));
if (unique.size < minClients) errors.push(`independent client implementations: ${unique.size}/${minClients}`);
if (![...unique.values()].some((row) => row.advanced.length > 0)) {
  errors.push("no independent client exercised a non-baseline capability");
}

const summary = {
  schemaVersion: 1,
  kind: "freesek-acp-interop-gate",
  requiredClients: minClients,
  expectedVersion: expectedVersion || null,
  expectedCommit: expectedCommit || null,
  acceptedClients: [...unique.values()],
  passed: errors.length === 0,
  errors,
};
process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
if (errors.length) process.exitCode = 1;
