import { resolveActiveConfig, resolveConfigFor } from "./providers";
import type { ModelOverride, TaskProfile } from "./providers";
import { completeResponsesText } from "./provider-responses";
import { debugLogAux } from "./debug";

/**
 * 非流式摘要调用（供上下文压缩使用）。
 * 免费服务（deepseek-free-api）主要支持流式；若其不支持非流式，将返回空字符串，
 * 调用方需退化为启发式压缩（见 context.ts）。
 */
export async function summarizeConversation(text: string, override?: ModelOverride): Promise<string> {
  let cfg;
  try {
    // 摘要 = 推理任务：Auto 模式下优先 flagship/pro 档；显式覆盖走指定模型
    cfg = override ? resolveConfigFor(override, "reason") : resolveActiveConfig("reason");
  } catch {
    return "";
  }
  try {
    if (cfg.format === "responses") {
      return await completeResponsesText(cfg, [
        {
          role: "system",
          content:
            "你是上下文压缩模块。请将以下编程助手对话历史压缩为结构化摘要，严格保留所有关键决策、文件路径、函数/类名、未完成任务与重要事实。用中文，按以下小标题分节（无内容则省略该节）：\n" +
            "## 目标\n## 关键决策\n## 代码改动\n## 待办事项\n## 风险与未决问题\n" +
            "若历史以代码为主，务必保留文件路径与符号名；不要编造未出现的内容。",
        },
        { role: "user", content: text },
      ], { temperature: 0.2 });
    }
    const res = await fetch(cfg.endpoint, {
      method: "POST",
      headers: cfg.headers,
      body: JSON.stringify({
        model: cfg.model,
        stream: false,
        temperature: 0.2,
        messages: [
          {
            role: "system",
            content:
              "你是上下文压缩模块。请将以下编程助手对话历史压缩为结构化摘要，严格保留所有关键决策、文件路径、函数/类名、未完成任务与重要事实。用中文，按以下小标题分节（无内容则省略该节）：\n" +
              "## 目标\n## 关键决策\n## 代码改动\n## 待办事项\n## 风险与未决问题\n" +
              "若历史以代码为主，务必保留文件路径与符号名；不要编造未出现的内容。",
          },
          { role: "user", content: text },
        ],
      }),
    });
    if (!res.ok) {
      debugLogAux("summarizeConversation", cfg.endpoint, false, `HTTP ${res.status}`);
      return "";
    }
    const j = await res.json();
    return j?.choices?.[0]?.message?.content ?? "";
  } catch (e: any) {
    debugLogAux("summarizeConversation", cfg.endpoint, false, e?.message ?? String(e));
    return "";
  }
}

/**
 * 非流式「持久记忆抽取」调用（供上下文压缩时自动固化重要信息）。
 * 从将被压缩的对话历史中，提取值得长期记住的持久事实（用户偏好、项目约定、
 * 关键技术决策、文件/模块架构、未决问题、踩过的坑）。失败（无 Key、服务不可用、
 * 本地模型不配合）时返回空字符串，调用方静默跳过——保证压缩主流程不依赖此步。
 */
export async function extractMemoryFacts(text: string): Promise<string> {
  let cfg;
  try {
    cfg = resolveActiveConfig();
  } catch {
    return "";
  }
  try {
    if (cfg.format === "responses") {
      return await completeResponsesText(cfg, [
        {
          role: "system",
          content:
            "你是记忆抽取模块。从以下将被压缩的对话历史中，提取值得长期记住的持久事实：用户偏好与习惯、项目约定、关键技术决策、文件/模块架构、未决问题、踩过的坑。每条以 [记忆] 开头写一行，只输出 [记忆] 行，不要其他解释。若没有值得记住的，只输出 [NO_MEMORY]。",
        },
        { role: "user", content: text },
      ], { temperature: 0.2 });
    }
    const res = await fetch(cfg.endpoint, {
      method: "POST",
      headers: cfg.headers,
      body: JSON.stringify({
        model: cfg.model,
        stream: false,
        temperature: 0.2,
        messages: [
          {
            role: "system",
            content:
              "你是记忆抽取模块。从以下将被压缩的对话历史中，提取值得长期记住的持久事实：用户偏好与习惯、项目约定、关键技术决策、文件/模块架构、未决问题、踩过的坑。每条以 [记忆] 开头写一行，只输出 [记忆] 行，不要其他解释。若没有值得记住的，只输出 [NO_MEMORY]。",
          },
          { role: "user", content: text },
        ],
      }),
    });
    if (!res.ok) {
      debugLogAux("extractMemoryFacts", cfg.endpoint, false, `HTTP ${res.status}`);
      return "";
    }
    const j = await res.json();
    return j?.choices?.[0]?.message?.content ?? "";
  } catch (e: any) {
    debugLogAux("extractMemoryFacts", cfg.endpoint, false, e?.message ?? String(e));
    return "";
  }
}

/**
 * 非流式「自我审视」调用（供 Layer 2 OnStop 反思 hook 使用）。
 * 让模型回顾本次会话，输出是否需要固化规则 / 新建技能的建议。
 * 失败（无 Key、服务不可用）时返回空字符串，调用方静默跳过。
 */
export async function reflectConversation(prompt: string): Promise<string> {
  let cfg;
  try {
    cfg = resolveActiveConfig();
  } catch {
    return "";
  }
  if (!cfg.apiKey) return "";
  try {
    if (cfg.format === "responses") {
      return await completeResponsesText(cfg, [
        {
          role: "system",
          content:
            "你是编程智能体的自我审视模块。基于给定会话片段，用中文简洁输出：是否反复犯错、用户是否反复纠正、是否有高频操作可做成技能。严格按要求的格式输出。",
        },
        { role: "user", content: prompt },
      ], { temperature: 0.3 });
    }
    const res = await fetch(cfg.endpoint, {
      method: "POST",
      headers: cfg.headers,
      body: JSON.stringify({
        model: cfg.model,
        stream: false,
        temperature: 0.3,
        messages: [
          {
            role: "system",
            content:
              "你是编程智能体的自我审视模块。基于给定会话片段，用中文简洁输出：是否反复犯错、用户是否反复纠正、是否有高频操作可做成技能。严格按要求的格式输出。",
          },
          { role: "user", content: prompt },
        ],
      }),
    });
    if (!res.ok) {
      debugLogAux("reflectConversation", cfg.endpoint, false, `HTTP ${res.status}`);
      return "";
    }
    const j = await res.json();
    return j?.choices?.[0]?.message?.content ?? "";
  } catch (e: any) {
    debugLogAux("reflectConversation", cfg.endpoint, false, e?.message ?? String(e));
    return "";
  }
}

