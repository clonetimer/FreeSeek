import * as path from "path";

/**
 * Layer 5: Code Intelligence（代码智能层）——符号级搜索。
 *
 * 中小型代码库（<10 万行）默认用 agentic search（grep/read/ls，见 tools.ts），
 * 但当工作区已为该语言激活相应 Language Server 时，本模块通过 VS Code 内建的
 * LSP 桥接命令提供「语义级」检索：跳转到定义、查找全部引用、列出文档符号、
 * 工作区符号搜索。相比 grep 按字符串匹配，LSP 返回的是精确的语法位置，
 * 且消耗更少的上下文（直接给位置，不必读一整屏文件）。
 *
 * 这是「Agent 的眼睛」——精准定位而非大海捞针。
 * 与 Claude Code 的 Plugin/LSP 能力、Codex/Cursor 的「IO: lsp」工具组对齐
 * （见 Lilian Weng《Harness Engineering》工具趋同观察）。
 */

export type LspAction =
  | "definition"
  | "references"
  | "documentSymbols"
  | "workspaceSymbols";

export interface LspRequest {
  action: LspAction;
  /** 文件绝对或相对路径（definition/references/documentSymbols 需要） */
  file?: string;
  /** 1-based 行号 */
  line?: number;
  /** 1-based 列号 */
  character?: number;
  /** workspaceSymbols 的查询串 */
  query?: string;
}

interface SimpleLoc {
  file: string;
  line: number;
  character: number;
}

/** 把 VS Code 的 Location / LocationLink / SymbolInformation.location 统一成简单位置。 */
function locFromAny(x: any): SimpleLoc | null {
  if (!x) return null;
  // LocationLink（go-to 常用，含 targetUri/targetRange）
  if (x.targetUri) {
    const r = x.targetRange ?? x.targetSelectionRange;
    return {
      file: x.targetUri.fsPath ?? String(x.targetUri.path ?? x.targetUri),
      line: (r?.start?.line ?? 0) + 1,
      character: (r?.start?.character ?? 0) + 1,
    };
  }
  // Location（含 uri/range）
  if (x.uri) {
    const r = x.range;
    return {
      file: x.uri.fsPath ?? String(x.uri.path ?? x.uri),
      line: (r?.start?.line ?? 0) + 1,
      character: (r?.start?.character ?? 0) + 1,
    };
  }
  return null;
}

// SymbolKind 名称（VS Code 枚举值 -> 人类可读）
const KIND_NAMES: Record<number, string> = {
  1: "File", 2: "Module", 3: "Namespace", 4: "Package", 5: "Class",
  6: "Method", 7: "Property", 8: "Field", 9: "Constructor", 10: "Enum",
  11: "Interface", 12: "Function", 13: "Variable", 14: "Constant",
  15: "String", 16: "Number", 17: "Boolean", 18: "Array", 19: "Object",
  20: "Key", 21: "Null", 22: "EnumMember", 23: "Struct", 24: "Event",
  25: "Operator", 26: "TypeParameter",
};

function kindName(k: number | undefined): string {
  return k === undefined ? "" : KIND_NAMES[k] ?? String(k);
}

function resolveUri(absOrRel: string, workspaceRoot: string, vscode: typeof import("vscode")): import("vscode").Uri {
  const abs = path.isAbsolute(absOrRel)
    ? absOrRel
    : path.resolve(workspaceRoot, absOrRel);
  return vscode.Uri.file(abs);
}

export async function runLsp(req: LspRequest, workspaceRoot: string): Promise<string> {
  try {
    if (req.action === "definition" || req.action === "references") {
      if (!req.file) return "⚠️ 缺少 file 参数。";
      const vscode = require("vscode") as typeof import("vscode");
      const uri = resolveUri(req.file, workspaceRoot, vscode);
      const pos = new vscode.Position((req.line ?? 1) - 1, (req.character ?? 1) - 1);
      const cmd =
        req.action === "definition"
          ? "vscode.executeDefinitionProvider"
          : "vscode.executeReferenceProvider";
      const res = await vscode.commands.executeCommand<any[]>(cmd, uri, pos);
      if (!res || res.length === 0) {
        return (
          `（当前语言服务器未返回${req.action === "definition" ? "定义" : "引用"}。` +
          `可能该语言没有可用 LSP，或该文件尚未被 VS Code 打开/索引。` +
          `可改用 grep / search_files 做字符串检索，或先打开该文件激活 Language Server。）`
        );
      }
      const locs = res.map(locFromAny).filter(Boolean) as SimpleLoc[];
      const header = req.action === "definition" ? "定义位置" : "引用位置";
      return `${header}（共 ${locs.length} 处）：\n` +
        locs.map((l) => `- ${l.file}:${l.line}:${l.character}`).join("\n");
    }

    if (req.action === "documentSymbols") {
      if (!req.file) return "⚠️ 缺少 file 参数。";
      const vscode = require("vscode") as typeof import("vscode");
      const uri = resolveUri(req.file, workspaceRoot, vscode);
      const res = await vscode.commands.executeCommand<any[]>(
        "vscode.executeDocumentSymbolProvider",
        uri
      );
      if (!res || res.length === 0) {
        return "（该文件未返回符号表，可能无可用 LSP 或未打开。）";
      }
      return "文档符号结构：\n" + formatSymbols(res);
    }

    if (req.action === "workspaceSymbols") {
      const vscode = require("vscode") as typeof import("vscode");
      const q = req.query ?? "";
      const res = await vscode.commands.executeCommand<any[]>(
        "vscode.executeWorkspaceSymbolProvider",
        q
      );
      if (!res || res.length === 0) {
        return `（工作区未返回与「${q}」匹配的符号。可改用 grep 检索字符串，或先等待工作区索引完成。）`;
      }
      const top = res.slice(0, 80);
      return `工作区符号（匹配 ${res.length} 个，显示前 ${top.length}）：\n` +
        top
          .map((s: any) => {
            const loc = locFromAny(s.location ?? s);
            const kind = kindName(s.kind);
            const container = s.containerName ? ` (${s.containerName})` : "";
            const at = loc ? ` → ${loc.file}:${loc.line}:${loc.character}` : "";
            return `- ${kind} ${s.name}${container}${at}`;
          })
          .join("\n");
    }

    return "⚠️ 未知 LSP 动作。";
  } catch (e: any) {
    return `LSP 查询出错：${e?.message ?? String(e)}`;
  }
}

/** 递归格式化 DocumentSymbol（含 children 层级）。 */
function formatSymbols(symbols: any[], indent = ""): string {
  const lines: string[] = [];
  for (const s of symbols) {
    const kind = kindName(s.kind);
    const r = s.range?.start;
    const at = r ? `:${r.line + 1}:${r.character + 1}` : "";
    lines.push(`${indent}- ${kind} ${s.name}${at}`);
    if (Array.isArray(s.children) && s.children.length) {
      lines.push(formatSymbols(s.children, indent + "  "));
    }
  }
  return lines.join("\n");
}
