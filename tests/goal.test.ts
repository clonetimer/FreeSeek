/**
 * goal 目标状态机单测：转移、轮次推进、持久化、渲染。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as os from "os";
import * as fs from "fs";
import * as path from "path";
import {
  emptyGoalState,
  applyGoalOp,
  bumpGoalRound,
  saveGoalState,
  loadGoalState,
  renderGoalView,
} from "../src/goal";

describe("goal 状态机", () => {
  it("emptyGoalState 初始为 active 空目标", () => {
    const s = emptyGoalState();
    assert.equal(s.phase, "active");
    assert.equal(s.objective, "");
  });

  it("create 登记目标并进入 active", () => {
    const s = applyGoalOp(emptyGoalState(), {
      op: "create",
      objective: "修复登录 bug",
    });
    assert.equal(s.objective, "修复登录 bug");
    assert.equal(s.phase, "active");
    assert.equal(s.roundsStarted, 0);
  });

  it("pause/resume/complete 状态转移", () => {
    let s = applyGoalOp(emptyGoalState(), {
      op: "create",
      objective: "重构 storage",
    });
    s = applyGoalOp(s, { op: "pause" });
    assert.equal(s.phase, "paused");
    s = applyGoalOp(s, { op: "resume" });
    assert.equal(s.phase, "active");
    s = applyGoalOp(s, { op: "complete" });
    assert.equal(s.phase, "complete");
  });

  it("edit 更新目标且不改动已 complete 的 phase", () => {
    let s = applyGoalOp(emptyGoalState(), { op: "create", objective: "x" });
    s = applyGoalOp(s, { op: "complete" });
    const r = applyGoalOp(s, { op: "edit", objective: "y" });
    assert.equal(r.objective, "y");
    assert.equal(r.phase, "complete");
  });

  it("edit 保留轮次预算", () => {
    let s = applyGoalOp(emptyGoalState(), {
      op: "create",
      objective: "a",
      maxRounds: 5,
    });
    s = applyGoalOp(s, { op: "edit", objective: "b" });
    assert.equal(s.objective, "b");
    assert.equal(s.maxRounds, 5);
  });

  it("bumpGoalRound 仅对 active 目标递增", () => {
    let s = applyGoalOp(emptyGoalState(), { op: "create", objective: "x" });
    s = bumpGoalRound(s);
    assert.equal(s.roundsStarted, 1);
    const p = bumpGoalRound(applyGoalOp(s, { op: "pause" }));
    assert.equal(p.roundsStarted, 1);
  });

  it("save/load 往返持久化到 .agent/.goal.json", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fs-goal-"));
    try {
      const s = applyGoalOp(emptyGoalState(), {
        op: "create",
        objective: "持久化目标",
      });
      saveGoalState(dir, s);
      const loaded = loadGoalState(dir);
      assert.equal(loaded.objective, "持久化目标");
      assert.equal(loaded.phase, "active");
      assert.ok(fs.existsSync(path.join(dir, ".agent", ".goal.json")));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("renderGoalView 空目标给引导文案", () => {
    assert.match(renderGoalView(emptyGoalState()), /goal/);
  });
});
