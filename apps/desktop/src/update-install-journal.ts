import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { compareDesktopSemver } from "./update-verifier";

export type DesktopUpdateInstallPhase =
  | "staged"
  | "installing"
  | "awaiting-health"
  | "confirmed"
  | "rollback-required"
  | "rolled-back";

export interface DesktopUpdateInstallAttempt {
  schemaVersion: 1;
  attemptId: string;
  fromVersion: string;
  toVersion: string;
  target: string;
  manifestSha256: string;
  provenanceSha256: string;
  artifactSha256: string;
  phase: DesktopUpdateInstallPhase;
  createdAt: string;
  updatedAt: string;
  healthDeadline?: string;
  reason?: string;
}

export type DesktopUpdateInstallAction =
  | { type: "begin-install" }
  | { type: "await-health"; timeoutMs?: number }
  | { type: "confirm" }
  | { type: "require-rollback"; reason: string }
  | { type: "mark-rolled-back" };

function requireDigest(value: string, label: string): void {
  if (!/^[a-f0-9]{64}$/i.test(value)) throw new Error(`${label} must be a SHA-256 hex digest`);
}
function requireInstant(value: string, label: string): number {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) throw new Error(`${label} must be a valid timestamp`);
  return time;
}
function validateAttempt(value: DesktopUpdateInstallAttempt): DesktopUpdateInstallAttempt {
  if (value?.schemaVersion !== 1 || !crypto.randomUUID || !/^[0-9a-f-]{36}$/i.test(value.attemptId)) throw new Error("Invalid Desktop update install journal schema");
  if (compareDesktopSemver(value.toVersion, value.fromVersion) <= 0) throw new Error("Desktop update install journal must describe an upgrade");
  if (!/^(linux|win32|darwin)\/(x64|arm64)$/.test(value.target)) throw new Error("Invalid Desktop update install target");
  requireDigest(value.manifestSha256, "manifestSha256");
  requireDigest(value.provenanceSha256, "provenanceSha256");
  requireDigest(value.artifactSha256, "artifactSha256");
  const createdAt = requireInstant(value.createdAt, "createdAt");
  const updatedAt = requireInstant(value.updatedAt, "updatedAt");
  if (updatedAt < createdAt) throw new Error("Desktop update install journal updatedAt predates createdAt");
  if (!["staged", "installing", "awaiting-health", "confirmed", "rollback-required", "rolled-back"].includes(value.phase)) throw new Error("Invalid Desktop update install phase");
  if (value.phase === "awaiting-health") {
    if (!value.healthDeadline || requireInstant(value.healthDeadline, "healthDeadline") <= updatedAt) throw new Error("awaiting-health requires a future healthDeadline");
  } else if (value.healthDeadline !== undefined) {
    throw new Error("healthDeadline is only valid while awaiting-health");
  }
  if (value.reason !== undefined && !value.reason.trim()) throw new Error("Desktop update rollback reason must not be empty");
  return value;
}

/** Create a verified-artifact installation attempt without executing an installer. */
export function createDesktopUpdateInstallAttempt(input: {
  fromVersion: string;
  toVersion: string;
  platform: "linux" | "win32" | "darwin";
  arch: "x64" | "arm64";
  manifestSha256: string;
  provenanceSha256: string;
  artifactSha256: string;
  now?: Date;
  attemptId?: string;
}): DesktopUpdateInstallAttempt {
  if (compareDesktopSemver(input.toVersion, input.fromVersion) <= 0) throw new Error(`Refusing non-upgrade install attempt: ${input.fromVersion} -> ${input.toVersion}`);
  requireDigest(input.manifestSha256, "manifestSha256"); requireDigest(input.provenanceSha256, "provenanceSha256"); requireDigest(input.artifactSha256, "artifactSha256");
  const now = (input.now ?? new Date()).toISOString();
  return validateAttempt({
    schemaVersion: 1,
    attemptId: input.attemptId ?? crypto.randomUUID(),
    fromVersion: input.fromVersion,
    toVersion: input.toVersion,
    target: `${input.platform}/${input.arch}`,
    manifestSha256: input.manifestSha256,
    provenanceSha256: input.provenanceSha256,
    artifactSha256: input.artifactSha256,
    phase: "staged",
    createdAt: now,
    updatedAt: now,
  });
}

