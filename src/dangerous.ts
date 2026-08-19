/**
 * 危险命令检测（唯一来源，供 sandbox.ts 与 hooks.ts 共用）。
 *
 * 两条防线覆盖刻意不同（纵深防御，避免误伤）：
 *  - DANGEROUS_PATTERNS（L2 硬阻断，hooks.ts preToolUse）：文本扫描宁可多拦
 *    （含 SQL 破坏、管道下载执行等）；命中后模型可改走安全方式，或经
 *    allowRules 显式放行；
 *  - CATASTROPHIC_PATTERNS（off 档兜底，sandbox.ts）：用户已明确选择
 *    「原样执行」，只拦灾难性命令，避免把 `dd if=x of=y`、`delete from ... where`
 *    等合法命令一并误杀。
 *
 * 修改任一清单时必须评估另一条是否同步（见 AGENTS.md 安全改动纪律）。
 */

/** L2 硬阻断：危险命令文本模式（命中即 block，模型可协商绕过）。 */
export const DANGEROUS_PATTERNS: RegExp[] = [
  /rm\s+-rf\s+[\/~]/i,
  /rm\s+-rf\s+[~.](\s|$)/i,
  /rm\s+-rf\s+--\s+no-preserve-root/i,
  /git\s+push\s+(--force|-f)\b/i,
  /git\s+push\s+\S+\s+\S+\s+--force/i,
  /\bgit\s+reset\s+--hard\b/i,
  /\bgit\s+clean\s+-\w*f\w*d/i,
  /\bdrop\s+table\b/i,
  /delete\s+from\s+\w+\s*;(?!\s*where)/i,
  /\bmkfs\b/i,
  /dd\s+if=/i,
  /:\s*\(\)\s*\{\s*:\s*\|\s*:\s*&\s*.*\}/,
  />\s*\/dev\/sd[a-z]/i,
  /chmod\s+-R\s+777\s+\//i,
  /\b(shutdown|reboot|poweroff|halt)(\s|$)/i,
  /(curl|wget|aria2c)\s+[^|;]*\s\|\s*(sudo\s+)?(sh|bash)\b/i,
  /\bformat\s+[a-z]:/i,
  /\b(rd|rmdir)\s+(\/[a-z]\s*)+\s*[a-z]:\\/i,
];

/** off 档兜底：灾难性命令（绝对要拦，但不过度误伤合法操作）。 */
export const CATASTROPHIC_PATTERNS: RegExp[] = [
  /\brm\s+-rf\s+\//,
  /\brm\s+-rf\s+[~.](\s|$)/,
  /\brd\s+\/s\s+\//,
  /\b(rd|rmdir)\s+(\/[a-z]\s*)+\s*[a-z]:\\/,
  /\bgit\s+push\b.*--force/,
  /\bgit\s+clean\s+-\w*f\w*d/,
  /\bgit\s+reset\s+--hard\b/,
  /\bsudo\s+rm\b/,
  /:\s*\(\)\s*\{/, // fork bomb 常以命令开头（:(){…），\b 前缀会漏拦，故不设边界
  /\bmkfs\b/,
  /\bdd\s+if=[^|;]*of=\/dev\//,
  /\b(shutdown|reboot|poweroff|halt)(\s|$)/,
  /\bformat\s+[a-z]:/i,
  /(curl|wget|aria2c)\s+[^|;]*\s\|\s*(sudo\s+)?(sh|bash)\b/,
];

/** 命令是否为灾难性高危命令（off 档兜底拦截，命中即拒绝执行）。 */
export function isDestructiveCommand(cmd: string): boolean {
  const c = cmd.toLowerCase(); // 与 L2 不同，off 档清单不带 /i，这里统一小写再匹配
  return CATASTROPHIC_PATTERNS.some((re) => re.test(c));
}
