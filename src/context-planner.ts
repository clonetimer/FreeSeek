/** Deterministic repository context planning for FreeSeek Agent runs. */
import * as fs from "fs";
import * as path from "path";
import { estimateTokens } from "./context";
import { resolveSafe } from "./path-safety";

/** Supported runtime planner modes. */
export const CONTEXT_PLANNER_MODES = ["off", "v1", "v1.1", "v1.2"] as const;
export type ContextPlannerMode = typeof CONTEXT_PLANNER_MODES[number];
export type ContextPlannerVariant = Exclude<ContextPlannerMode, "off">;

/** Runtime/CLI guard for supported planner modes. */
export function isContextPlannerMode(value: unknown): value is ContextPlannerMode {
  return typeof value === "string" && (CONTEXT_PLANNER_MODES as readonly string[]).includes(value);
}

export interface ContextPlannerOptions {
  mode?: ContextPlannerVariant;
  budgetTokens?: number;
  maxFiles?: number;
  maxRepoFiles?: number;
  maxFileBytes?: number;
  dependencyDepth?: number;
}

export interface RepoSymbol {
  name: string;
  kind: string;
  line: number;
}

export interface RepoFileEntry {
  path: string;
  size: number;
  language: string;
  symbols: RepoSymbol[];
  imports: string[];
  resolvedImports: string[];
  preview: string;
  lines: string[];
}

export interface RepoMap {
  workspaceRoot: string;
  files: RepoFileEntry[];
  truncated: boolean;
}

export interface ContextPlanFile {
  path: string;
  score: number;
  reasons: string[];
  symbols: string[];
  excerpt: string;
  relation: "seed" | "dependency" | "importer";
}

export interface ContextPlan {
  version: 1;
  variant: ContextPlannerVariant;
  query: string;
  budgetTokens: number;
  estimatedTokens: number;
  indexedFiles: number;
  repoTruncated: boolean;
  selected: ContextPlanFile[];
  rendered: string;
  durationMs: number;
}

const SOURCE_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".go", ".rs", ".java", ".kt", ".kts",
  ".cs", ".cpp", ".cc", ".c", ".h", ".hpp", ".rb", ".php", ".swift", ".vue", ".svelte",
  ".json", ".yaml", ".yml", ".toml", ".md",
]);
const SKIP_DIRS = new Set([
  ".git", "node_modules", ".next", ".nuxt", ".turbo", ".cache", "coverage", "target", "vendor",
  "__pycache__", ".venv", "venv", "dist", "build", "out",
]);
const LOW_SIGNAL_SEGMENTS = new Set(["legacy", "generated", "distractors", "fixtures", "snapshots"]);
const MAX_PREVIEW_CHARS = 48_000;
const PLAN_MARKER_PREFIX = "<!-- freesek-context-plan:";

function languageFor(file: string): string {
  const ext = path.extname(file).toLowerCase();
  return ({
    ".ts": "typescript", ".tsx": "tsx", ".js": "javascript", ".jsx": "jsx", ".mjs": "javascript", ".cjs": "javascript",
    ".py": "python", ".go": "go", ".rs": "rust", ".java": "java", ".kt": "kotlin", ".kts": "kotlin",
    ".cs": "csharp", ".cpp": "cpp", ".cc": "cpp", ".c": "c", ".h": "c", ".hpp": "cpp", ".rb": "ruby",
    ".php": "php", ".swift": "swift", ".vue": "vue", ".svelte": "svelte", ".json": "json", ".yaml": "yaml",
    ".yml": "yaml", ".toml": "toml", ".md": "markdown",
  } as Record<string, string>)[ext] ?? "text";
}

