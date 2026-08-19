/**
 * Git Worktree 封装（Layer 6 并行隔离 / 对标 Claude Code Worktree）。
 *
 * 工作树在 `<root>/.worktrees/<name>` 下创建，与主仓库共享 `.git`，
 * 但拥有独立的文件系统工作副本与分支。借此可让多个子智能体在互不干扰的
 * 副本上并行修改不同模块，最后由用户手动 `git worktree merge` / cherry-pick
 * 合并回主线——避免直接在主线工作区互相覆盖。
 *
 * 注意：本模块只负责「创建/列举/删除」工作树；把子智能体派发到某工作树
 * 由 agent.ts 的 spawn_agent（带 worktree 参数）完成。
 */

import { execFileSync } from "child_process";
import * as fs from "fs";
import * as path from "path";

export interface WorktreeInfo {
  /** 绝对路径 */
  path: string;
  /** 当前分支名（去 refs/heads/ 前缀） */
  branch: string;
  /** 是否为主工作树 */
  bare?: boolean;
}

function git(args: string[], cwd: string): string {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (e: any) {
    const msg = (e?.stderr || e?.stdout || e?.message || "").toString().trim();
    throw new Error(`git ${args.join(" ")} 失败：${msg}`);
  }
}

/** 判断 root 是否位于一个 git 工作树内（否则 worktree 不可用）。 */
export function isGitRepo(root: string): boolean {
  try {
    const out = execFileSync("git", ["rev-parse", "--is-inside-work-tree"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return out.trim() === "true";
  } catch {
    return false;
  }
}

/** 列举所有工作树（含主树）。 */
export function listWorktrees(root: string): WorktreeInfo[] {
  const out = git(["worktree", "list", "--porcelain"], root);
  const items: WorktreeInfo[] = [];
  let cur: any = {};
  for (const line of out.split("\n")) {
    if (line.startsWith("worktree ")) cur.path = line.slice(9).trim();
    else if (line.startsWith("branch ")) cur.branch = line.slice(7).trim().replace(/^refs\/heads\//, "");
    else if (line === "") {
      if (cur.path) items.push(cur);
      cur = {};
    }
  }
  if (cur.path) items.push(cur);
  return items;
}

/**
 * 新建一个工作树。
 * @param root 主仓库根
 * @param name 工作树名（决定目录 .worktrees/<name> 与默认分支 worktree/<name>）
 * @param branch 显式分支名（可选）；不填则派生 worktree/<name>
 * @param base 新建分支的基点（可选，如 main）；不填则基于当前 HEAD
 */
export function addWorktree(root: string, name: string, branch?: string, base?: string): string {
  const safe = name.replace(/[^A-Za-z0-9._-]/g, "_");
  const wtDir = path.join(root, ".worktrees", safe);
  if (fs.existsSync(wtDir)) throw new Error(`工作树已存在：${wtDir}`);
  const branchName = branch || `worktree/${safe}`;
  const args = ["worktree", "add", "-b", branchName];
  if (base) args.push(base);
  args.push(wtDir);
  git(args, root);
  return wtDir;
}

/** 强制移除一个工作树（--force 处理未提交改动）。 */
export function removeWorktree(root: string, wtPath: string): string {
  git(["worktree", "remove", "--force", wtPath], root);
  return `已移除工作树：${wtPath}`;
}
