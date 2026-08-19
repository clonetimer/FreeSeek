/**
 * 简短闲聊/问候判定与任务标题派生（纯逻辑，零依赖，可独立单测）。
 * 从 prompts.ts 拆出：prompts.ts 依赖 providers（vscode），
 * 而这里只关心"一句话是不是闲聊"与"一句话的短标题"。
 */

/** 含任一触发词即视为"需要工具/上下文"的正式请求，不走快速问答（避免误把"看下报错"当闲聊） */
const CHITCHAT_TOOL_TRIGGER =
  /(文件|目录|搜索|查找|找|改|读|看|解析|分析|运行|执行|命令|报错|错误|代码|项目|工作区|workspace|写|创建|新建|删除|修复|优化|重构|检查|测试|构建|依赖|安装|配置|git|路径|path|file|dir|read|write|edit|search|grep|list|脚本|函数|类|结构|内容|查看|启动|停止)/i;

/** 判定用户消息是否为"简短闲聊/问候"：短消息且不含工具触发词 → 走快速问答模式 */
export function isChitChat(text: string): boolean {
  const t = (text || "").trim();
  if (!t) return false;
  if (t.length > 60) return false; // 长文本多半是需求描述，保持完整工具能力
  if (CHITCHAT_TOOL_TRIGGER.test(t)) return false;
  return true;
}

/** 从用户消息派生任务清单自动种子的简短标题：去代码块/标记符号、压缩空白、截断。 */
export function summarizeTaskText(text: string, max = 44): string {
  const clean = (text || "")
    .replace(/```[\s\S]*?```/g, "代码块")
    .replace(/`[^`]*`/g, "")
    .replace(/[#>*_~|]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!clean) return "执行任务";
  return clean.length > max ? clean.slice(0, max - 1).trimEnd() + "…" : clean;
}
