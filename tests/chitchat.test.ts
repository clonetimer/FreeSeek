import { test } from "node:test";
import assert from "node:assert/strict";
import { isChitChat, summarizeTaskText } from "../src/chitchat";

test("isChitChat: 空串不算闲聊", () => {
  assert.equal(isChitChat(""), false);
  assert.equal(isChitChat("   "), false);
});

test("isChitChat: 简短问候视为闲聊", () => {
  assert.equal(isChitChat("你好"), true);
  assert.equal(isChitChat("hi"), true);
  assert.equal(isChitChat("谢谢"), true);
});

test("isChitChat: 含工具触发词的短句不是闲聊", () => {
  assert.equal(isChitChat("帮我改下这个文件"), false);
  assert.equal(isChitChat("看下报错"), false);
  assert.equal(isChitChat("运行测试"), false);
});

test("isChitChat: 长文本一律不闲聊（完整工具能力）", () => {
  const long = "字".repeat(80);
  assert.ok(long.length > 60);
  assert.equal(isChitChat(long), false);
});

test("summarizeTaskText: 去除 markdown 标记并压缩空白", () => {
  assert.equal(summarizeTaskText("修复 ### 登录 **bug**"), "修复 登录 bug");
});

test("summarizeTaskText: 代码块替换为占位", () => {
  assert.equal(summarizeTaskText("```code``` 内容"), "代码块 内容");
});

test("summarizeTaskText: 空输入返回默认标题", () => {
  assert.equal(summarizeTaskText(""), "执行任务");
  assert.equal(summarizeTaskText("# * _ `x`"), "执行任务");
});

test("summarizeTaskText: 超长截断并加省略号", () => {
  const long = "a".repeat(100);
  const s = summarizeTaskText(long);
  assert.ok(s.length <= 44);
  assert.ok(s.endsWith("…"));
});

test("summarizeTaskText: 自定义 max", () => {
  const s = summarizeTaskText("这是一个非常长的任务描述文本用于测试自定义长度", 10);
  assert.ok(s.length <= 10);
});
