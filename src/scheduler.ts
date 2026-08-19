/**
 * 定时任务调度器。核心不变量：每个任务持久化明确的 nextRunAt；新任务从创建时刻计算
 * 第一次触发，自动触发后立即推进 nextRunAt 并通知持久化层，避免重启重复执行。
 */

export type ScheduleSpec =
  | { kind: "interval"; everyMs: number }
  | { kind: "daily"; hour: number; minute: number };

export interface ScheduledTask {
  id: string;
  name: string;
  prompt: string;
  schedule: ScheduleSpec;
  enabled: boolean;
  /** 创建时间；旧数据 load 时自动补齐。 */
  createdAt?: number;
  /** 下一次计划触发的绝对时间戳。 */
  nextRunAt?: number;
  /** 兼容旧字段：最近一次触发时间。 */
  lastRunAt?: number;
  /** 最近一次尝试触发时间。 */
  lastAttemptAt?: number;
  /** 最近一次成功交给 onRun 的时间。 */
  lastSuccessAt?: number;
}

/** 解析计划规格；非法输入返回 null。 */
export function parseScheduleSpec(json: any): ScheduleSpec | null {
  if (!json || typeof json !== "object") return null;
  if (json.kind === "interval") {
    const everyMs = Number(json.everyMs);
    if (!Number.isFinite(everyMs) || everyMs < 1000) return null;
    return { kind: "interval", everyMs: Math.floor(everyMs) };
  }
  if (json.kind === "daily") {
    const hour = Number(json.hour);
    const minute = Number(json.minute);
    if (!Number.isInteger(hour) || hour < 0 || hour > 23) return null;
    if (!Number.isInteger(minute) || minute < 0 || minute > 59) return null;
    return { kind: "daily", hour, minute };
  }
  return null;
}

/** 计算指定计划「nowMs 之后」的下一次触发时间戳；无下一次返回 null。 */
export function nextRunAt(schedule: ScheduleSpec, nowMs: number): number | null {
  if (schedule.kind === "interval") return nowMs + schedule.everyMs;
  const d = new Date(nowMs);
  const today = new Date(d.getFullYear(), d.getMonth(), d.getDate(), schedule.hour, schedule.minute, 0, 0).getTime();
  if (today > nowMs) return today;
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, schedule.hour, schedule.minute, 0, 0).getTime();
}

/** 判断任务是否到期。未迁移的旧任务且无 lastRunAt 时不会“从 epoch 补跑”。 */
export function isDue(task: ScheduledTask, nowMs: number): boolean {
  if (!task.enabled) return false;
  const dueAt = Number.isFinite(task.nextRunAt)
    ? Number(task.nextRunAt)
    : Number.isFinite(task.lastRunAt)
      ? nextRunAt(task.schedule, Number(task.lastRunAt))
      : null;
  return dueAt !== null && nowMs >= dueAt;
}

export interface SchedulerEvents {
  onRun: (task: ScheduledTask) => void;
  /** 任务状态（nextRunAt/lastRunAt/enabled 等）变化后通知持久化层。 */
  onStateChange?: () => void;
}

export class Scheduler {
  private tasks = new Map<string, ScheduledTask>();
  private timer: NodeJS.Timeout | null = null;
  private seq = 0;
  private readonly tickMs: number;

  constructor(private readonly events: SchedulerEvents, tickMs = 60000) {
    this.tickMs = Math.max(1000, Math.floor(tickMs));
  }

  add(name: string, prompt: string, schedule: ScheduleSpec, nowMs = Date.now()): ScheduledTask {
    const task: ScheduledTask = {
      id: `sched-${++this.seq}-${nowMs.toString(36)}`,
      name,
      prompt,
      schedule,
      enabled: true,
      createdAt: nowMs,
      nextRunAt: nextRunAt(schedule, nowMs) ?? undefined,
    };
    this.tasks.set(task.id, task);
    this.events.onStateChange?.();
    return task;
  }

  list(): ScheduledTask[] {
    return [...this.tasks.values()];
  }

  get(id: string): ScheduledTask | undefined {
    return this.tasks.get(id);
  }

