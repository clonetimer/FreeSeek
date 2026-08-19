/** Private holdout pack scaffolding. Generated packs live outside the repository by default. */
import * as fs from "fs";
import * as path from "path";

const MANIFEST = {
  version: 2,
  name: "private-holdout",
  visibility: "private",
  description: "Private FreeSeek holdout. Keep this directory outside public source control.",
  cases: [{
    id: "holdout-001",
    source: { kind: "local", path: "./fixtures/holdout-001" },
    prompt: "Replace this prompt with a private coding task.",
    category: "core",
    difficulty: "medium",
    tags: ["holdout"],
    weight: 1,
    allowShell: true,
    allowNetwork: false,
    checks: [{ type: "host_node", script: "./verifiers/holdout-001.mjs" }],
  }],
};

const VERIFIER = `import assert from 'node:assert/strict';\nimport fs from 'node:fs';\nimport path from 'node:path';\n\nconst workspace = process.argv[2];\nassert.ok(workspace, 'workspace argument missing');\n// Replace this sample assertion with a private post-condition.\nassert.equal(fs.existsSync(path.join(workspace, 'result.txt')), true);\nconsole.log('ok');\n`;

/** Create a private holdout pack template without overwriting an existing directory. */
export function initPrivateHoldoutPack(target: string): string {
  const absolute = path.resolve(target);
  if (fs.existsSync(absolute) && fs.readdirSync(absolute).length) throw new Error(`holdout 目录非空，拒绝覆盖：${absolute}`);
  fs.mkdirSync(path.join(absolute, "fixtures", "holdout-001"), { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.join(absolute, "gold", "holdout-001"), { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.join(absolute, "verifiers"), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(absolute, "manifest.json"), JSON.stringify(MANIFEST, null, 2) + "\n", { mode: 0o600 });
  fs.writeFileSync(path.join(absolute, "fixtures", "holdout-001", "README.md"), "# Private holdout fixture\n\nPlace the pristine task workspace here.\n", { mode: 0o600 });
  fs.writeFileSync(path.join(absolute, "gold", "holdout-001", "result.txt"), "sample-gold\n", { mode: 0o600 });
  fs.writeFileSync(path.join(absolute, "verifiers", "holdout-001.mjs"), VERIFIER, { mode: 0o600 });
  fs.writeFileSync(path.join(absolute, ".gitignore"), "*\n!.gitignore\n", { mode: 0o600 });
  return absolute;
}
