import * as fs from "fs";
import * as path from "path";
import type { ChatMessage, ToolCall } from "./provider";
import { ContentAddressedStore, type ContentBlobRef } from "./content-store";
import { assertSafeSessionId } from "./session-id";
import { appendSessionEventIndex, deleteSessionEventIndex, ensureSessionEventIndex, queryIndexedSessionEvents, type SessionEventIndexQuery } from "./event-index";

/**
 * Append-only Session Event Log。
 *
 * 设计约束：
 * - 每个 session 独立实例，不因 UI 切换而把后台 Agent 的事件串到别的会话；
 * - seq 从已有文件续写，扩展重启后仍保持单调；
 * - actor 区分 main / subagent，未来 replay/fork 可只投影某一执行流；
 * - canonical message 事件保存模型可见的文本/tool 消息投影。
 *
 * 多模态内容通过 content-addressed SHA-256 blob store 保存；JSONL 只记录摘要引用。
 * 读取时会校验并恢复图片，缺失/损坏则把 projection 标记为 incomplete。
 */

export interface LoggedMessageData {
  message: ChatMessage;
  imageCount: number;
  replayable: boolean;
  imageRefs?: ContentBlobRef[];
}

export interface ConversationSnapshotData {
  messages: ChatMessage[];
  complete: boolean;
  reason: string;
  imageRefs?: Array<{ index: number; refs: ContentBlobRef[] }>;
}

export interface SessionEventDataMap {
  session_start: { resumed?: boolean };
  session_end: { reason?: string };
  session_title: { title: string };
  "conversation/snapshot": ConversationSnapshotData;
  "system/message": { message: ChatMessage };
  "user/message": LoggedMessageData & { edited?: boolean };
  "assistant/message": { message: ChatMessage; step?: number };
  "tool/message": { message: ChatMessage; name: string };
  "tool/call": { callId?: string; name: string; args: unknown };
  "tool/result": { callId?: string; name: string; result: string; blocked?: string; timedOut?: boolean; durationMs?: number };
  "presentation/file_evidence": {
    callId: string;
    evidenceId: string;
    file: string;
    path: string;
    kind: "read" | "create" | "write" | "edit" | "delete";
    added?: number;
    removed?: number;
    original?: string;
    applied?: string;
    deliverable: boolean;
  };
  "approval/request": { callId?: string; name: string; category: "tool" | "mcp"; args?: unknown };
  "approval/result": { callId?: string; name: string; category: "tool" | "mcp"; allow: boolean; persist?: string; reason?: string };
  tool_timeout: { name: string; timeoutMs: number };
  "extension/lease": { leaseId: string; generations: Array<{ id: string; generation: number; version: string }> };
  "extension/release": { leaseId: string; generations: Array<{ id: string; generation: number; version: string }> };
  "turn/start": { turnId: string; messageCount: number; startedAt: number };
  "turn/end": { turnId: string; reason: "completed" | "budget" | "aborted" | "error"; steps: number; endedAt: number; error?: string };
  "step/start": { turnId: string; step: number; messageCount: number; tokens: number };
  "step/end": { turnId: string; step: number; toolCalls: number; finishReason?: string; error?: string };
  "model/request": { turnId: string; step: number; attempt: number; provider: string; model: string; messageCount: number; toolCount: number; startedAt: number };
  "model/result": { turnId: string; step: number; attempt: number; provider: string; model: string; durationMs: number; promptTokens: number; completionTokens: number; totalTokens: number; finishReason?: string; error?: string };
  checkpoint: { hash: string; label: string; workspaceRoot: string; kind: "auto" | "manual"; eventSeq?: number };
  "session/fork": { sourceSessionId: string; boundarySeq: number; checkpointHash?: string; checkpointSeq?: number };
  compact: Record<string, unknown>;
  subagent: Record<string, unknown>;
  subagents: Record<string, unknown>;
  send_message: Record<string, unknown>;
  prompt_manifest: Record<string, unknown>;
  // legacy 兼容：旧日志已存在这些事件；新代码逐步迁移到 canonical message 事件。
  user: Record<string, unknown>;
  assistant: Record<string, unknown>;
  tool_start: Record<string, unknown>;
  tool_result: Record<string, unknown>;
}

