// check:max-lines 270 (文件系统/文本辅助：安全路径、回收站删除、unified diff、glob/grep；tools.ts 拆分；v0.17.6 加固 grep 上限后行数上升)
import * as fs from "fs";
import * as path from "path";
import { execFileSync } from "child_process";

export { resolveSafe, resolveSafeInRoots, canonicalWorkspaceRoots } from "../path-safety";

/**
 * Safe-Delete：把文件/目录移入系统回收站（可恢复），而非永久删除。
 * 跨平台：Windows 用 PowerShell VisualBasic；macOS 用 Finder；Linux 用 gio trash / trash-put。
 * 若平台无可用回收站命令，返回 false（调用方给出警告并建议使用 rm 的替代路径）。
 */
export function trashPath(abs: string, _recursive: boolean): { ok: boolean; detail: string } {
  const platform = process.platform;
  const esc = (p: string) => p.replace(/'/g, "'\\''");
  try {
    if (platform === "win32") {
      // PowerShell + Microsoft.VisualBasic：SendToRecycleBin（文件/目录都支持）
      const ps = [
        "Add-Type -AssemblyName Microsoft.VisualBasic",
        `[Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile('${esc(abs)}','OnlyErrorDialogs','SendToRecycleBin')`,
      ].join("; ");
      execFileSync("powershell", ["-NoProfile", "-Command", ps], { timeout: 30000, windowsHide: true });
      return { ok: true, detail: "已移入系统回收站" };
    }
    if (platform === "darwin") {
      execFileSync("osascript", ["-e", `tell application "Finder" to delete POSIX file '${esc(abs)}'`], {
        timeout: 30000,
      });
      return { ok: true, detail: "已移入废纸篓" };
    }
    // linux 等：优先 gio trash，其次 trash-put
    try {
      execFileSync("gio", ["trash", abs], { timeout: 30000 });
      return { ok: true, detail: "已移入回收站 (gio)" };
    } catch {
      execFileSync("trash-put", [abs], { timeout: 30000 });
      return { ok: true, detail: "已移入回收站 (trash-put)" };
    }
  } catch (e: any) {
    return { ok: false, detail: e?.message ?? String(e) };
  }
}

/**
 * 行级 unified diff（对标 Claude Code / git diff 的红绿对照）。
 * 返回标准 unified diff 文本（含 @@ 块头）+ 增/删行数，供前端渲染「修改痕迹」卡片。
 * 用 LCS 回溯生成精确改动块；大文件（避免 O(n·m) 内存爆炸）退化为「全删/全加」整体对照。
 */
export function unifiedDiff(
  oldText: string,
  newText: string,
  context = 3
): { text: string; added: number; removed: number } {
  const a = oldText.split("\n");
  const b = newText.split("\n");
  const n = a.length;
  const m = b.length;

  type Op = { op: " " | "-" | "+"; oldIdx?: number; newIdx?: number; text: string };
  let ops: Op[];

  // 超大文件退化为朴素整体对照（防止 LCS 二维 DP O(n·m) 内存溢出/主线程卡顿）。
  // 阈值取 1e6（约 n=m=1000）：再大则 LCS DP 会分配上百万格子，既占内存又阻塞 UI。
  if (n * m > 1_000_000) {
    ops = [];
    a.forEach((line, i) => ops.push({ op: "-", oldIdx: i, text: line }));
    b.forEach((line, i) => ops.push({ op: "+", newIdx: i, text: line }));
  } else {
    // LCS 长度 DP（Uint16Array 行减少内存占用；此处 n·m ≤ 1e6，单格值不超过 1000，安全）
    const dp: Uint16Array[] = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
    ops = [];
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (a[i] === b[j]) {
        ops.push({ op: " ", oldIdx: i, newIdx: j, text: a[i] });
        i++;
        j++;
      } else if (dp[i + 1][j] >= dp[i][j + 1]) {
        ops.push({ op: "-", oldIdx: i, text: a[i] });
        i++;
      } else {
        ops.push({ op: "+", newIdx: j, text: b[j] });
        j++;
      }
    }
    while (i < n) {
      ops.push({ op: "-", oldIdx: i, text: a[i] });
      i++;
    }
    while (j < m) {
      ops.push({ op: "+", newIdx: j, text: b[j] });
      j++;
    }
  }

  // 聚合成 hunks（改动 + context 上下文行）
  const added = ops.filter((o) => o.op === "+").length;
  const removed = ops.filter((o) => o.op === "-").length;
  const out: string[] = [];
  const len = ops.length;
  let idx = 0;
  while (idx < len) {
    let next = idx;
    while (next < len && ops[next].op === " ") next++;
    if (next >= len) break;
    const hunkStart = Math.max(idx, next - context);
    let end = next;
    while (end < len && ops[end].op !== " ") end++;
    const hunkEnd = Math.min(end + context, len);
    const slice = ops.slice(hunkStart, hunkEnd);
    let oldCnt = 0;
    let newCnt = 0;
    let oldStart = -1;
    let newStart = -1;
    for (const o of slice) {
      if (o.op === " ") {
        if (oldStart < 0 && o.oldIdx !== undefined) oldStart = o.oldIdx + 1;
        if (newStart < 0 && o.newIdx !== undefined) newStart = o.newIdx + 1;
        oldCnt++;
        newCnt++;
      } else if (o.op === "-") {
        if (oldStart < 0 && o.oldIdx !== undefined) oldStart = o.oldIdx + 1;
        oldCnt++;
      } else {
        if (newStart < 0 && o.newIdx !== undefined) newStart = o.newIdx + 1;
        newCnt++;
      }
    }
    if (oldStart < 0) oldStart = 1;
    if (newStart < 0) newStart = 1;
    out.push(`@@ -${oldStart},${oldCnt} +${newStart},${newCnt} @@`);
    for (const o of slice) {
      out.push(o.op + o.text);
    }
    idx = hunkEnd;
  }

  let text = out.join("\n");
  if (!text.trim()) text = "(无内容差异)";
  return { text, added, removed };
}

