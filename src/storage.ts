/**
 * 会话历史持久化（路径 / 索引 / 队列写 / 存储迁移）。
 * 从 extension.ts ChatViewProvider 拆分出的独立模块，
 * 借鉴 deepseek-harness 的 session 持久化设计：append-only 落盘 + 索引 + 标题/预览折叠。
 */
import * as vscode from "vscode";
import * as path from "path";
import * as os from "os";
import * as fs from "fs";
import { ChatMessage } from "./provider";
import { probeModelList } from "./providers";
import { assertSafeSessionId, deriveConversationAtSeq } from "./eventlog";

/** 生成短会话 id（时间戳36进制 + 随机尾巴）。 */
function makeId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

/** 会话索引元数据（index.json 中每条会话的摘要信息）。 */
interface SessionMeta {
  id: string;
  title: string;
  preview: string;
  updatedAt: number;
  count: number;
  /** 是否归档（归档后不在主列表显示，可恢复/删除） */
  archived?: boolean;
}

/** 会话历史持久化。持有全局存储路径与写队列，方法供 ChatViewProvider 委托调用。 */
class SessionStorage {
  private storageMigrated = false;
  private saveQueue: Promise<void> = Promise.resolve();

  constructor(private readonly context: vscode.ExtensionContext) {}

  /** 用户级记忆目录，remember 写用户级记忆、启动时加载用。默认在 globalStorage；配置 storageDir 后在其下。 */
  userMemoryPath(): string {
    return path.join(this.storageRoot(), "memory");
  }

  /** 数据根目录：配置 freesek.storageDir 时用自定义目录（支持 ~ 展开），否则用 globalStorage\freesek。 */
  private storageRoot(): string {
    const custom = this.configuredStorageDir();
    return custom ?? path.join(this.context.globalStorageUri.fsPath, "freesek");
  }

  /** 读取 freesek.storageDir 配置并展开 ~；未配置/为空返回 null。 */
  private configuredStorageDir(): string | null {
    const cfg = vscode.workspace.getConfiguration("freesek");
    const raw = cfg.get<string>("storageDir", "");
    const t = (raw || "").trim();
    if (!t) return null;
    if (t === "~" || t.startsWith("~/") || t.startsWith("~\\")) {
      return path.join(os.homedir(), t.slice(1));
    }
    return t;
  }

  /** 首次切换到自定义 storageDir 时，把 globalStorage 中已有的会话/转录/记忆迁移过去（幂等，只复制不删除）。 */
  private migrateStorageIfNeeded(): void {
    const custom = this.configuredStorageDir();
    if (!custom) return;
    const oldRoot = path.join(this.context.globalStorageUri.fsPath, "freesek");
    if (!fs.existsSync(oldRoot)) return;
    // 新目录已存在会话数据（index.json 或 session-*）则跳过，避免覆盖/重复迁移
    if (fs.existsSync(custom)) {
      if (fs.existsSync(path.join(custom, "index.json"))) return;
      try {
        const hasSessions = fs
          .readdirSync(custom)
          .some((f) => f.startsWith("session-"));
        if (hasSessions) return;
      } catch {
        /* 目录不可读则视为空，继续迁移 */
      }
    }
    fs.mkdirSync(custom, { recursive: true });
    try {
      for (const f of fs.readdirSync(oldRoot)) {
        const src = path.join(oldRoot, f);
        const dst = path.join(custom, f);
        try {
          fs.cpSync(src, dst, { recursive: true });
        } catch {
          /* 单个文件失败不阻塞整体迁移 */
        }
      }
      void vscode.window.showInformationMessage(
        `FreeSeek：已把历史会话/记忆迁移到 ${custom}`
      );
    } catch (e: any) {
      void vscode.window.showWarningMessage(
        `FreeSeek：迁移存储目录失败：${e?.message ?? String(e)}`
      );
    }
  }

