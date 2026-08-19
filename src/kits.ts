import * as fs from "fs";
import * as path from "path";

/**
 * 专家套件（Expert Kit）安装器——对标 QwenWork 专家套件 / Claude Code plugin 分发。
 *
 * 一个套件 = 根目录 plugin.json 清单 + skills/ + commands/ + agents/ 三个可选目录。
 * 安装时把内容落到项目约定目录，使 SkillManager / loadCommands / rolePresets 自动识别：
 *   - skills/<name>/SKILL.md → <root>/.agent/skills/<name>/SKILL.md
 *   - commands/<name>.md     → <root>/.agent/commands/<name>.md
 *   - agents/<name>.md       → <root>/.agent/agents/<name>.md
 * 从而让「单个 Skill 验证通过」后可打包成套件做团队分发（递进关系）。
 *
 * 可逆性（对齐 Cordis 论文「可逆效应」）：installKit 返回 installed 文件清单并登记
 * kits.json 注册表，uninstallKit 依据清单删除，构成安装-卸载闭环。
 */

export interface KitManifest {
  name: string;
  version?: string;
  description?: string;
  author?: string;
  /** 依赖的其他技能/套件名（安装时校验缺失，不阻塞）。 */
  requires?: string[];
  skills?: Array<{ name: string }>;
  commands?: Array<{ name: string }>;
  agents?: Array<{ name: string }>;
}

export function parseKitManifest(json: string): KitManifest | null {
  try {
    const d = JSON.parse(json);
    if (!d || typeof d.name !== "string" || !d.name.trim()) return null;
    const pick = (arr: any, key: keyof KitManifest) =>
      Array.isArray(d[key])
        ? d[key]
            .map((x: any) => ({ name: String(x?.name ?? "").trim() }))
            .filter((x: { name: string }) => x.name)
        : [];
    const req = Array.isArray(d.requires)
      ? d.requires.map((x: any) => String(x).trim()).filter(Boolean)
      : typeof d.requires === "string"
        ? d.requires.split(",").map((x: string) => x.trim()).filter(Boolean)
        : [];
    return {
      name: String(d.name).trim(),
      version: d.version ? String(d.version) : undefined,
      description: d.description ? String(d.description) : undefined,
      author: d.author ? String(d.author) : undefined,
      requires: req.length ? req : undefined,
      skills: pick(d, "skills"),
      commands: pick(d, "commands"),
      agents: pick(d, "agents"),
    };
  } catch {
    return null;
  }
}

export interface KitInstallResult {
  manifest: string;
  skills: number;
  commands: number;
  agents: number;
  /** 实际复制到的目标文件绝对路径清单（供 uninstallKit 逆操作）。 */
  installed: string[];
  /** 本次覆盖的已存在文件（同名冲突报告）。 */
  overwritten: string[];
  /** 声明 requires 但缺失的依赖（不阻塞安装，仅告警）。 */
  missingRequires: string[];
  summary: string;
}

/** 套件注册表条目：记录一次安装的文件清单与元数据，供卸载与清单查询。 */
export interface KitRecord {
  name: string;
  version?: string;
  installedAt: string;
  /** 相对项目根的已安装文件路径（POSIX 分隔符）。 */
  files: string[];
}

/** 套件注册表（落盘 <root>/.agent/kits.json）：显式记录「装了哪些扩展」。 */
export interface KitRegistry {
  version: 1;
  kits: Record<string, KitRecord>;
}

const REGISTRY_RELPATH = path.join(".agent", "kits.json");

/** 读套件注册表（不存在/损坏返回空注册表）。 */
export function readKitRegistry(projectRoot: string): KitRegistry {
  const reg: KitRegistry = { version: 1, kits: {} };
  try {
    const raw = fs.readFileSync(path.join(projectRoot, REGISTRY_RELPATH), "utf8");
    const d = JSON.parse(raw);
    if (d && typeof d === "object" && d.kits && typeof d.kits === "object") {
      for (const [name, rec] of Object.entries(d.kits as Record<string, any>)) {
        if (!rec || typeof rec !== "object") continue;
        reg.kits[name] = {
          name: typeof rec.name === "string" ? rec.name : name,
          version: typeof rec.version === "string" ? rec.version : undefined,
          installedAt: typeof rec.installedAt === "string" ? rec.installedAt : "",
          files: Array.isArray(rec.files) ? rec.files.map((f: any) => String(f)).filter(Boolean) : [],
        };
      }
    }
  } catch {
    // 注册表缺失或损坏 → 视为空
  }
  return reg;
}

/** 写套件注册表（尽力而为，失败不影响安装主流程）。 */
export function writeKitRegistry(projectRoot: string, reg: KitRegistry): void {
  try {
    const p = path.join(projectRoot, REGISTRY_RELPATH);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(reg, null, 2), "utf8");
  } catch {
    // 忽略写失败
  }
}