export interface SessionEvent<T extends string = string> {
  seq: number;
  ts: string;
  type: T;
  sessionId: string;
  actor?: string;
  data?: unknown;
  /** 大事件的 sidecar JSON 相对路径；readSessionEvents 会自动解析回 data。 */
  dataRef?: string;
}

export interface SessionEventSink {
  readonly sessionId: string;
  append<T extends keyof SessionEventDataMap>(
    type: T,
    data: SessionEventDataMap[T],
    actor?: string
  ): SessionEvent<T> | null;
  append(type: string, data?: unknown, actor?: string): SessionEvent | null;
  readonly lastSeq: number;
  persistMessage(message: ChatMessage): LoggedMessageData;
  persistConversation(messages: readonly ChatMessage[]): Omit<ConversationSnapshotData, "reason">;
}


/** 兼容旧导入路径：durable session id 校验实现已收敛到 session-id.ts。 */
export { assertSafeSessionId } from "./session-id";

/** 单条 JSONL 上限。canonical tool result 已先过 Runtime 截断，通常远低于此值。 */
const MAX_LINE = 200_000;

function maxSeqInFile(filePath: string): number {
  if (!fs.existsSync(filePath)) return 0;
  let max = 0;
  try {
    for (const line of fs.readFileSync(filePath, "utf8").split("\n")) {
      const t = line.trim();
      if (!t) continue;
      try {
        const event = JSON.parse(t) as SessionEvent;
        if (Number.isInteger(event.seq) && event.seq > max) max = event.seq;
      } catch {
        // 损坏行不阻断恢复；后续 seq 从最后有效最大值继续。
      }
    }
  } catch {
    return 0;
  }
  return max;
}

/** 单个会话的 append-only durable event journal。 */
export class SessionEventLog implements SessionEventSink {
  private seq: number;
  private readonly filePath: string;
  private readonly dir: string;
  private closed = false;
  private readonly contentStore: ContentAddressedStore;

  constructor(
    public readonly sessionId: string,
    dir: string
  ) {
    assertSafeSessionId(sessionId);
    fs.mkdirSync(dir, { recursive: true });
    this.dir = dir;
    this.filePath = path.join(dir, `events-${sessionId}.jsonl`);
    this.contentStore = new ContentAddressedStore(path.join(dir, "content-blobs"));
    try {
      const indexed = ensureSessionEventIndex(dir, sessionId);
      this.seq = indexed.reduce((max, row) => row.valid && row.seq ? Math.max(max, row.seq) : max, 0);
    } catch {
      this.seq = maxSeqInFile(this.filePath);
    }
  }

  get path(): string {
    return this.filePath;
  }

  get lastSeq(): number {
    return this.seq;
  }

  /** 把多模态消息持久化为 canonical message + content-addressed refs。 */
  persistMessage(message: ChatMessage): LoggedMessageData {
    return messageForEventLog(message, this.contentStore);
  }

  /** 把当前模型上下文持久化为可完整恢复的 snapshot（blob 缺失时 complete=false）。 */
  persistConversation(messages: readonly ChatMessage[]): Omit<ConversationSnapshotData, "reason"> {
    return conversationForEventLog(messages, this.contentStore);
  }

  /** 记录 session_end 后永久关闭当前实例；已捕获该 sink 的后台任务后续 append 会 fail-closed。 */
  close(reason = "end"): void {
    if (this.closed) return;
    this.append("session_end", { reason });
    this.closed = true;
  }

