// 后台任务注册表（吸收 deepseek-harness packages/jobs 的核心语义，零依赖纯 TS）。
// 现状：spawn_agent 的 run_in_background 已有 taskId + 完成通知，但缺少统一查询、
// 读取输出、取消的入口。这里补齐 job_list / job_output / job_kill 三个工具的数据底座。

export type JobStatus = "running" | "stopping" | "completed" | "killed" | "failed";
export type JobKind = "subagent";

export interface BackgroundJob {
  id: string;
  kind: JobKind;
  label: string;
  status: JobStatus;
  detail?: string;
  /** 输出分片（环形缓冲：最多保留 JOB_OUTPUT_MAX 片，每片最多 JOB_OUTPUT_CHUNK 字符） */
  output: string[];
  startedAt: number;
  finishedAt?: number;
}

const JOB_OUTPUT_MAX = 12;
const JOB_OUTPUT_CHUNK = 2000;

class JobRegistry {
  private jobs = new Map<string, BackgroundJob>();
  private controllers = new Map<string, AbortController>();
  private seq = 0;

  start(kind: JobKind, label: string, detail?: string): string {
    const id = `job-${++this.seq}`;
    this.jobs.set(id, {
      id,
      kind,
      label,
      status: "running",
      detail,
      output: [],
      startedAt: Date.now(),
    });
    this.controllers.set(id, new AbortController());
    return id;
  }

  /** 获取后台任务的真实取消信号，供子 Agent / 模型请求 / 工具执行透传。 */
  signal(id: string): AbortSignal | undefined {
    return this.controllers.get(id)?.signal;
  }

  appendOutput(id: string, text: string): void {
    const j = this.jobs.get(id);
    if (!j) return;
    const chunk = String(text ?? "").trim();
    if (!chunk) return;
    j.output.push(chunk.length > JOB_OUTPUT_CHUNK ? chunk.slice(0, JOB_OUTPUT_CHUNK) : chunk);
    if (j.output.length > JOB_OUTPUT_MAX) j.output = j.output.slice(-JOB_OUTPUT_MAX);
  }

  settle(id: string, status: Exclude<JobStatus, "running" | "stopping">, detail?: string): void {
    const j = this.jobs.get(id);
    if (!j || j.status === "completed" || j.status === "killed" || j.status === "failed") return;
    j.status = status;
    if (detail) j.detail = detail;
    j.finishedAt = Date.now();
    this.controllers.delete(id);
  }

  kill(id: string): string | null {
    const j = this.jobs.get(id);
    if (!j) return null;
    if (j.status === "running" || j.status === "stopping") {
      j.status = "stopping";
      try { this.controllers.get(id)?.abort(new Error("job_kill")); } catch { /* ignore */ }
      j.status = "killed";
      j.finishedAt = Date.now();
      j.detail = "已被 job_kill 终止";
      this.controllers.delete(id);
      return "已发送真实取消信号：模型流与支持 AbortSignal 的工具/子进程将立即终止；任务状态已标记为 killed。";
    }
    return `任务已处于 ${j.status}，无需终止。`;
  }

  list(): BackgroundJob[] {
    return [...this.jobs.values()].sort((a, b) => b.startedAt - a.startedAt);
  }

  get(id: string): BackgroundJob | undefined {
    return this.jobs.get(id);
  }
}

/** 模块级单例：主 Agent 与子 Agent 共享同一注册表。 */
export const jobRegistry = new JobRegistry();

export const JOB_STATUS_LABEL: Record<JobStatus, string> = {
  running: "运行中",
  stopping: "停止中",
  completed: "已完成",
  killed: "已终止",
  failed: "失败",
};

export function renderJobView(j: BackgroundJob): string {
  const end = j.finishedAt ? ` 结束 ${new Date(j.finishedAt).toLocaleTimeString()}` : "";
  return `${j.id} [${JOB_STATUS_LABEL[j.status]}] ${j.label}${
    j.detail ? `（${j.detail}）` : ""
  }${end}`;
}