function normalizeRel(file: string): string {
  return file.replace(/\\/g, "/").replace(/^\.\//, "");
}

function tokenize(text: string): string[] {
  const out = new Set<string>();
  const lower = text.toLowerCase();
  for (const m of lower.matchAll(/[a-z0-9_$][a-z0-9_$.-]{1,80}/g)) {
    const raw = m[0].replace(/^\.+|\.+$/g, "");
    if (raw.length >= 2) {
      out.add(raw);
      for (const part of raw.split(/[./_:-]+/)) if (part.length >= 2) out.add(part);
    }
  }
  for (const m of text.matchAll(/[\u3400-\u9fff]{2,12}/g)) {
    const raw = m[0];
    out.add(raw);
    for (let i = 0; i + 1 < raw.length; i++) out.add(raw.slice(i, i + 2));
  }
  return [...out].filter((t) => !/^(the|and|for|with|from|this|that|src|file|code|fix|修复|修改|不要|当前|生产)$/.test(t));
}

function explicitPaths(text: string): string[] {
  const matches = new Set<string>();
  for (const m of text.matchAll(/(?:`|"|')([^`"'\n]+\/[\w./-]+\.[a-zA-Z0-9]+)(?:`|"|')/g)) matches.add(normalizeRel(m[1]));
  for (const m of text.matchAll(/\b(?:src|lib|app|packages?|tests?|test)\/[\w./-]+\.[a-zA-Z0-9]+\b/g)) matches.add(normalizeRel(m[0]));
  return [...matches];
}

interface QueryIntent {
  excludedSegments: Set<string>;
  excludedTerms: Set<string>;
  excludeExampleLike: boolean;
  asksForTests: boolean;
  asksForDocs: boolean;
  prefersProduction: boolean;
}

function cueNear(text: string, token: string, cue: RegExp): boolean {
  let at = text.indexOf(token);
  while (at >= 0) {
    const window = text.slice(Math.max(0, at - 48), Math.min(text.length, at + token.length + 48));
    if (cue.test(window)) return true;
    at = text.indexOf(token, at + token.length);
  }
  return false;
}

function queryIntent(query: string): QueryIntent {
  const lower = query.toLowerCase();
  const negative = /不要|别|避免|勿|禁止|不可|do\s+not|don['’]t|avoid|never|must\s+not|should\s+not/i;
  const excludedSegments = new Set<string>();
  const excludedTerms = new Set<string>();
  const groups: Array<{ tokens: string[]; segments: string[] }> = [
    { tokens: ["tests", "test", "__tests__"], segments: ["tests", "test", "__tests__"] },
    { tokens: ["legacy"], segments: ["legacy"] },
    { tokens: ["build", "dist", "generated"], segments: ["build", "dist", "out", "generated"] },
    { tokens: ["example", "examples", "sample", "samples", "fixtures"], segments: ["example", "examples", "sample", "samples", "fixtures"] },
  ];
  let excludeExampleLike = false;
  for (const group of groups) {
    if (!group.tokens.some((token) => cueNear(lower, token, negative))) continue;
    for (const segment of group.segments) excludedSegments.add(segment);
    for (const token of group.tokens) excludedTerms.add(token);
    if (group.tokens.includes("example")) excludeExampleLike = true;
  }
  const asksForTests = !excludedSegments.has("tests") && /(?:修复|修改|更新|新增|补|fix|update|add|write).{0,18}(?:tests?|测试)|(?:tests?|测试).{0,18}(?:失败|fail|修复|修改|更新)/i.test(lower);
  const asksForDocs = /(?:修复|修改|更新|write|fix|update).{0,18}(?:readme|docs?|文档|说明)/i.test(lower);
  const prefersProduction = /生产|线上|运行时|runtime|production|prod\b|实际实现|server|middleware/i.test(lower);
  return { excludedSegments, excludedTerms, excludeExampleLike, asksForTests, asksForDocs, prefersProduction };
}

function pathExcludedByIntent(filePath: string, intent: QueryIntent): boolean {
  const lowerPath = filePath.toLowerCase();
  const segments = lowerPath.split("/");
  const basename = path.posix.basename(lowerPath);
  return segments.some((segment) => intent.excludedSegments.has(segment))
    || (intent.excludeExampleLike && /(?:example|sample|fixture)/.test(basename));
}

function safeReadPreview(file: string, maxBytes: number): string {
  try {
    const fd = fs.openSync(file, "r");
    try {
      const stat = fs.fstatSync(fd);
      const size = Math.min(stat.size, maxBytes);
      const buf = Buffer.alloc(size);
      const read = fs.readSync(fd, buf, 0, size, 0);
      const chunk = buf.subarray(0, read);
      if (chunk.includes(0)) return "";
      return chunk.toString("utf8").slice(0, MAX_PREVIEW_CHARS);
    } finally { fs.closeSync(fd); }
  } catch { return ""; }
}

function lineOf(text: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}

function extractSymbols(text: string, language: string): RepoSymbol[] {
  const out: RepoSymbol[] = [];
  const patterns: Array<[string, RegExp]> = language === "python"
    ? [["class", /^\s*class\s+([A-Za-z_]\w*)/gm], ["function", /^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)/gm]]
    : language === "go"
      ? [["type", /^\s*type\s+([A-Za-z_]\w*)/gm], ["function", /^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/gm]]
      : language === "rust"
        ? [["type", /^\s*(?:pub\s+)?(?:struct|enum|trait)\s+([A-Za-z_]\w*)/gm], ["function", /^\s*(?:pub\s+)?(?:async\s+)?fn\s+([A-Za-z_]\w*)/gm]]
        : [["class", /\b(?:export\s+)?(?:default\s+)?class\s+([A-Za-z_$][\w$]*)/g],
           ["function", /\b(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g],
           ["function", /\b(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\([^)]*\)\s*=>/g],
           ["type", /\b(?:export\s+)?(?:interface|type|enum)\s+([A-Za-z_$][\w$]*)/g]];
  for (const [kind, re] of patterns) {
    for (const m of text.matchAll(re)) {
      if (!m[1]) continue;
      out.push({ name: m[1], kind, line: lineOf(text, m.index ?? 0) });
      if (out.length >= 80) return out;
    }
  }
  return out;
}

function extractImports(text: string, language: string): string[] {
  const out = new Set<string>();
  if (["typescript", "tsx", "javascript", "jsx", "vue", "svelte"].includes(language)) {
    const patterns = [
      /\b(?:import|export)\s+(?:[^"']*?\s+from\s+)?["']([^"']+)["']/g,
      /\brequire\(\s*["']([^"']+)["']\s*\)/g,
      /\bimport\(\s*["']([^"']+)["']\s*\)/g,
    ];
    for (const re of patterns) for (const m of text.matchAll(re)) if (m[1]) out.add(m[1]);
  } else if (language === "python") {
    for (const m of text.matchAll(/^\s*(?:from\s+([\w.]+)\s+import|import\s+([\w.]+))/gm)) out.add(m[1] || m[2]);
  } else if (language === "rust") {
    for (const m of text.matchAll(/^\s*(?:use|mod)\s+([\w:]+)/gm)) out.add(m[1]);
  }
  return [...out];
}

function resolveImport(from: string, specifier: string, fileSet: Set<string>): string | undefined {
  if (!specifier.startsWith(".")) return undefined;
  const base = normalizeRel(path.posix.normalize(path.posix.join(path.posix.dirname(from), specifier)));
  const candidates = [base, ...[".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json"].map((ext) => `${base}${ext}`),
    ...["index.ts", "index.tsx", "index.js", "index.jsx"].map((name) => `${base}/${name}`)];
  return candidates.find((candidate) => fileSet.has(candidate));
}

/** Build a bounded repository map with symbols and local import edges. */
export function buildRepoMap(workspaceRoot: string, options: ContextPlannerOptions = {}): RepoMap {
  const root = fs.realpathSync(workspaceRoot);
  const maxRepoFiles = Math.max(50, Math.min(20_000, options.maxRepoFiles ?? 4_000));
  const maxFileBytes = Math.max(8_192, Math.min(512_000, options.maxFileBytes ?? 96_000));
  const files: RepoFileEntry[] = [];
  let truncated = false;
  const walk = (dir: string) => {
    if (files.length >= maxRepoFiles) { truncated = true; return; }
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (files.length >= maxRepoFiles) { truncated = true; return; }
      if (entry.isSymbolicLink()) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name) && !entry.name.startsWith(".freesek")) walk(full);
        continue;
      }
      if (!entry.isFile()) continue;
      const ext = path.extname(entry.name).toLowerCase();
      if (!SOURCE_EXTENSIONS.has(ext) && !["Dockerfile", "Makefile"].includes(entry.name)) continue;
      let safe: string;
      try { safe = resolveSafe(root, path.relative(root, full)); } catch { continue; }
      const rel = normalizeRel(path.relative(root, safe));
      let size = 0;
      try { size = fs.statSync(safe).size; } catch { continue; }
      const preview = safeReadPreview(safe, Math.min(maxFileBytes, size));
      const language = languageFor(safe);
      files.push({
        path: rel,
        size,
        language,
        symbols: extractSymbols(preview, language),
        imports: extractImports(preview, language),
        resolvedImports: [],
        preview,
        lines: preview.split(/\r?\n/),
      });
    }
  };
  walk(root);
  const fileSet = new Set(files.map((file) => file.path));
  for (const file of files) file.resolvedImports = file.imports.map((spec) => resolveImport(file.path, spec, fileSet)).filter((x): x is string => Boolean(x));
  return { workspaceRoot: root, files, truncated };
}

function scoreFile(
  file: RepoFileEntry,
  query: string,
  terms: string[],
  explicit: string[],
  variant: ContextPlannerVariant,
  intent: QueryIntent
): { score: number; reasons: string[]; hitLines: number[] } {
  let score = 0;
  const reasons: string[] = [];
  const hitLines: number[] = [];
  const lowerPath = file.path.toLowerCase();
  const lowerPreview = file.preview.toLowerCase();
  const basename = path.posix.basename(lowerPath);
  for (const p of explicit) {
    const lower = p.toLowerCase();
    if (lowerPath === lower) { score += 140; reasons.push("任务显式路径"); }
    else if (lowerPath.endsWith(`/${lower}`) || basename === path.posix.basename(lower)) { score += 70; reasons.push("任务路径/文件名匹配"); }
  }
  let pathHits = 0, symbolHits = 0, contentHits = 0;
  for (const term of terms) {
    if (lowerPath.includes(term)) pathHits++;
    if (file.symbols.some((symbol) => symbol.name.toLowerCase() === term || symbol.name.toLowerCase().includes(term))) symbolHits++;
    if (term.length >= 3 && lowerPreview.includes(term)) contentHits++;
  }
  if (pathHits) { score += Math.min(45, pathHits * 9); reasons.push(`路径关键词×${pathHits}`); }
  if (symbolHits) { score += Math.min(60, symbolHits * 15); reasons.push(`符号匹配×${symbolHits}`); }
  if (contentHits) { score += Math.min(32, contentHits * 4); reasons.push(`内容关键词×${contentHits}`); }
  const queryLower = query.toLowerCase();
  if (/readme|文档|说明/.test(queryLower) && basename.startsWith("readme")) score += 20;
  const segments = lowerPath.split("/");
  const lowSignal = segments.filter((segment) => LOW_SIGNAL_SEGMENTS.has(segment)).length;
  if (lowSignal) score -= lowSignal * 18;
  const isTest = segments.includes("tests") || segments.includes("test") || segments.includes("__tests__") || /(?:^|\/)(?:test|spec)[._-]/.test(lowerPath);
  if (variant === "v1") {
    if (isTest) score -= /test|测试/.test(queryLower) ? 0 : 5;
  } else {
    const explicitlyExcluded = pathExcludedByIntent(file.path, intent);
    if (explicitlyExcluded) { score -= 120; reasons.push("任务明确排除"); }
    if (isTest && !intent.asksForTests) { score -= 28; reasons.push("非测试任务降权"); }
    const isDocs = basename.startsWith("readme") || segments.includes("docs") || segments.includes("doc");
    if (isDocs && !intent.asksForDocs) { score -= 22; reasons.push("文档降权"); }
    const isExampleLike = /(?:^|[-_.])(example|sample|fixture)(?:[-_.]|$)/.test(basename) || segments.some((segment) => /^(?:examples?|samples?|fixtures)$/.test(segment));
    if (isExampleLike && !intent.excludeExampleLike) { score -= 12; reasons.push("示例文件降权"); }
    const productionLike = ["src", "lib", "app", "server", "packages"].includes(segments[0] ?? "") || segments.includes("runtime");
    if (intent.prefersProduction && productionLike && !isTest && !isDocs) { score += 12; reasons.push("生产路径偏好"); }
  }
  if (file.preview) {
    const matchTerms = terms.filter((term) => term.length >= 3).slice(0, 16);
    for (let i = 0; i < file.lines.length && hitLines.length < 8; i++) {
      const line = file.lines[i].toLowerCase();
      if (matchTerms.some((term) => line.includes(term))) hitLines.push(i + 1);
    }
  }
  return { score, reasons, hitLines };
}

function excerptFor(file: RepoFileEntry, hitLines: number[], maxLines = 16): string {
  if (!file.lines.length) return "";
  const anchors = hitLines.length ? hitLines : file.symbols.slice(0, 2).map((s) => s.line);
  const indexes = new Set<number>();
  for (const anchor of anchors.slice(0, 3)) {
    const start = Math.max(1, anchor - 2), end = Math.min(file.lines.length, anchor + 3);
    for (let line = start; line <= end && indexes.size < maxLines; line++) indexes.add(line);
  }
  if (!indexes.size) for (let line = 1; line <= Math.min(maxLines, file.lines.length); line++) indexes.add(line);
  return [...indexes].sort((a, b) => a - b).map((line) => `${line}: ${file.lines[line - 1]}`).join("\n").slice(0, 6000);
}

function relationCandidates(map: RepoMap, seeds: RepoFileEntry[], depth: number): Array<{ file: RepoFileEntry; relation: "dependency" | "importer" }> {
  const byPath = new Map(map.files.map((file) => [file.path, file]));
  const importers = new Map<string, string[]>();
  for (const file of map.files) for (const dep of file.resolvedImports) (importers.get(dep) ?? importers.set(dep, []).get(dep)!).push(file.path);
  const seen = new Set(seeds.map((file) => file.path));
  const out: Array<{ file: RepoFileEntry; relation: "dependency" | "importer" }> = [];
  let frontier = seeds.map((file) => file.path);
  for (let d = 0; d < depth; d++) {
    const next: string[] = [];
    for (const current of frontier) {
      const entry = byPath.get(current);
      for (const dep of entry?.resolvedImports ?? []) if (!seen.has(dep)) {
        seen.add(dep); next.push(dep); const file = byPath.get(dep); if (file) out.push({ file, relation: "dependency" });
      }
      for (const importer of importers.get(current) ?? []) if (!seen.has(importer)) {
        seen.add(importer); next.push(importer); const file = byPath.get(importer); if (file) out.push({ file, relation: "importer" });
      }
    }
    frontier = next;
  }
  return out;
}

function renderLegacyPlan(query: string, map: RepoMap, selected: ContextPlanFile[], budgetTokens: number, variant: ContextPlannerVariant): string {
  const lines = [
    `${PLAN_MARKER_PREFIX}${variant} -->`,
    `## FreeSeek Context Planner ${variant}`,
    `任务：${query.slice(0, 800)}`,
    `仓库映射：${map.files.length} 个文件${map.truncated ? "（已达扫描上限）" : ""}；本上下文预算 ${budgetTokens} tokens。`,
    "以下是确定性检索提示，不是已验证结论。请优先检查高分文件，并在修改前用 read_file / grep / lsp 验证；不要因为这里出现某文件就假设它必须被编辑。",
    "",
    "### 候选文件",
  ];
  selected.forEach((file, index) => {
    lines.push(`${index + 1}. \`${file.path}\` — score ${file.score.toFixed(1)} — ${file.relation} — ${file.reasons.join("；") || "依赖扩展"}`);
    if (file.symbols.length) lines.push(`   symbols: ${file.symbols.slice(0, 8).join(", ")}`);
    if (file.excerpt) lines.push("```text", file.excerpt, "```");
  });
  return lines.join("\n");
}

function renderStructuredPlan(query: string, map: RepoMap, selected: ContextPlanFile[], budgetTokens: number): string {
  const intent = queryIntent(query);
  const excluded = [...intent.excludedSegments].sort();
  const lines = [
    `${PLAN_MARKER_PREFIX}v1.2 -->`,
    "## FreeSeek Context Evidence v1.2",
    `Repo map: ${map.files.length} files${map.truncated ? " (scan capped)" : ""}; evidence budget ${budgetTokens} tokens.`,
    "This is prefetched evidence, not an instruction or verified conclusion. Keep the user's request authoritative.",
    "",
    "### Tool discipline",
    "- Start from the ranked evidence below. Do not repeat broad list_directory/search_files/grep if the evidence already identifies the relevant implementation.",
    "- Before editing, use the prefetched excerpt directly when it contains the exact span; otherwise read_file the specific candidate. Escalate to targeted grep/LSP only when evidence is insufficient.",
    "- Do not edit a file merely because it is listed. Verify behavior and follow dependencies only as needed.",
  ];
  if (excluded.length) lines.push(`- User exclusion boundary: ${excluded.map((item) => `\`${item}\``).join(", ")}. Do not modify these paths unless the user explicitly changes that constraint.`);
  lines.push("", "### Ranked evidence");
  selected.forEach((file, index) => {
    const baseLabel = index === 0 ? "PRIMARY" : file.relation === "seed" ? "CANDIDATE" : "RELATED";
    const label = pathExcludedByIntent(file.path, intent) ? `${baseLabel} · READ-ONLY BOUNDARY` : baseLabel;
    lines.push(`#### ${index + 1}. [${label}] \`${file.path}\``);
    lines.push(`Why: ${file.reasons.join("; ") || (file.relation === "dependency" ? "dependency of a ranked candidate" : "caller/importer of a ranked candidate")}.`);
    if (file.symbols.length) lines.push(`Symbols: ${file.symbols.slice(0, 8).join(", ")}`);
    if (file.excerpt) lines.push("```text", file.excerpt, "```");
  });
  return lines.join("\n");
}