/** Apply a guarded update lifecycle transition; terminal states cannot be reopened. */
export function transitionDesktopUpdateInstallAttempt(
  current: DesktopUpdateInstallAttempt,
  action: DesktopUpdateInstallAction,
  now = new Date(),
): DesktopUpdateInstallAttempt {
  const state = validateAttempt({ ...current });
  const updatedAt = now.toISOString();
  if (Date.parse(updatedAt) < Date.parse(state.updatedAt)) throw new Error("Desktop update install transition time moved backwards");
  if (action.type === "begin-install") {
    if (state.phase !== "staged") throw new Error(`begin-install is invalid from ${state.phase}`);
    return validateAttempt({ ...state, phase: "installing", updatedAt });
  }
  if (action.type === "await-health") {
    if (state.phase !== "installing") throw new Error(`await-health is invalid from ${state.phase}`);
    const timeoutMs = action.timeoutMs ?? 120_000;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 5_000 || timeoutMs > 15 * 60_000) throw new Error("health timeout must be between 5 seconds and 15 minutes");
    return validateAttempt({ ...state, phase: "awaiting-health", updatedAt, healthDeadline: new Date(now.getTime() + timeoutMs).toISOString() });
  }
  if (action.type === "confirm") {
    if (state.phase !== "awaiting-health") throw new Error(`confirm is invalid from ${state.phase}`);
    if (now.getTime() >= requireInstant(state.healthDeadline!, "healthDeadline")) throw new Error("Desktop update health confirmation deadline expired");
    const { healthDeadline: _deadline, reason: _reason, ...rest } = state;
    return validateAttempt({ ...rest, phase: "confirmed", updatedAt });
  }
  if (action.type === "require-rollback") {
    if (!action.reason.trim()) throw new Error("rollback reason must not be empty");
    if (state.phase !== "installing" && state.phase !== "awaiting-health") throw new Error(`require-rollback is invalid from ${state.phase}`);
    const { healthDeadline: _deadline, ...rest } = state;
    return validateAttempt({ ...rest, phase: "rollback-required", reason: action.reason.trim(), updatedAt });
  }
  if (state.phase !== "rollback-required") throw new Error(`mark-rolled-back is invalid from ${state.phase}`);
  const { reason: _reason, ...rest } = state;
  return validateAttempt({ ...rest, phase: "rolled-back", updatedAt });
}

/** Convert interrupted/expired non-terminal attempts into an explicit rollback-required state. */
export function recoverDesktopUpdateInstallAttempt(current: DesktopUpdateInstallAttempt, now = new Date()): DesktopUpdateInstallAttempt {
  const state = validateAttempt({ ...current });
  if (state.phase === "installing") return transitionDesktopUpdateInstallAttempt(state, { type: "require-rollback", reason: "installer interrupted before health checkpoint" }, now);
  if (state.phase === "awaiting-health" && now.getTime() >= requireInstant(state.healthDeadline!, "healthDeadline")) {
    return transitionDesktopUpdateInstallAttempt(state, { type: "require-rollback", reason: "post-update health confirmation deadline expired" }, now);
  }
  return state;
}

/** Atomic on-disk journal for installer/rollback orchestration owned by the Desktop main process. */
export class DesktopUpdateInstallJournalStore {
  constructor(private readonly file: string) {}
  read(): DesktopUpdateInstallAttempt | null {
    try { return validateAttempt(JSON.parse(fs.readFileSync(this.file, "utf8")) as DesktopUpdateInstallAttempt); }
    catch (error: any) {
      if (error?.code === "ENOENT") return null;
      throw new Error(`Invalid Desktop update install journal: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  write(value: DesktopUpdateInstallAttempt): void {
    const state = validateAttempt({ ...value });
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const temp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(state, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
    fs.renameSync(temp, this.file);
  }
  clear(): void { try { fs.unlinkSync(this.file); } catch (error: any) { if (error?.code !== "ENOENT") throw error; } }
}
