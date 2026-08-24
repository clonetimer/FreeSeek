import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const ROOT = process.cwd();
const GATE = join(ROOT, "scripts", "acp-interop-gate.mjs");

function report(owner: string, id: string, advanced: string[] = [], patch: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    kind: "freesek-acp-external-interop",
    accepted: true,
    evidence: {
      freesekAcpInterop: 1,
      implementationOwner: owner,
      implementationId: id,
      clientVersion: "1.0.0",
      initialize: true,
      newSession: true,
      prompt: true,
      sessionUpdate: true,
      advancedCapabilities: advanced,
      ...patch,
    },
  };
}

function runGate(rows: unknown[], extraArgs: string[] = []) {
  const dir = mkdtempSync(join(tmpdir(), "freesek-acp-gate-test-"));
  try {
    const files = rows.map((row, index) => {
      const path = join(dir, `${index}.json`);
      writeFileSync(path, JSON.stringify(row), "utf8");
      return path;
    });
    return spawnSync(process.execPath, [GATE, ...files, ...extraArgs], { cwd: ROOT, encoding: "utf8" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("ACP interop gate accepts two independent clients with advanced evidence", () => {
  const result = runGate([
    report("agentclientprotocol", "typescript-sdk", ["resume"]),
    report("openclaw", "acpx"),
  ]);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const summary = JSON.parse(result.stdout);
  assert.equal(summary.passed, true);
  assert.equal(summary.acceptedClients.length, 2);
});


test("ACP interop gate consumes --min-clients value instead of treating it as a report path", () => {
  const result = runGate([
    report("agentclientprotocol", "typescript-sdk", ["resume"]),
    report("openclaw", "acpx"),
  ], ["--min-clients", "2"]);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const summary = JSON.parse(result.stdout);
  assert.equal(summary.passed, true);
  assert.equal(summary.requiredClients, 2);
  assert.equal(summary.acceptedClients.length, 2);
});

test("ACP interop gate can bind external reports to the exact FreeSeek candidate", () => {
  const commit = "1".repeat(40);
  const rows = [
    { ...report("agentclientprotocol", "typescript-sdk", ["resume"]), freesekVersion: "0.20.0-rc.1", gitCommit: commit },
    { ...report("openclaw", "acpx"), freesekVersion: "0.20.0-rc.1", gitCommit: commit },
  ];
  const accepted = runGate(rows, ["--expected-version", "0.20.0-rc.1", "--expected-commit", commit]);
  assert.equal(accepted.status, 0, accepted.stderr || accepted.stdout);
  const wrong = runGate([{ ...rows[0], gitCommit: "2".repeat(40) }, rows[1]], ["--expected-version", "0.20.0-rc.1", "--expected-commit", commit]);
  assert.equal(wrong.status, 1);
  assert.match(wrong.stdout, /does not match candidate/);
});

test("ACP interop gate rejects duplicate implementations", () => {
  const result = runGate([
    report("openclaw", "acpx", ["resume"]),
    report("openclaw", "acpx"),
  ]);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /independent client implementations: 1\/2/);
});

test("ACP interop gate rejects evidence without session updates", () => {
  const result = runGate([
    report("agentclientprotocol", "typescript-sdk", ["resume"], { sessionUpdate: false }),
    report("openclaw", "acpx"),
  ]);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /missing accepted baseline evidence/);
});
