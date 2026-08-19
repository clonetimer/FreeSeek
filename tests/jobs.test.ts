/**
 * jobs 后台任务注册表单测：生命周期、环形缓冲、渲染。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { jobRegistry, renderJobView } from "../src/jobs";

describe("jobs 注册表", () => {
  it("start 创建 running 任务并返回 id", () => {
    const id = jobRegistry.start("subagent", "分析代码");
    const j = jobRegistry.get(id)!;
    assert.ok(j);
    assert.equal(j.status, "running");
    assert.equal(j.label, "分析代码");
  });

  it("appendOutput 环形缓冲最多 12 片且保留最新", () => {
    const id = jobRegistry.start("subagent", "输出测试");
    for (let i = 0; i < 30; i++) jobRegistry.appendOutput(id, `chunk-${i}`);
    const j = jobRegistry.get(id)!;
    assert.ok(j.output.length <= 12);
    assert.equal(j.output[j.output.length - 1], "chunk-29");
  });

  it("appendOutput 忽略空串", () => {
    const id = jobRegistry.start("subagent", "空输出");
    jobRegistry.appendOutput(id, "   ");
    assert.equal(jobRegistry.get(id)!.output.length, 0);
  });

  it("settle 收尾且幂等（后续 settle 不覆盖）", () => {
    const id = jobRegistry.start("subagent", "settle 测试");
    jobRegistry.settle(id, "completed", "全部完成");
    jobRegistry.settle(id, "failed", "不会覆盖");
    const j = jobRegistry.get(id)!;
    assert.equal(j.status, "completed");
    assert.equal(j.detail, "全部完成");
    assert.ok(j.finishedAt);
  });

  it("kill 标记 killed 并给出提示", () => {
    const id = jobRegistry.start("subagent", "kill 测试");
    const msg = jobRegistry.kill(id);
    assert.match(msg!, /终止/);
    assert.equal(jobRegistry.get(id)!.status, "killed");
  });

  it("list 覆盖全部任务（不依赖排序稳定性）", () => {
    const a = jobRegistry.start("subagent", "任务A");
    const b = jobRegistry.start("subagent", "任务B");
    const ids = jobRegistry.list().map((j) => j.id);
    assert.ok(ids.includes(a) && ids.includes(b));
  });

  it("renderJobView 含标签与状态文案", () => {
    const id = jobRegistry.start("subagent", "渲染测试");
    const view = renderJobView(jobRegistry.get(id)! );
    assert.match(view, /渲染测试/);
    assert.match(view, /运行中/);
  });
});

it("job_kill 会真实 abort 对应 AbortSignal", () => {
  const id = jobRegistry.start("subagent", "abort 测试");
  const signal = jobRegistry.signal(id)!;
  assert.ok(signal);
  assert.equal(signal.aborted, false);
  jobRegistry.kill(id);
  assert.equal(signal.aborted, true);
  assert.equal(jobRegistry.get(id)!.status, "killed");
});
