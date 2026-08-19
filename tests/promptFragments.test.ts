import { test } from "node:test";
import assert from "node:assert/strict";
import {
  assembleBoundedFragments,
  assembleBoundedFragmentsWithManifest,
  currentTimeBlock,
  refreshPromptTime,
  renderFragmentManifest,
  TIME_HEADER,
  type FragmentManifestEntry,
} from "../src/promptFragments";

test("assembleBoundedFragments: 空输入返回空串", () => {
  assert.equal(assembleBoundedFragments([]), "");
  assert.equal(assembleBoundedFragments([{ title: "x", content: "   " }]), "");
});

test("assembleBoundedFragments: 正常片段带标题", () => {
  const out = assembleBoundedFragments([{ title: "规则", content: "内容" }]);
  assert.ok(out.includes("## 规则"));
  assert.ok(out.includes("内容"));
});

test("assembleBoundedFragments: 无标题片段原样嵌入", () => {
  const out = assembleBoundedFragments([{ title: "", content: "裸内容" }]);
  assert.equal(out, "裸内容");
});

test("assembleBoundedFragments: 超 warnAt 阈值加 ⚠️ 提示", () => {
  const content = "字".repeat(2500); // 2500 CJK ≈ 3750 tokens > 2500
  const out = assembleBoundedFragments([{ title: "大", content }], { warnAtTokens: 2000 });
  assert.ok(out.includes("⚠️ 以下片段较大"));
});

test("assembleBoundedFragments: 超单片段上限截断", () => {
  const content = "a".repeat(100_000);
  const out = assembleBoundedFragments([{ title: "巨大", content }], { maxFragmentTokens: 5000 });
  assert.ok(out.includes("已截断"));
});

test("assembleBoundedFragments: 总量超限丢弃靠后片段并标注", () => {
  // A≈750tokens、B≈750tokens、C≈750tokens；预算 900 → A 通过，B/C 丢弃
  const out = assembleBoundedFragments(
    [
      { title: "A", content: "a".repeat(3000) },
      { title: "B", content: "b".repeat(3000) },
      { title: "C", content: "c".repeat(3000) },
    ],
    { maxTotalTokens: 900 }
  );
  assert.ok(out.includes("## A"), "靠前片段应保留");
  assert.ok(out.includes("未注入片段"), "应列出被丢弃片段");
  assert.ok(!out.includes("## B") || !out.includes("## C"), "靠后片段至少丢一个");
});

test("currentTimeBlock: 含头与结束标记", () => {
  const block = currentTimeBlock();
  assert.ok(block.startsWith(TIME_HEADER));
  assert.ok(block.includes("<!--FREESEEK_TIME_END-->"));
});

test("refreshPromptTime: 无时间块原样返回", () => {
  const p = "hello world";
  assert.equal(refreshPromptTime(p), p);
});

test("refreshPromptTime: 替换时间块并保留前后内容", () => {
  const before = "## 开头\n";
  const after = "\n## 结尾";
  const prompt = before + currentTimeBlock() + after;
  const out = refreshPromptTime(prompt);
  assert.ok(out.startsWith(before));
  assert.ok(out.endsWith(after));
  // 只出现一次时间块
  const count = out.split("<!--FREESEEK_TIME_END-->").length - 1;
  assert.equal(count, 1);
});

test("manifest: 带 key/kind 的片段如实记录状态", () => {
  const { prompt, manifest } = assembleBoundedFragmentsWithManifest([
    { title: "", content: "base", key: "system-core", kind: "core", priority: -1000 },
    { title: "规则", content: "规则内容", key: "rules", kind: "rules", source: "ROOT" },
  ]);
  assert.ok(prompt.includes("base") && prompt.includes("## 规则"));
  assert.equal(manifest.length, 2);
  assert.deepEqual(
    manifest.map((m) => m.key),
    ["system-core", "rules"]
  );
  assert.equal(manifest[0].kind, "core");
  assert.equal(manifest[1].source, "ROOT");
  assert.ok(manifest.every((m) => m.status === "injected"));
});

