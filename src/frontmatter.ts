/**
 * 通用 YAML-ish frontmatter 解析器。
 * 收敛 skills / commands / hookify / agent-subagent 各自实现的重复解析。
 *
 * 支持：标量、布尔、JSON 数组（[...]）、带引号字符串、简单列表（`- key: value`，
 * 用于 conditions 类嵌套结构）。返回 { fm, body }（fm 键名与 skills 旧实现一致，便于迁移）。
 */

export interface Frontmatter {
  [k: string]: any;
}

function parseValue(v: string): any {
  if (!v) return v;
  if ((v.startsWith("[") && v.endsWith("]")) || (v.startsWith('"') && v.endsWith('"'))) {
    try {
      return JSON.parse(v);
    } catch {
      return v;
    }
  }
  if (v === "true") return true;
  if (v === "false") return false;
  return v;
}

export function parseFrontmatter(content: string): { fm: Frontmatter; body: string } {
  const lines = (content || "").split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return { fm: {}, body: content };
  const fm: Frontmatter = {};
  let body = "";
  let inList: Record<string, string>[] | null = null;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === "---") {
      body = lines.slice(i + 1).join("\n").trim();
      break;
    }
    // 列表项起始：- field: x（每次 "-" 开启新元素）
    const item = line.match(/^\s*-\s+([A-Za-z_][\w]*)\s*:\s*(.*)$/);
    if (item && inList) {
      inList.push({ [item[1]]: item[2] });
      continue;
    }
    // 列表内续行：operator: regex_match（追加到当前列表最后一个元素）
    if (inList) {
      const kv = line.match(/^\s+([A-Za-z_][\w]*)\s*:\s*(.*)$/);
      if (kv) {
        const last = inList[inList.length - 1];
        if (last) last[kv[1]] = kv[2];
        continue;
      }
    }
    // 列表键：conditions:
    const listKey = line.match(/^([A-Za-z_][\w]*)\s*:\s*$/);
    if (listKey) {
      inList = [];
      fm[listKey[1]] = inList;
      continue;
    }
    // 普通键值：name: x
    inList = null;
    const kv = line.match(/^([A-Za-z_][\w]*)\s*:\s*(.*)$/);
    if (kv) fm[kv[1]] = parseValue(kv[2].trim());
  }
  return { fm, body };
}

/** 取字符串标量（去引号），无则返回 undefined。 */
export function fmString(fm: Frontmatter, key: string): string | undefined {
  const v = fm[key];
  if (typeof v === "string") {
    const t = v.trim().replace(/^['"]|['"]$/g, "").trim();
    return t || undefined;
  }
  return undefined;
}

/** 取字符串数组（兼容 JSON 数组、逗号分隔串两种写法），无则返回 undefined。 */
export function fmStringArray(fm: Frontmatter, key: string): string[] | undefined {
  const v = fm[key];
  const clean = (s: string) => s.trim().replace(/^['"]|['"]$/g, "").trim();
  if (Array.isArray(v)) {
    const arr = v.map((x) => clean(String(x))).filter(Boolean);
    return arr.length ? arr : undefined;
  }
  if (typeof v === "string") {
    const arr = v.split(",").map(clean).filter(Boolean);
    return arr.length ? arr : undefined;
  }
  return undefined;
}