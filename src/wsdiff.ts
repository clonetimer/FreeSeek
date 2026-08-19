/**
 * 工作区变更检测（对标 Codex shell_snapshot.rs）：
 * 在执行 shell 命令前后各取一次 `git status --porcelain` 快照，比对新增条目，
 * 把"命令产生了未声明的文件改动"提示回灌给模型，让其核实/回滚。
 * 非 git 仓库或 git 不可用时静默返回 null（不阻塞命令执行）。
 */
import { execFile } from "child_process";

/** 读取当前 git 未提交变更快照（porcelain 行数组）。非 git 仓库 / 失败返回 null。 */
export function snapshotGitStatus(cwd: string): Promise<string[] | null> {
  return new Promise((resolve) => {
    execFile(
      "git",
      ["status", "--porcelain"],
      { cwd, timeout: 5000, maxBuffer: 2 * 1024 * 1024, windowsHide: true },
      (err, stdout) => {
        if (err) {
          resolve(null);
          return;
        }
        resolve(
          String(stdout)
            .split(/\r?\n/)
            .map((l) => l.trim())
            .filter(Boolean)
        );
      }
    );
  });
}

/** 比对前后快照，返回"执行后新增出现的变更条目"（上限 25 条）。任一侧为 null 则视为不可检测。 */
export function diffGitStatus(before: string[] | null, after: string[] | null): string[] {
  if (!before || !after) return [];
  const seen = new Set(before);
  return after.filter((l) => !seen.has(l)).slice(0, 25);
}

/**
 * 命令执行前后对比工作区，若出现未声明变更则生成提示文本；否则返回空串。
 * 提示语气中性：git add/commit 等本意改变状态的操作会被视为"有意为之"，模型自行判断。
 */
export async function detectWorkspaceChanges(cwd: string, before: string[] | null): Promise<string> {
  if (!before) return "";
  const after = await snapshotGitStatus(cwd);
  const added = diffGitStatus(before, after);
  if (!added.length) return "";
  return (
    `\n\n⚠️ 命令执行后工作区 git 状态出现 ${added.length} 条未声明变更：\n` +
    added.join("\n") +
    "\n请核实这些改动是否符合用户预期；若属于命令的意外副作用，请用 git 还原对应文件。"
  );
}