  append<T extends keyof SessionEventDataMap>(
    type: T,
    data: SessionEventDataMap[T],
    actor?: string
  ): SessionEvent<T> | null;
  append(type: string, data?: unknown, actor?: string): SessionEvent | null;
  append(type: string, data?: unknown, actor = "main"): SessionEvent | null {
    if (this.closed) return null;
    try {
      const entry: SessionEvent = {
        seq: ++this.seq,
        ts: new Date().toISOString(),
        type,
        sessionId: this.sessionId,
        actor,
        data,
      };
      let line = JSON.stringify(entry);
      if (line.length > MAX_LINE) {
        try {
          const blobDir = path.join(this.dir, "event-blobs", this.sessionId);
          fs.mkdirSync(blobDir, { recursive: true });
          const blobName = `${entry.seq}.json`;
          const blobPath = path.join(blobDir, blobName);
          const payload = JSON.stringify(data ?? null);
          fs.writeFileSync(blobPath, payload, "utf8");
          entry.data = { external: true, bytes: Buffer.byteLength(payload, "utf8") };
          entry.dataRef = path.relative(this.dir, blobPath).replace(/\\/g, "/");
          line = JSON.stringify(entry);
        } catch {
          entry.data = { truncated: true, hint: "事件过大且 sidecar 写入失败；请查看 session snapshot/offload。" };
          line = JSON.stringify(entry);
        }
      }
      const serialized = line + "\n";
      const offset = fs.existsSync(this.filePath) ? fs.statSync(this.filePath).size : 0;
      fs.appendFileSync(this.filePath, serialized, "utf8");
      const bytes = Buffer.byteLength(serialized, "utf8");
      appendSessionEventIndex(this.dir, this.sessionId, entry, offset, bytes, offset + bytes);
      return entry;
    } catch {
      // event log 仍是审计/回放层；写盘异常暂不让用户任务崩溃，但调用方可通过 null 观测。
      return null;
    }
  }
}

/** 回放：按文件顺序读取有效事件；损坏行跳过。 */
export function readSessionEvents(dir: string, sessionId: string): SessionEvent[] {
  assertSafeSessionId(sessionId);
  const fp = path.join(dir, `events-${sessionId}.jsonl`);
  const contentStore = new ContentAddressedStore(path.join(dir, "content-blobs"));
  if (!fs.existsSync(fp)) return [];
  const out: SessionEvent[] = [];
  try {
    for (const line of fs.readFileSync(fp, "utf8").split("\n")) {
      const t = line.trim();
      if (!t) continue;
      try {
        const event = JSON.parse(t) as SessionEvent;
        if (event.sessionId !== sessionId || !Number.isInteger(event.seq)) continue;
        if (event.dataRef) {
          try {
            const refPath = path.resolve(dir, event.dataRef);
            const rel = path.relative(dir, refPath);
            if (rel === ".." || rel.startsWith(".." + path.sep) || path.isAbsolute(rel)) {
              throw new Error("event dataRef 越界");
            }
            event.data = JSON.parse(fs.readFileSync(refPath, "utf8"));
          } catch {
            event.data = { unavailable: true, dataRef: event.dataRef };
          }
        }
        hydrateEventData(event, contentStore);
        out.push(event);
      } catch {
        /* skip damaged line */
      }
    }
  } catch {
    /* return parsed prefix */
  }
  return out;
}

/**
 * Indexed query：按 actor/type/seq 直接 seek JSONL 需要的行，再恢复 sidecar/content blobs。
 * 索引失配会由 event-index 自动从 authoritative JSONL 重建。
 */
export function querySessionEvents(
  dir: string,
  sessionId: string,
  query: SessionEventIndexQuery = {}
): SessionEvent[] {
  assertSafeSessionId(sessionId);
  const contentStore = new ContentAddressedStore(path.join(dir, "content-blobs"));
  const raw = queryIndexedSessionEvents(dir, sessionId, query) as SessionEvent[];
  for (const event of raw) {
    if (event.dataRef) {
      try {
        const refPath = path.resolve(dir, event.dataRef);
        const rel = path.relative(dir, refPath);
        if (rel === ".." || rel.startsWith(".." + path.sep) || path.isAbsolute(rel)) throw new Error("event dataRef 越界");
        event.data = JSON.parse(fs.readFileSync(refPath, "utf8"));
      } catch {
        event.data = { unavailable: true, dataRef: event.dataRef };
      }
    }
    hydrateEventData(event, contentStore);
  }
  return raw;
}

/**
 * 为 event log 创建可安全落盘的 ChatMessage。存在 content store 时，所有图片值都抽到
 * SHA-256 blob；无 store 的纯函数调用保持旧行为并显式 replayable=false。
 */
