import { test } from "node:test";
import assert from "node:assert/strict";
import { listRolePresets, getRolePreset, setUserRolePresets, EXEC_TOOLS } from "../src/rolePresets";

test("listRolePresets: 内置 4 个角色", () => {
  const roles = listRolePresets();
  const names = roles.map((r) => r.name);
  for (const expect of ["explore", "plan", "verify", "general"]) {
    assert.ok(names.includes(expect), `应包含内置角色 ${expect}`);
  }
});

test("listRolePresets: executor 标记与 EXEC_TOOLS 口径一致", () => {
  const roles = listRolePresets();
  const explore = roles.find((r) => r.name === "explore")!;
  const verify = roles.find((r) => r.name === "verify")!;
  const general = roles.find((r) => r.name === "general")!;
  assert.equal(explore.executor, false);
  assert.equal(verify.executor, true);
  assert.equal(general.executor, true);
  assert.ok(EXEC_TOOLS.has("run_command"));
  assert.ok(EXEC_TOOLS.has("verify"));
  assert.ok(!EXEC_TOOLS.has("read_file"));
});

test("getRolePreset: 内置角色可查询，未知返回 undefined", () => {
  assert.ok(getRolePreset("explore")?.body);
  assert.equal(getRolePreset("不存在的角色"), undefined);
});

test("setUserRolePresets: 注入自定义角色并可覆盖内置同名", () => {
  setUserRolePresets({
    custom_agent: { body: "我是自定义角色", tools: ["read_file"] },
    explore: { body: "被覆盖的 explore", tools: ["read_file"] },
  });
  const roles = listRolePresets();
  const custom = roles.find((r) => r.name === "custom_agent");
  assert.ok(custom, "自定义角色应出现在清单中");
  assert.equal(custom!.executor, false);
  // 同名覆盖：getRolePreset 优先用户自定义
  assert.ok(getRolePreset("explore")?.body.includes("被覆盖"));
  // 清理，避免影响其他测试
  setUserRolePresets({});
});
