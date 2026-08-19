import * as fs from "fs";
import * as path from "path";

/** path.relative 结果是否位于根目录之外。 */
function isOutside(rel: string): boolean {
  return rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel);
}

function safeRealpath(p: string): string {
  try { return fs.realpathSync(p); } catch { return path.resolve(p); }
}

function assertWithin(rootReal: string, real: string, original: string): void {
  if (isOutside(path.relative(rootReal, real))) {
    throw new Error(`路径越界（含符号链接解析），禁止访问工作区外: ${original} -> ${real}`);
  }
}

/**
 * 安全路径解析。对于不存在的新文件，会向上检查最近存在祖先的 realpath，
 * 防止 `workspace/link -> /outside` 后写 `link/new.txt` 的父级 symlink 逃逸。
 */
export function resolveSafe(root: string, p: string): string {
  const rootReal = safeRealpath(root);
  const abs = path.isAbsolute(p) ? path.resolve(p) : path.resolve(rootReal, p);
  if (isOutside(path.relative(rootReal, abs))) throw new Error(`路径越界，禁止访问工作区外: ${p}`);

  let cur = abs;
  while (true) {
    try {
      const st = fs.lstatSync(cur);
      if (st.isSymbolicLink()) {
        let linked: string;
        try { linked = fs.realpathSync(cur); }
        catch { throw new Error(`路径包含悬空符号链接，拒绝访问: ${p}`); }
        assertWithin(rootReal, linked, p);
        if (cur === abs) return linked;
        break;
      }
      const real = fs.realpathSync(cur);
      assertWithin(rootReal, real, p);
      if (cur === abs) return real;
      break;
    } catch (e: any) {
      if (e?.message?.startsWith("路径")) throw e;
      const parent = path.dirname(cur);
      if (parent === cur) throw new Error(`路径解析失败，拒绝访问: ${p}`);
      cur = parent;
    }
  }
  return abs;
}