export function messageForEventLog(
  message: ChatMessage,
  store?: ContentAddressedStore
): LoggedMessageData {
  const imageCount = message.images?.length ?? 0;
  const copy: ChatMessage = {
    role: message.role,
    content: String(message.content ?? ""),
  };
  if (message.name) copy.name = message.name;
  if (message.tool_call_id) copy.tool_call_id = message.tool_call_id;
  if (message.reasoning_content && message.role === "assistant") copy.reasoning_content = message.reasoning_content;
  if (message.responses_output_items?.length && message.role === "assistant") {
    copy.responses_output_items = message.responses_output_items.map((item) =>
      item && typeof item === "object" && !Array.isArray(item) ? { ...(item as Record<string, unknown>) } : item
    );
  }
  if (message.responses_phase && message.role === "assistant") copy.responses_phase = message.responses_phase;
  if (message.tool_calls) {
    copy.tool_calls = message.tool_calls.map((c: ToolCall) => ({
      id: c.id,
      type: "function",
      function: { name: c.function.name, arguments: c.function.arguments },
    }));
  }
  if (!imageCount) return { message: copy, imageCount: 0, replayable: true };
  if (!store) return { message: copy, imageCount, replayable: false };
  const imageRefs: ContentBlobRef[] = [];
  try {
    for (const image of message.images ?? []) imageRefs.push(store.putImage(image));
    return { message: copy, imageCount, replayable: imageRefs.length === imageCount, imageRefs };
  } catch {
    return { message: copy, imageCount, replayable: false, imageRefs };
  }
}

/** 把当前模型上下文转成 canonical snapshot；图片由 content store 去重保存。 */
export function conversationForEventLog(
  messages: readonly ChatMessage[],
  store?: ContentAddressedStore
): Omit<ConversationSnapshotData, "reason"> {
  let complete = true;
  const out: ChatMessage[] = [];
  const imageRefs: Array<{ index: number; refs: ContentBlobRef[] }> = [];
  for (let index = 0; index < messages.length; index++) {
    const logged = messageForEventLog(messages[index], store);
    out.push(logged.message);
    if (logged.imageRefs?.length) imageRefs.push({ index, refs: logged.imageRefs });
    if (!logged.replayable) complete = false;
  }
  return { messages: out, complete, ...(imageRefs.length ? { imageRefs } : {}) };
}

function hydrateEventData(event: SessionEvent, store: ContentAddressedStore): void {
  if (event.type === "user/message") {
    const data = event.data as (LoggedMessageData & { edited?: boolean }) | undefined;
    if (!data?.message || !data.imageRefs?.length) return;
    try {
      data.message.images = data.imageRefs.map((ref) => store.readImage(ref));
      data.replayable = data.message.images.length === data.imageCount;
    } catch {
      delete data.message.images;
      data.replayable = false;
    }
  } else if (event.type === "conversation/snapshot") {
    const data = event.data as ConversationSnapshotData | undefined;
    if (!data?.messages || !data.imageRefs?.length) return;
    for (const row of data.imageRefs) {
      const message = data.messages[row.index];
      if (!message) { data.complete = false; continue; }
      try {
        message.images = row.refs.map((ref) => store.readImage(ref));
      } catch {
        delete message.images;
        data.complete = false;
      }
    }
  }
}

const REPLAY_EVENT_TYPES = [
  "conversation/snapshot", "system/message", "user/message", "assistant/message", "tool/message",
] as const;

/**
 * 从 canonical message 事件投影模型对话。默认只回放 main actor，避免把子 Agent 的内部
 * 思考/工具消息错误塞回主 Agent 上下文。legacy 事件不参与此投影。
 */