  remove(id: string): boolean {
    const ok = this.tasks.delete(id);
    if (ok) this.events.onStateChange?.();
    return ok;
  }

  setEnabled(id: string, enabled: boolean, nowMs = Date.now()): boolean {
    const t = this.tasks.get(id);
    if (!t) return false;
    t.enabled = enabled;
    if (enabled) t.nextRunAt = nextRunAt(t.schedule, nowMs) ?? undefined;
    this.events.onStateChange?.();
    return true;
  }

  update(id: string, patch: { name?: string; prompt?: string; schedule?: ScheduleSpec }, nowMs = Date.now()): ScheduledTask | null {
    const t = this.tasks.get(id);
    if (!t) return null;
    if (patch.name !== undefined) t.name = patch.name;
    if (patch.prompt !== undefined) t.prompt = patch.prompt;
    if (patch.schedule !== undefined) {
      t.schedule = patch.schedule;
      t.nextRunAt = nextRunAt(t.schedule, nowMs) ?? undefined;
    }
    this.events.onStateChange?.();
    return t;
  }

  runNow(id: string, nowMs = Date.now()): boolean {
    const t = this.tasks.get(id);
    if (!t) return false;
    this.markTriggered(t, nowMs);
    try {
      this.events.onRun(t);
      t.lastSuccessAt = nowMs;
    } catch {
      /* 单个任务回调失败不影响调度器 */
    } finally {
      this.events.onStateChange?.();
    }
    return true;
  }

  start(): void {
    if (this.timer) return;
    // load() 已把旧任务迁移到未来 nextRunAt，因此启动 tick 不会把“从未运行”的 daily 当成 overdue。
    this.tick();
    this.timer = setInterval(() => this.tick(), this.tickMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** 扫描一次到期任务并触发（start() 会周期调用；公开以便测试传固定时间）。 */
  tick(nowMs: number = Date.now()): void {
    for (const t of this.tasks.values()) {
      if (!isDue(t, nowMs)) continue;
      this.markTriggered(t, nowMs);
      try {
        this.events.onRun(t);
        t.lastSuccessAt = nowMs;
      } catch {
        /* 单个任务回调失败不中断其余任务 */
      } finally {
        // 自动运行后的时间状态必须立刻持久化，否则重启会重复执行旧的 due 状态。
        this.events.onStateChange?.();
      }
    }
  }

  private markTriggered(t: ScheduledTask, nowMs: number): void {
    t.lastAttemptAt = nowMs;
    t.lastRunAt = nowMs;
    // 默认 catch-up policy = skip：一次触发后以“实际触发时刻”为基准推进，
    // 不在扩展重启后补跑一串历史错过的 interval/daily。
    t.nextRunAt = nextRunAt(t.schedule, nowMs) ?? undefined;
  }

  toJSON(): ScheduledTask[] {
    return this.list().map((t) => ({ ...t, schedule: { ...t.schedule } }));
  }

  load(tasks: ScheduledTask[], nowMs = Date.now()): void {
    const normalized: ScheduledTask[] = [];
    for (const raw of tasks || []) {
      if (!raw || !raw.id || !parseScheduleSpec(raw.schedule)) continue;
      const t: ScheduledTask = { ...raw, schedule: { ...raw.schedule } as ScheduleSpec };
      t.createdAt = Number.isFinite(t.createdAt) ? t.createdAt : nowMs;
      if (!Number.isFinite(t.nextRunAt)) {
        // 兼容旧版：有 lastRunAt 且下一次仍在未来就保留节奏；否则从“现在”重新排程，
        // 尤其不能用 0/epoch 计算 daily 后在启动时立即误触发。
        const fromLast = Number.isFinite(t.lastRunAt) ? nextRunAt(t.schedule, Number(t.lastRunAt)) : null;
        t.nextRunAt = fromLast !== null && fromLast > nowMs
          ? fromLast
          : nextRunAt(t.schedule, nowMs) ?? undefined;
      }
      normalized.push(t);
    }
    this.tasks = new Map(normalized.map((t) => [t.id, t]));
    this.seq = this.tasks.size;
  }
}
