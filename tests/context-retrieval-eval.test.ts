import { test } from "node:test";
import assert from "node:assert/strict";
import {
  builtInContextRetrievalManifestPath,
  loadContextRetrievalManifest,
  runContextRetrievalExperiment,
} from "../src/context-retrieval-eval";

test("Context retrieval 实验固定复现 v1 ranking miss，并验证 v1.1 提升 Hit@1/MRR", () => {
  const manifest = loadContextRetrievalManifest(builtInContextRetrievalManifestPath());
  assert.equal(manifest.probes.length, 8);
  const report = runContextRetrievalExperiment(builtInContextRetrievalManifestPath(), ["v1", "v1.1"], 1500);
  const v1 = report.variants.find((row) => row.variant === "v1");
  const v11 = report.variants.find((row) => row.variant === "v1.1");
  assert.ok(v1 && v11);
  assert.equal(v1.hitAt3, 1);
  assert.equal(v11.hitAt3, 1);
  assert.ok(v11.hitAt1 > v1.hitAt1, `v1=${v1.hitAt1}, v1.1=${v11.hitAt1}`);
  assert.ok(v11.meanReciprocalRank > v1.meanReciprocalRank);
  const hiddenV1 = v1.results.filter((row) => row.tags.includes("path-hidden"));
  const hiddenV11 = v11.results.filter((row) => row.tags.includes("path-hidden"));
  assert.equal(hiddenV1.filter((row) => row.hitAt1).length, 0);
  assert.equal(hiddenV11.filter((row) => row.hitAt1).length, 4);
  assert.equal(hiddenV1.filter((row) => row.diagnosis === "ranking_miss").length, 4);
  assert.equal(hiddenV11.filter((row) => row.diagnosis === "hit").length, 4);
});

test("Context retrieval manifest 拒绝 workspace 越过 manifest 目录", () => {
  const fs = require("node:fs") as typeof import("node:fs");
  const os = require("node:os") as typeof import("node:os");
  const path = require("node:path") as typeof import("node:path");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "freesek-context-retrieval-safe-"));
  const suiteDir = path.join(root, "suite");
  const outside = path.join(root, "outside");
  fs.mkdirSync(suiteDir, { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(outside, "target.ts"), "export const x = 1;\n");
  const manifestPath = path.join(suiteDir, "manifest.json");
  fs.writeFileSync(manifestPath, JSON.stringify({
    version: 1,
    name: "unsafe",
    probes: [{ id: "escape", workspace: "../outside", query: "x", targets: ["target.ts"] }],
  }));
  try {
    assert.throws(() => loadContextRetrievalManifest(manifestPath), /越界/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
