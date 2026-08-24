/**
 * FreeSeek 安全检查点：使用独立 shadow Git 仓库保存工作区快照，绝不触碰用户仓库的
 * branch/index/stash。这样自动 checkpoint 只“记录”当前状态，不会把工作树改动 stash 掉。
 */
import * as crypto from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execFileSync } from "child_process";

export interface CheckpointEntry {
  hash: string;
  createdAt: number;
  label: string;
  sessionId?: string;
  eventSeq?: number;
  actor?: string;
  kind?: "auto" | "manual";
}

export interface CheckpointEventLink {
  hash: string;
  sessionId: string;
  eventSeq: number;
  actor?: string;
  kind?: "auto" | "manual";
}

function baseDir(root: string, storageBase?: string): string {
  const real = (() => {
    try { return fs.realpathSync(root); } catch { return path.resolve(root); }
  })();
  const id = crypto.createHash("sha1").update(real).digest("hex").slice(0, 16);
  return path.join(storageBase || path.join(os.homedir(), ".freesek", "checkpoints"), id);
}

function gitEnv(root: string, storageBase?: string): NodeJS.ProcessEnv {
  const dir = path.join(baseDir(root, storageBase), "shadow-git");
  return { ...process.env, GIT_DIR: dir, GIT_WORK_TREE: path.resolve(root) };
}

function runGit(root: string, args: string[], storageBase?: string): string {
  return execFileSync("git", args, {
    cwd: root,
    env: gitEnv(root, storageBase),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/** 初始化独立 shadow repo；不会创建/修改工作区的 .git。 */
export function ensureCheckpointStore(root: string, storageBase?: string): void {
  const env = gitEnv(root, storageBase);
  const dir = String(env.GIT_DIR);
  if (fs.existsSync(path.join(dir, "HEAD"))) return;
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  execFileSync("git", ["init", "--quiet"], { cwd: root, env, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "freesek@local"], { cwd: root, env, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "FreeSeek Checkpoint"], { cwd: root, env, stdio: "ignore" });
  // Shadow checkpoints must not inherit the user's global core.autocrlf policy. Otherwise a
  // byte-identical LF snapshot created on Windows can be materialized/rewound as CRLF, which
  // makes time-travel behavior depend on machine Git configuration rather than the snapshot.
  // Repository .gitattributes still applies when it explicitly declares an eol policy.
  execFileSync("git", ["config", "core.autocrlf", "false"], { cwd: root, env, stdio: "ignore" });
  const info = path.join(dir, "info");
  fs.mkdirSync(info, { recursive: true });
  // shadow repo 自身及用户 Git 元数据绝不能被快照；.agent/tmp 也是运行时临时产物。
  fs.writeFileSync(
    path.join(info, "exclude"),
    [".git/", ".agent/tmp/", ".agent/checkpoints/", ".worktrees/", ""].join("\n"),
    "utf8"
  );
}

/** 创建一个完整工作区快照。返回 commit hash。 */
export function createCheckpoint(root: string, label: string, storageBase?: string): string {
  ensureCheckpointStore(root, storageBase);
  // 使用 shadow repo 自己的 index；git add -A 会尊重项目 .gitignore，同时不会修改用户 index。
  runGit(root, ["add", "-A"], storageBase);
  runGit(root, ["commit", "--quiet", "--allow-empty", "-m", label], storageBase);
  return runGit(root, ["rev-parse", "HEAD"], storageBase).trim();
}

function metadataPath(root: string, storageBase?: string): string {
  return path.join(baseDir(root, storageBase), "checkpoint-events.jsonl");
}

/** 在 shadow commit 与 durable event seq 之间建立不可变关联。 */
export function linkCheckpointToEvent(
  root: string,
  link: CheckpointEventLink,
  storageBase?: string
): void {
  if (!/^[a-f0-9]{7,64}$/i.test(link.hash)) throw new Error("非法 checkpoint hash");
  if (!Number.isInteger(link.eventSeq) || link.eventSeq < 1) throw new Error("非法 eventSeq");
  const fp = metadataPath(root, storageBase);
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  fs.appendFileSync(fp, JSON.stringify({ ...link, linkedAt: Date.now() }) + "\n", "utf8");
}

function checkpointLinks(root: string, storageBase?: string): Map<string, CheckpointEventLink> {
  const out = new Map<string, CheckpointEventLink>();
  try {
    const fp = metadataPath(root, storageBase);
    for (const line of fs.readFileSync(fp, "utf8").split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const row = JSON.parse(line) as CheckpointEventLink;
        if (row.hash && Number.isInteger(row.eventSeq)) out.set(row.hash, row);
      } catch { /* damaged metadata row is ignored */ }
    }
  } catch { /* no metadata yet */ }
  return out;
}

/** 列出最近检查点（最新在前）。 */
export function listCheckpoints(root: string, storageBase?: string, max = 50): CheckpointEntry[] {
  ensureCheckpointStore(root, storageBase);
  try {
    const raw = runGit(
      root,
      ["log", `--max-count=${Math.max(1, Math.floor(max))}`, "--pretty=format:%H%x09%ct%x09%s"],
      storageBase
    );
    const links = checkpointLinks(root, storageBase);
    return raw
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        const [hash, ts, ...rest] = line.split("\t");
        const linked = links.get(hash);
        return {
          hash, createdAt: Number(ts) * 1000, label: rest.join("\t"),
          ...(linked ? { sessionId: linked.sessionId, eventSeq: linked.eventSeq, actor: linked.actor, kind: linked.kind } : {}),
        };
      })
      .filter((x) => !!x.hash && Number.isFinite(x.createdAt));
  } catch {
    return [];
  }
}