test("manifest: 截断片段标 truncated、空片段标 empty", () => {
  const { manifest } = assembleBoundedFragmentsWithManifest(
    [
      { title: "巨大", content: "a".repeat(100_000), key: "huge", kind: "tools", indexOnly: true },
      { title: "空", content: "   ", key: "blank", kind: "other" },
    ],
    { maxFragmentTokens: 5000, maxTotalTokens: 100_000 }
  );
  const byKey = new Map(manifest.map((m) => [m.key, m]));
  assert.equal(byKey.get("huge")!.status, "truncated");
  assert.equal(byKey.get("blank")!.status, "empty");
});

test("manifest: 超总量标 dropped 且 tokens 为 0", () => {
  const { manifest } = assembleBoundedFragmentsWithManifest(
    [
      { title: "A", content: "a".repeat(3000), key: "A", kind: "other" },
      { title: "B", content: "b".repeat(3000), key: "B", kind: "other" },
    ],
    { maxTotalTokens: 900 }
  );
  const byKey = new Map(manifest.map((m) => [m.key, m]));
  assert.equal(byKey.get("A")!.status, "injected");
  assert.equal(byKey.get("B")!.status, "dropped");
  assert.equal(byKey.get("B")!.tokens, 0);
});

test("manifest: 显式 priority 可置换低优先片段", () => {
  const { prompt, manifest } = assembleBoundedFragmentsWithManifest(
    [
      { title: "核心", content: "c".repeat(2000), key: "core", kind: "core", priority: 1 },
      { title: "记忆", content: "m".repeat(2000), key: "memory", kind: "memory" }, // 缺省 priority：1000+index
      { title: "目标", content: "g".repeat(2000), key: "goal", kind: "goal", priority: 2 },
    ],
    { maxTotalTokens: 700 }
  );
  // 预算只够 1 个片段（≈500t）：priority 1 的 core 保留，memory（1000+）被置换丢弃
  assert.ok(prompt.includes("核心"));
  const status = new Map(manifest.map((m) => [m.key, m.status]));
  assert.equal(status.get("core"), "injected");
  assert.equal(status.get("memory"), "dropped");
  assert.equal(status.get("goal"), "dropped");
});

test("manifest: 输出顺序保持原始数组顺序（priority 只影响保留集）", () => {
  const { prompt } = assembleBoundedFragmentsWithManifest(
    [
      { title: "", content: "AAA", key: "a", kind: "other", priority: 99 },
      { title: "", content: "BBB", key: "b", kind: "other", priority: 1 },
      { title: "", content: "CCC", key: "c", kind: "other", priority: 50 },
    ],
    { maxTotalTokens: 400 }
  );
  const ia = prompt.indexOf("AAA");
  const ib = prompt.indexOf("BBB");
  const ic = prompt.indexOf("CCC");
  assert.ok(ia >= 0 && ib >= 0 && ic >= 0, "预算足够时全部保留");
  assert.ok(ia < ib && ib < ic, "输出顺序 = 输入顺序");
});

test("renderFragmentManifest: 输出可读审计块", () => {
  const manifest: FragmentManifestEntry[] = [
    { key: "tools", title: "工具清单", kind: "tools", indexOnly: true, status: "injected", tokens: 120, chars: 480 },
    { key: "skills", title: "", kind: "skills", indexOnly: true, status: "dropped", tokens: 0, chars: 0 },
  ];
  const out = renderFragmentManifest(manifest);
  assert.ok(out.includes("## prompt-manifest"));
  assert.ok(out.includes("[inject]"));
  assert.ok(out.includes("tools"));
  assert.ok(out.includes("[index]"));
  assert.equal(renderFragmentManifest([]), "(空 manifest)");
});
