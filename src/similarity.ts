/**
 * 文本相似度工具（收敛 memory / skills 各自实现的 tokenize + jaccard 重复）。
 * 中文按单字、英文/数字按连续词切分——比「按非字母数字整体切分」对中文更敏感，
 * 用于记忆去重 / 技能去重的相似判定。
 */

export function tokenize(s: string): Set<string> {
  const t = (s || "").toLowerCase();
  const tokens: string[] = [];
  for (const m of t.matchAll(/([\u4e00-\u9fa5])|([a-z0-9]+)/g)) {
    const tok = m[1] ?? m[2];
    if (tok) tokens.push(tok);
  }
  return new Set(tokens);
}

/** Jaccard 相似度：两集合交集 / 并集。 */
export function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}