  historyDir(): string {
    // 首次访问时检查迁移（幂等：只执行一次）
    if (!this.storageMigrated) {
      this.storageMigrated = true;
      this.migrateStorageIfNeeded();
    }
    const dir = this.storageRoot();
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  private indexPath(): string {
    return path.join(this.historyDir(), "index.json");
  }

  sessionPath(id: string): string {
    return path.join(this.historyDir(), `session-${assertSafeSessionId(id)}.json`);
  }

  /** Layer 7 可观测性：transcript JSONL 路径（一行一条消息，供审计/调试）。 */
  transcriptPath(id: string): string {
    return path.join(this.historyDir(), `transcript-${assertSafeSessionId(id)}.jsonl`);
  }

  /** 探测 OpenAI 兼容 /models 接口（fetch_models 与 test_connection 共用）。
   *  探测核心已下沉到 providers.probeModelList（autoDiscover / fetch_models / test_connection 三处同一套逻辑）。 */
  async probeModels(
    base: string,
    apiKey: string,
    mode: "list" | "test"
  ): Promise<{ models?: string[]; error?: string }> {
    return probeModelList(base, apiKey, { mode });
  }

  loadIndex(): { current: string | null; sessions: SessionMeta[] } {
    try {
      return JSON.parse(fs.readFileSync(this.indexPath(), "utf8"));
    } catch {
      return { current: null, sessions: [] };
    }
  }

  /** 在同一写队列中以最新 index 为基线做原子读-改-写，避免多 Agent 并发覆盖。 */
  mutateIndex(mutator: (idx: { current: string | null; sessions: SessionMeta[] }) => void): void {
    this.queueTask(async () => {
      const idx = this.loadIndex();
      mutator(idx);
      await this.atomicWrite(this.indexPath(), JSON.stringify(idx, null, 2));
    });
  }

  /** 等待当前排队的所有持久化写完成；用于退出/测试/需要读取最新状态的边界。 */
  async flush(): Promise<void> {
    await this.saveQueue;
  }

  /** 异步任务统一串行；错误会告警但不打断后续保存。 */
  private queueTask(run: () => Promise<void>): void {
    const guarded = async () => {
      try {
        await run();
      } catch (e: any) {
        console.warn(`[FreeSeek storage] 保存失败: ${e?.message ?? String(e)}`);
      }
    };
    this.saveQueue = this.saveQueue.then(guarded, guarded);
  }

  /** 临时文件 + rename，避免崩溃时留下半截 JSON。 */
  private async atomicWrite(file: string, data: string): Promise<void> {
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
    await fs.promises.writeFile(tmp, data, "utf8");
    await fs.promises.rename(tmp, file);
  }

  private queueWrite(file: string, data: string): void {
    this.queueTask(async () => this.atomicWrite(file, data));
  }

  async saveCurrentSession(conversation: ChatMessage[], currentSessionId: string) {
    if (conversation.length === 0) return;
    this.saveSessionTo(currentSessionId, conversation, currentSessionId);
  }

  /** 按指定会话 id 落盘对话（当前会话或后台仍在运行的会话都走这里，避免写错会话）。 */
  saveSessionTo(
    id: string,
    conversation: ChatMessage[],
    currentSessionId: string
  ) {
    if (!conversation || conversation.length === 0) return;
    // 先冻结本次快照；真正的 index 读-改-写在写队列执行时读取最新版本，避免并发丢元数据。
    const snapshot = conversation.map((m) => ({ ...m }));
    const firstUser = snapshot.find((m) => m.role === "user");
    const title = firstUser ? String(firstUser.content).slice(0, 40) : "新对话";
    const last = snapshot[snapshot.length - 1];
    const preview = String(last?.content ?? "").slice(0, 80);
    const updatedAt = Date.now();
    this.queueTask(async () => {
      const idx = this.loadIndex();
      let meta = idx.sessions.find((s) => s.id === id);
      if (!meta) {
        meta = { id, title, preview, updatedAt, count: snapshot.length };
        idx.sessions.push(meta);
      } else {
        meta.title = title;
        meta.preview = preview;
        meta.updatedAt = updatedAt;
        meta.count = snapshot.length;
      }
      idx.current = currentSessionId;
      await this.atomicWrite(this.indexPath(), JSON.stringify(idx, null, 2));
      await this.atomicWrite(this.sessionPath(id), JSON.stringify(snapshot));
      const lines = snapshot.map((m) => JSON.stringify({ role: m.role, content: String(m.content ?? "").slice(0, 20000) }));
      await this.atomicWrite(this.transcriptPath(id), lines.join("\n") + "\n");
    });
  }

  private saveTranscriptFor(id: string, conversation: ChatMessage[]) {
    try {
      const lines = conversation.map((m) =>
        JSON.stringify({
          role: m.role,
          content: String(m.content ?? "").slice(0, 20000),
        })
      );
      this.queueWrite(this.transcriptPath(id), lines.join("\n") + "\n");
    } catch {
      /* 可观测非关键，静默 */
    }
  }

  loadSessionInto(
    id: string,
    background: Map<string, ChatMessage[]>
  ): ChatMessage[] | null {
    // 优先读后台缓冲：该会话可能仍有后台任务在跑（或刚结束），缓冲里的内容最新。
    const buffered = background.get(id);
    if (buffered && buffered.length) return buffered.map((m) => ({ ...m }));
    try {
      return JSON.parse(fs.readFileSync(this.sessionPath(id), "utf8"));
    } catch {
      // session snapshot 缺失/损坏时，只有 canonical EventLog 能完整投影才恢复；
      // incomplete（如 blob 丢失）绝不以有损历史冒充成功恢复。
      try {
        const recovered = deriveConversationAtSeq(this.historyDir(), id);
        if (recovered.complete && recovered.messages.length) return recovered.messages;
      } catch {
        /* fallback 同样失败 */
      }
      return null;
    }
  }
}

export { makeId, SessionMeta, SessionStorage };