/** 找到某会话 event seq 之前最近的工作区检查点。 */
export function checkpointAtOrBefore(
  root: string,
  sessionId: string,
  eventSeq: number,
  storageBase?: string
): CheckpointEntry | null {
  return listCheckpoints(root, storageBase, 500).find((entry) =>
    entry.sessionId === sessionId && typeof entry.eventSeq === "number" && entry.eventSeq <= eventSeq
  ) ?? null;
}


/**
 * 把 shadow commit 物化到一个独立目录，不改用户工作区，也不复用 shadow repo 的主 index。
 * 目标目录必须为空；用于 historical fork/headless time-travel。
 */
export function materializeCheckpoint(
  root: string,
  target: string,
  targetDir: string,
  storageBase?: string
): void {
  ensureCheckpointStore(root, storageBase);
  const targetAbs = path.resolve(targetDir);
  if (fs.existsSync(targetAbs)) {
    const st = fs.lstatSync(targetAbs);
    if (st.isSymbolicLink() || !st.isDirectory()) throw new Error(`fork 目标必须是普通目录：${targetAbs}`);
    if (fs.readdirSync(targetAbs).length > 0) throw new Error(`fork 目标目录非空：${targetAbs}`);
  }
  fs.mkdirSync(targetAbs, { recursive: true });
  // 验证目标是 shadow repo 中真实 commit，避免把任意 rev 参数透传给 checkout-index。
  runGit(root, ["cat-file", "-e", `${target}^{commit}`], storageBase);
  const tmpIndex = path.join(baseDir(root, storageBase), `fork-index-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const env = { ...gitEnv(root, storageBase), GIT_INDEX_FILE: tmpIndex };
  try {
    execFileSync("git", ["read-tree", target], { cwd: root, env, stdio: "ignore" });
    execFileSync("git", ["checkout-index", "--all", "--force", `--prefix=${targetAbs}${path.sep}`], {
      cwd: root, env, stdio: "ignore",
    });
  } finally {
    try { fs.rmSync(tmpIndex, { force: true }); } catch { /* best-effort */ }
  }
}

/**
 * 恢复到指定检查点并截断之后的 shadow 时间线。显式 rewind 才会执行该破坏性动作。
 * `git clean -fd` 仅清理 shadow repo 视角下未跟踪且未被 .gitignore 忽略的文件；
 * .git/.agent/.worktrees 被额外排除，避免误删用户 Git 与 FreeSeek 运行态。
 */
export function restoreCheckpoint(root: string, target: string, storageBase?: string): CheckpointEntry {
  const entries = listCheckpoints(root, storageBase, 200);
  if (!entries.length) throw new Error("没有可恢复的 FreeSeek 检查点");
  const needle = target.trim();
  const entry = needle
    ? entries.find((e) => e.hash.startsWith(needle) || e.label === `freesek-cp:${needle}` || e.label === needle)
    : entries[0];
  if (!entry) throw new Error(`未找到检查点「${target}」`);

  runGit(root, ["reset", "--hard", "--quiet", entry.hash], storageBase);
  runGit(root, ["clean", "-fd", "-q", "-e", ".git/", "-e", ".agent/", "-e", ".worktrees/"], storageBase);
  return entry;
}