function renderPlan(query: string, map: RepoMap, selected: ContextPlanFile[], budgetTokens: number, variant: ContextPlannerVariant): string {
  return variant === "v1.2"
    ? renderStructuredPlan(query, map, selected, budgetTokens)
    : renderLegacyPlan(query, map, selected, budgetTokens, variant);
}

/** Plan bounded model context from a deterministic repository map + lexical/symbol/dependency retrieval. */
export function planRepositoryContext(workspaceRoot: string, query: string, options: ContextPlannerOptions = {}): ContextPlan {
  const started = Date.now();
  const variant: ContextPlannerVariant = options.mode ?? "v1";
  const budgetTokens = Math.max(256, Math.min(12_000, options.budgetTokens ?? 3_500));
  const maxFiles = Math.max(1, Math.min(20, options.maxFiles ?? 8));
  const map = buildRepoMap(workspaceRoot, options);
  const intent = queryIntent(query);
  const terms = tokenize(query).filter((term) => variant === "v1" || !intent.excludedTerms.has(term));
  const explicit = explicitPaths(query);
  const scored = map.files.map((file) => ({ file, ...scoreFile(file, query, terms, explicit, variant, intent) }))
    .sort((a, b) => b.score - a.score || a.file.path.localeCompare(b.file.path));
  const positive = scored.filter((row) => row.score > 0);
  const seeds = (positive.length ? positive : scored).slice(0, Math.min(5, maxFiles)).map((row) => row.file);
  const relations = relationCandidates(map, seeds, Math.max(0, Math.min(3, options.dependencyDepth ?? 1)));
  const selected: ContextPlanFile[] = [];
  const seen = new Set<string>();
  const push = (file: RepoFileEntry, score: number, reasons: string[], hitLines: number[], relation: ContextPlanFile["relation"]) => {
    if (seen.has(file.path) || selected.length >= maxFiles) return;
    seen.add(file.path);
    selected.push({ path: file.path, score, reasons, symbols: file.symbols.map((s) => `${s.name}:${s.kind}@${s.line}`), excerpt: excerptFor(file, hitLines), relation });
  };
  for (const row of scored) {
    if (row.score <= 0 && selected.length >= Math.min(3, maxFiles)) break;
    push(row.file, row.score, row.reasons, row.hitLines, "seed");
    if (selected.length >= Math.min(5, maxFiles)) break;
  }
  for (const rel of relations) {
    const row = scored.find((candidate) => candidate.file.path === rel.file.path);
    push(rel.file, Math.max(1, (row?.score ?? 0) + (rel.relation === "dependency" ? 12 : 8)), [rel.relation === "dependency" ? "候选文件依赖" : "候选文件调用方"], row?.hitLines ?? [], rel.relation);
  }
  let rendered = renderPlan(query, map, selected, budgetTokens, variant);
  while (estimateTokens(rendered) > budgetTokens && selected.length > 1) {
    selected.pop();
    rendered = renderPlan(query, map, selected, budgetTokens, variant);
  }
  if (estimateTokens(rendered) > budgetTokens && selected.length) {
    selected[0] = { ...selected[0], excerpt: selected[0].excerpt.split(/\r?\n/).slice(0, 8).join("\n") };
    rendered = renderPlan(query, map, selected, budgetTokens, variant);
  }
  return {
    version: 1,
    variant,
    query,
    budgetTokens,
    estimatedTokens: estimateTokens(rendered),
    indexedFiles: map.files.length,
    repoTruncated: map.truncated,
    selected,
    rendered,
    durationMs: Date.now() - started,
  };
}

/** Whether a message is an injected Context Planner fragment from a previous run. */
export function isContextPlannerMessage(content: string | undefined): boolean {
  return Boolean(content?.includes(PLAN_MARKER_PREFIX));
}