export function deriveConversationFromEvents(
  events: readonly SessionEvent[],
  actor = "main"
): { messages: ChatMessage[]; complete: boolean } {
  const messages: ChatMessage[] = [];
  let complete = true;
  for (const event of events) {
    if ((event.actor ?? "main") !== actor) continue;
    if (event.type === "conversation/snapshot") {
      const data = event.data as SessionEventDataMap["conversation/snapshot"] | undefined;
      if (data?.messages) {
        messages.splice(0, messages.length, ...data.messages.map((m) => ({ ...m })));
        complete = data.complete !== false;
      } else {
        complete = false;
      }
    } else if (event.type === "system/message") {
      const data = event.data as SessionEventDataMap["system/message"] | undefined;
      if (data?.message) messages.push({ ...data.message });
    } else if (event.type === "user/message") {
      const data = event.data as SessionEventDataMap["user/message"] | undefined;
      if (data?.message) messages.push({ ...data.message });
      if (data?.replayable === false) complete = false;
    } else if (event.type === "assistant/message") {
      const data = event.data as SessionEventDataMap["assistant/message"] | undefined;
      if (data?.message) messages.push({ ...data.message });
    } else if (event.type === "tool/message") {
      const data = event.data as SessionEventDataMap["tool/message"] | undefined;
      if (data?.message) messages.push({ ...data.message });
    }
  }
  return { messages, complete };
}

/** 读取指定边界前的事件并投影 canonical 对话。 */
export function deriveConversationAtSeq(
  dir: string,
  sessionId: string,
  boundarySeq = Number.MAX_SAFE_INTEGER,
  actor = "main"
): { messages: ChatMessage[]; complete: boolean } {
  return deriveConversationFromEvents(
    querySessionEvents(dir, sessionId, { actor, types: REPLAY_EVENT_TYPES, maxSeq: boundarySeq }),
    actor
  );
}

/**
 * 从 source session 的某个 durable seq 创建新会话。fork 本身只复制 canonical projection；
 * content blobs 按 digest 共享，不复制 base64/二进制。
 */
export interface ForkCheckpointAnchor {
  hash: string;
  label: string;
  workspaceRoot: string;
  eventSeq: number;
  kind: "auto" | "manual";
}

/** 创建指定 event 边界的 canonical 会话 fork，并返回最近的 workspace checkpoint anchor。 */
export function forkSessionEventLog(
  dir: string,
  sourceSessionId: string,
  targetSessionId: string,
  boundarySeq: number
): { log: SessionEventLog; messages: ChatMessage[]; complete: boolean; checkpoint: ForkCheckpointAnchor | null } {
  assertSafeSessionId(sourceSessionId);
  assertSafeSessionId(targetSessionId);
  if (!Number.isInteger(boundarySeq) || boundarySeq < 1) throw new Error("fork boundarySeq 必须是正整数");
  const sourceEvents = querySessionEvents(dir, sourceSessionId, {
    actor: "main", types: [...REPLAY_EVENT_TYPES, "checkpoint"], maxSeq: boundarySeq,
  });
  const projected = deriveConversationFromEvents(sourceEvents, "main");
  if (!projected.complete) throw new Error("源会话在该边界无法完整回放，拒绝有损 fork");
  if (!projected.messages.length) throw new Error("源会话在该边界没有可回放消息");
  const checkpointEvent = [...sourceEvents].reverse().find((event) =>
    (event.actor ?? "main") === "main" && event.type === "checkpoint"
  );
  const checkpointData = checkpointEvent?.data as SessionEventDataMap["checkpoint"] | undefined;
  const checkpoint: ForkCheckpointAnchor | null = checkpointEvent && checkpointData?.hash && checkpointData.workspaceRoot
    ? {
        hash: checkpointData.hash,
        label: checkpointData.label,
        workspaceRoot: checkpointData.workspaceRoot,
        eventSeq: checkpointEvent.seq,
        kind: checkpointData.kind,
      }
    : null;
  const log = ensureEventLog(dir, targetSessionId);
  log.append("session/fork", {
    sourceSessionId,
    boundarySeq,
    ...(checkpoint ? { checkpointHash: checkpoint.hash, checkpointSeq: checkpoint.eventSeq } : {}),
  }, "main");
  log.append("conversation/snapshot", { ...log.persistConversation(projected.messages), reason: "fork" }, "main");
  return { log, messages: projected.messages, complete: true, checkpoint };
}

// ── 进程级 session cache：不是“当前日志单例”，而是每个 session 一个独立实例。──
const logs = new Map<string, SessionEventLog>();
const titleProjected = new Set<string>();
let activeSessionId: string | null = null;