/** 正则特殊字符转义（glob 片段拼接正则用）。 */
export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 简单 glob 匹配：`*` 匹配任意字符（含空串），整串锚定。 */
function matchSimple(name: string, pat: string): boolean {
  const re = "^" + pat.split("*").map(escapeRegExp).join(".*") + "$";
  return new RegExp(re).test(name);
}

/** glob 匹配遍历：`**` 递归、`*` 单层通配，跳过 node_modules/.git，depth/limit 双保险。 */
export function walkMatch(root: string, pattern: string, depth: number, limit: number): string[] {
  if (depth > 8 || limit <= 0) return [];
  const out: string[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return out;
  }
  const segs = pattern.split("/");
  const head = segs[0];
  const hasGlob = head.includes("*") || head === "**";
  for (const e of entries) {
    if (e.name === "node_modules" || e.name === ".git") continue;
    const full = path.join(root, e.name);
    if (e.isDirectory()) {
      if (head === "**") {
        const sub = segs.length > 1 ? segs.slice(1).join("/") : "**";
        out.push(...walkMatch(full, sub, depth + 1, limit - out.length));
      } else if (!hasGlob) {
        out.push(...walkMatch(full, pattern, depth + 1, limit - out.length));
      }
    } else if (matchSimple(e.name, head)) {
      out.push(full);
    }
    if (out.length >= limit) break;
  }
  return out;
}

/** 单文件读取硬上限（字节）：超过此大小的文件在 grep 中跳过，避免巨文件整读 OOM / 主线程卡死。 */
export const MAX_GREP_FILE_BYTES = 8 * 1024 * 1024;

/** 递归 grep：正则逐行匹配，include 通配过滤文件名，跳过 node_modules/.git 与超大文件。 */
export function grepWalk(root: string, re: RegExp, include: string | null, out: string[], depth: number, limit: number): void {
  if (depth > 10 || out.length >= limit) return;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.name === "node_modules" || e.name === ".git") continue;
    const full = path.join(root, e.name);
    if (e.isDirectory()) {
      grepWalk(full, re, include, out, depth + 1, limit);
    } else if (!include || matchSimple(e.name, include)) {
      try {
        // 超大文件跳过（防整读 OOM）；命中上限时记录一次提示而非静默丢弃
        const size = fs.statSync(full).size;
        if (size > MAX_GREP_FILE_BYTES) {
          if (out.length < limit) out.push(`${full}:0: ⚠ 跳过（文件 ${size} 字节 > ${MAX_GREP_FILE_BYTES} 上限，可用 read_file 指定范围）`);
          continue;
        }
        const lines = fs.readFileSync(full, "utf8").split("\n");
        lines.forEach((l, i) => {
          if (re.test(l)) out.push(`${full}:${i + 1}: ${l.trim()}`);
        });
      } catch {
        /* 二进制文件跳过 */
      }
    }
    if (out.length >= limit) return;
  }
}
