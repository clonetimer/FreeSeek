import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import {
  createDesktopUpdateInstallAttempt,
  DesktopUpdateInstallJournalStore,
  recoverDesktopUpdateInstallAttempt,
  transitionDesktopUpdateInstallAttempt,
} from "../apps/desktop/src/update-install-journal";

const DIGESTS = { manifestSha256: "a".repeat(64), provenanceSha256: "b".repeat(64), artifactSha256: "c".repeat(64) };
function create(now = new Date("2026-08-20T12:00:00Z")) {
  return createDesktopUpdateInstallAttempt({ fromVersion: "0.20.0-rc.1", toVersion: "0.20.0-rc.2", platform: "linux", arch: "x64", ...DIGESTS, now, attemptId: "11111111-1111-4111-8111-111111111111" });
}

test("Desktop update install lifecycle requires staged -> installing -> health -> confirmed", () => {
  const staged = create();
  assert.equal(staged.phase, "staged");
  const installing = transitionDesktopUpdateInstallAttempt(staged, { type: "begin-install" }, new Date("2026-08-20T12:00:01Z"));
  const awaiting = transitionDesktopUpdateInstallAttempt(installing, { type: "await-health", timeoutMs: 30_000 }, new Date("2026-08-20T12:00:02Z"));
  assert.equal(awaiting.phase, "awaiting-health");
  assert.equal(awaiting.healthDeadline, "2026-08-20T12:00:32.000Z");
  const confirmed = transitionDesktopUpdateInstallAttempt(awaiting, { type: "confirm" }, new Date("2026-08-20T12:00:10Z"));
  assert.equal(confirmed.phase, "confirmed");
  assert.equal(confirmed.healthDeadline, undefined);
  assert.throws(() => transitionDesktopUpdateInstallAttempt(confirmed, { type: "begin-install" }), /invalid from confirmed/);
});

test("Desktop update install recovery turns interrupted or unhealthy attempts into rollback-required", () => {
  const installing = transitionDesktopUpdateInstallAttempt(create(), { type: "begin-install" }, new Date("2026-08-20T12:00:01Z"));
  const interrupted = recoverDesktopUpdateInstallAttempt(installing, new Date("2026-08-20T12:00:05Z"));
  assert.equal(interrupted.phase, "rollback-required"); assert.match(interrupted.reason ?? "", /interrupted/);
  const rolledBack = transitionDesktopUpdateInstallAttempt(interrupted, { type: "mark-rolled-back" }, new Date("2026-08-20T12:00:06Z"));
  assert.equal(rolledBack.phase, "rolled-back");

  const awaiting = transitionDesktopUpdateInstallAttempt(installing, { type: "await-health", timeoutMs: 5_000 }, new Date("2026-08-20T12:00:02Z"));
  assert.equal(recoverDesktopUpdateInstallAttempt(awaiting, new Date("2026-08-20T12:00:06Z")).phase, "awaiting-health");
  const expired = recoverDesktopUpdateInstallAttempt(awaiting, new Date("2026-08-20T12:00:07Z"));
  assert.equal(expired.phase, "rollback-required"); assert.match(expired.reason ?? "", /deadline expired/);
  assert.throws(() => transitionDesktopUpdateInstallAttempt(awaiting, { type: "confirm" }, new Date("2026-08-20T12:00:07Z")), /deadline expired/);
});

test("Desktop update install journal rejects downgrade, illegal transitions and corrupt state", () => {
  assert.throws(() => createDesktopUpdateInstallAttempt({ fromVersion: "0.20.0-rc.2", toVersion: "0.20.0-rc.1", platform: "linux", arch: "x64", ...DIGESTS }), /Refusing non-upgrade/);
  assert.throws(() => transitionDesktopUpdateInstallAttempt(create(), { type: "confirm" }), /invalid from staged/);
  assert.throws(() => transitionDesktopUpdateInstallAttempt(create(), { type: "require-rollback", reason: "" }), /reason/);

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "freeseek-update-journal-"));
  try {
    const file = path.join(root, "install-journal.json");
    const store = new DesktopUpdateInstallJournalStore(file);
    assert.equal(store.read(), null);
    store.write(create());
    assert.deepEqual(store.read(), create());
    if (process.platform !== "win32") assert.equal(fs.statSync(file).mode & 0o077, 0);
    fs.writeFileSync(file, "{bad-json", "utf8");
    assert.throws(() => store.read(), /Invalid Desktop update install journal/);
    store.clear(); store.clear(); assert.equal(store.read(), null);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