/** 获取/创建指定会话日志。UI 切换不会结束旧会话，也不会改变旧实例的写入目标。 */
export function ensureEventLog(dir: string, sessionId: string): SessionEventLog {
  assertSafeSessionId(sessionId);
  let log = logs.get(sessionId);
  if (!log) {
    log = new SessionEventLog(sessionId, dir);
    const existing = querySessionEvents(dir, sessionId, { types: ["session_title", "session_start"] });
    if (existing.some((e) => e.type === "session_title")) titleProjected.add(sessionId);
    if (!existing.some((e) => e.type === "session_start")) {
      log.append("session_start", { resumed: false });
    } else {
      log.append("session_start", { resumed: true });
    }
    logs.set(sessionId, log);
  }
  activeSessionId = sessionId;
  return log;
}

/** 获取指定 session 的日志；省略 id 时仅用于 legacy active-session fallback。 */
export function getEventLog(sessionId?: string): SessionEventLog | null {
  const id = sessionId ?? activeSessionId;
  return id ? logs.get(id) ?? null : null;
}

/** 显式结束会话；与“切换 UI”分离，后台 Agent 不会因用户浏览其它会话被提前 end。 */
export function endSessionEventLog(sessionId: string, reason = "end"): void {
  assertSafeSessionId(sessionId);
  const log = logs.get(sessionId);
  if (!log) return;
  log.close(reason);
  logs.delete(sessionId);
  titleProjected.delete(sessionId);
  if (activeSessionId === sessionId) activeSessionId = null;
}

function collectBlobDigests(value: unknown, out: Set<string>): void {
  if (!value || typeof value !== "object") return;
  if (!Array.isArray(value)) {
    const row = value as Record<string, unknown>;
    if (row.algo === "sha256" && typeof row.digest === "string" && /^[a-f0-9]{64}$/.test(row.digest)) {
      out.add(row.digest);
    }
  }
  for (const child of Array.isArray(value) ? value : Object.values(value as Record<string, unknown>)) {
    collectBlobDigests(child, out);
  }
}

/** 扫描仍存在的 session 引用并删除孤儿 content blobs；共享 digest 会被保留。 */
export function garbageCollectContentBlobs(dir: string): number {
  const referenced = new Set<string>();
  let files: string[] = [];
  try { files = fs.readdirSync(dir).filter((name) => /^events-.+\.jsonl$/.test(name)); } catch { return 0; }
  for (const file of files) {
    const sessionId = file.slice("events-".length, -".jsonl".length);
    for (const event of readSessionEvents(dir, sessionId)) collectBlobDigests(event.data, referenced);
  }
  const store = new ContentAddressedStore(path.join(dir, "content-blobs"));
  let removed = 0;
  for (const digest of store.listDigests()) {
    if (referenced.has(digest)) continue;
    try { store.deleteDigest(digest); removed++; } catch { /* best-effort */ }
  }
  return removed;
}

/**
 * 永久删除一个 session 的 durable event 数据。先关闭缓存 sink，确保后台持有旧引用时也不会
 * 在删除后重新创建日志；再删除 JSONL 与 sidecar。
 */
export function deleteSessionEventLog(dir: string, sessionId: string): void {
  assertSafeSessionId(sessionId);
  endSessionEventLog(sessionId, "deleted");
  try {
    fs.rmSync(path.join(dir, `events-${sessionId}.jsonl`), { force: true });
  } catch {
    /* best-effort */
  }
  deleteSessionEventIndex(dir, sessionId);
  try {
    fs.rmSync(path.join(dir, "event-blobs", sessionId), { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
  garbageCollectContentBlobs(dir);
}

/** 每个 session 只投影一次标题，避免后台/切换会话互相覆盖。 */
export function projectSessionTitle(title: string, sessionId?: string): void {
  const log = getEventLog(sessionId);
  if (!log || titleProjected.has(log.sessionId) || !title.trim()) return;
  titleProjected.add(log.sessionId);
  log.append("session_title", { title: title.trim().slice(0, 120) });
}

/** legacy/fallback：优先使用显式 SessionEventLog；无参数时写 active session。 */
export function appendEvent(type: string, data?: unknown, actor?: string): SessionEvent | null {
  return getEventLog()?.append(type, data, actor) ?? null;
}
