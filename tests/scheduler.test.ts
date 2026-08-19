import { test } from "node:test";
import assert from "node:assert/strict";
import { parseScheduleSpec, nextRunAt, isDue, Scheduler, type ScheduledTask } from "../src/scheduler";

test("parseScheduleSpec: 校验 interval / daily", () => {
  assert.deepEqual(parseScheduleSpec({ kind: "interval", everyMs: 5000 }), { kind: "interval", everyMs: 5000 });
  assert.deepEqual(parseScheduleSpec({ kind: "daily", hour: 9, minute: 30 }), { kind: "daily", hour: 9, minute: 30 });
  assert.equal(parseScheduleSpec({ kind: "interval", everyMs: 500 }), null);
  assert.equal(parseScheduleSpec({ kind: "daily", hour: 24, minute: 0 }), null);
  assert.equal(parseScheduleSpec(null), null);
});

test("nextRunAt: interval 返回 now+everyMs", () => {
  assert.equal(nextRunAt({ kind: "interval", everyMs: 5000 }, 1000), 6000);
});

test("nextRunAt: daily 返回今天或明天的 HH:mm", () => {
  // 选一个未来的时间点：now 在当地时区
  const now = new Date(2026, 7, 16, 8, 0, 0, 0).getTime(); // 2026-08-16 08:00 本地
  const next = nextRunAt({ kind: "daily", hour: 9, minute: 0 }, now)!;
  const d = new Date(next);
  assert.equal(d.getHours(), 9);
  assert.equal(d.getMinutes(), 0);
  assert.ok(next > now);
});

test("isDue: interval 未跑过则不到期，跑过超间隔则到期", () => {
  const t: ScheduledTask = { id: "a", name: "a", prompt: "p", schedule: { kind: "interval", everyMs: 5000 }, enabled: true };
  assert.equal(isDue(t, 1000), false);
  t.lastRunAt = 1000;
  assert.equal(isDue(t, 5999), false);
  assert.equal(isDue(t, 6000), true);
});

test("isDue: disabled 永不到期", () => {
  const t = { id: "a", name: "a", prompt: "p", schedule: { kind: "interval", everyMs: 1000 } as const, enabled: false, lastRunAt: 0 };
  assert.equal(isDue(t, 999999), false);
});

test("Scheduler: 管理 API + runNow 触发回调", () => {
  const runs: string[] = [];
  const s = new Scheduler({ onRun: (t) => runs.push(t.id) });
  const a = s.add("task-a", "hello", { kind: "interval", everyMs: 5000 });
  assert.equal(s.list().length, 1);
  assert.equal(s.runNow(a.id), true);
  assert.deepEqual(runs, [a.id]);
  s.remove(a.id);
  assert.equal(s.list().length, 0);
});

test("Scheduler: setEnabled/load/toJSON", () => {
  const s = new Scheduler({ onRun: () => {} });
  const a = s.add("a", "p", { kind: "interval", everyMs: 5000 });
  s.setEnabled(a.id, false);
  assert.equal(s.get(a.id)!.enabled, false);
  const json = s.toJSON();
  const s2 = new Scheduler({ onRun: () => {} });
  s2.load(json);
  assert.equal(s2.list().length, 1);
  assert.equal(s2.get(a.id)!.enabled, false);
});
test("Scheduler: 新 interval 从 createdAt 计算首次触发，不会永远推迟", () => {
  const runs: string[] = [];
  const s = new Scheduler({ onRun: (t) => runs.push(t.id) });
  const a = s.add("interval", "p", { kind: "interval", everyMs: 5000 }, 1_000);
  assert.equal(a.nextRunAt, 6_000);
  s.tick(5_999);
  assert.deepEqual(runs, []);
  s.tick(6_000);
  assert.deepEqual(runs, [a.id]);
  assert.equal(s.get(a.id)!.nextRunAt, 11_000);
});

test("Scheduler: 新 daily 不会在创建/启动时按 epoch 立即补跑", () => {
  const runs: string[] = [];
  const now = new Date(2026, 7, 18, 12, 0, 0, 0).getTime();
  const s = new Scheduler({ onRun: (t) => runs.push(t.id) });
  const a = s.add("daily", "p", { kind: "daily", hour: 9, minute: 0 }, now);
  assert.ok((a.nextRunAt ?? 0) > now);
  s.tick(now);
  assert.deepEqual(runs, []);
});

test("Scheduler: 旧任务 load 后从现在重新排程且自动触发会通知持久化", () => {
  const now = 10_000;
  let changed = 0;
  const runs: string[] = [];
  const s = new Scheduler({ onRun: (t) => runs.push(t.id), onStateChange: () => changed++ });
  s.load([{ id: "old", name: "old", prompt: "p", enabled: true, schedule: { kind: "interval", everyMs: 5000 } }], now);
  assert.equal(s.get("old")!.nextRunAt, 15_000);
  s.tick(15_000);
  assert.deepEqual(runs, ["old"]);
  assert.ok(changed >= 1);
  assert.equal(s.get("old")!.lastRunAt, 15_000);
  assert.equal(s.get("old")!.nextRunAt, 20_000);
});