/** 列出已安装套件（读注册表）。 */
export function listInstalledKits(projectRoot: string): KitRecord[] {
  const reg = readKitRegistry(projectRoot);
  return Object.values(reg.kits).sort((a, b) => a.name.localeCompare(b.name));
}

/** 检查套件声明的依赖技能是否已存在（项目技能目录或注册表已装套件）。 */
function missingRequiresOf(projectRoot: string, mf: KitManifest, reg: KitRegistry): string[] {
  const missing: string[] = [];
  for (const req of mf.requires ?? []) {
    const asSkill = fs.existsSync(path.join(projectRoot, ".agent", "skills", req, "SKILL.md"));
    const asKit = !!reg.kits[req];
    if (!asSkill && !asKit) missing.push(req);
  }
  return missing;
}

/** 安装套件到项目：把清单声明的技能/命令/角色复制到项目约定目录（幂等覆盖），并登记注册表。 */
export function installKit(kitDir: string, projectRoot: string): KitInstallResult | null {
  const mfPath = path.join(kitDir, "plugin.json");
  if (!fs.existsSync(mfPath)) return null;
  const mf = parseKitManifest(fs.readFileSync(mfPath, "utf8"));
  if (!mf) return null;

  const installed: string[] = [];
  const overwritten: string[] = [];
  const copyIfExists = (src: string, dst: string): boolean => {
    if (!fs.existsSync(src)) return false;
    const existed = fs.existsSync(dst);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
    installed.push(dst);
    if (existed) overwritten.push(dst);
    return true;
  };

  let nS = 0;
  for (const s of mf.skills ?? []) {
    if (copyIfExists(path.join(kitDir, "skills", s.name, "SKILL.md"), path.join(projectRoot, ".agent", "skills", s.name, "SKILL.md"))) nS++;
  }
  let nC = 0;
  for (const c of mf.commands ?? []) {
    if (copyIfExists(path.join(kitDir, "commands", `${c.name}.md`), path.join(projectRoot, ".agent", "commands", `${c.name}.md`))) nC++;
  }
  let nA = 0;
  for (const a of mf.agents ?? []) {
    if (copyIfExists(path.join(kitDir, "agents", `${a.name}.md`), path.join(projectRoot, ".agent", "agents", `${a.name}.md`))) nA++;
  }

  // 登记注册表（含依赖校验）
  const reg = readKitRegistry(projectRoot);
  const missingRequires = missingRequiresOf(projectRoot, mf, reg);
  if (installed.length) {
    reg.kits[mf.name] = {
      name: mf.name,
      version: mf.version,
      installedAt: new Date().toISOString(),
      files: installed.map((f) => path.relative(projectRoot, f).split(path.sep).join("/")),
    };
    writeKitRegistry(projectRoot, reg);
  }

  const depNote = missingRequires.length ? ` 缺少依赖：${missingRequires.join("、")}（不影响本次安装）。` : "";
  const ovwNote = overwritten.length ? ` 覆盖已有文件 ${overwritten.length} 个。` : "";
  const summary = `已安装套件「${mf.name}」：技能 ${nS} / 命令 ${nC} / 子代理角色 ${nA}。${ovwNote}${depNote}`;
  return { manifest: mf.name, skills: nS, commands: nC, agents: nA, installed, overwritten, missingRequires, summary };
}

/**
 * 卸载套件（逆操作）：依据注册表删除该套件安装的文件并移除登记。
 * 只删注册表登记过的文件（相对路径限制在项目内），不触碰用户自建内容。
 */
export function uninstallKit(projectRoot: string, kitName: string): { ok: boolean; message: string; removed: string[] } {
  const reg = readKitRegistry(projectRoot);
  const rec = reg.kits[kitName];
  if (!rec) {
    return { ok: false, message: `未找到已安装套件「${kitName}」的登记（kits.json）。`, removed: [] };
  }
  const removed: string[] = [];
  const agentRootAbs = path.resolve(projectRoot, ".agent");
  for (const rel of rec.files) {
    // 注册表存相对项目根路径：先解析到项目根，再收紧到 <root>/.agent/ 安装范围，
    // 杜绝越界删除项目内用户自建文件（如 ../user-kept.txt、user-kept.txt）。
    const abs = path.resolve(projectRoot, rel);
    if (!abs.startsWith(agentRootAbs + path.sep)) continue;
    try {
      fs.rmSync(abs, { force: true });
      removed.push(rel);
    } catch {
      // 单个文件删除失败不阻断
    }
  }
  delete reg.kits[kitName];
  writeKitRegistry(projectRoot, reg);
  return { ok: removed.length > 0, message: `已卸载套件「${kitName}」，删除 ${removed.length} 个文件。`, removed };
}
