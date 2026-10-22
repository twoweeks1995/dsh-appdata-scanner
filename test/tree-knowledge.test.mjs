import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { coerceEntry, loadKnowledge, matchEntry } from "../src/knowledge.mjs";
import { resolveTreeKnowledge } from "../plugin/index.js";

const knowledge = await loadKnowledge(fileURLToPath(new URL("../knowledge/", import.meta.url)), {});

// 回归:matchRule 的 fallback 只能是「从根算起的完整路径」,不能是任意尾段。
// 否则单段兜底规则(如 "*")会命中深层路径的最后一段,把 safe 目录下的子目录误判成兜底安全级。
test("单段兜底规则 * 只匹配一层,不得命中深层路径的尾段", () => {
  const synthetic = coerceEntry({
    match: "App",
    owner: "测试",
    purpose: "合成条目",
    category: "app-data",
    safety: "mixed",
    confidence: "medium",
    ifDeleted: "测试",
    children: [
      { match: "child", safety: "safe", purpose: "一层子目录", ifDeleted: "可重建" },
      { match: "child\\grandchild", safety: "safe", purpose: "两层子目录", ifDeleted: "可重建" },
      { match: "*", safety: "never", purpose: "其余未知子目录", ifDeleted: "未知" },
    ],
  }).entry;
  assert.ok(synthetic);
  const fake = { dir: "", entries: [synthetic], files: [], problems: [], degraded: false };
  assert.equal(resolveTreeKnowledge(fake, "local\\App").safety, "mixed", "主条目应命中");
  assert.equal(resolveTreeKnowledge(fake, "local\\App\\child").safety, "safe", "一层子目录应命中具体规则");
  assert.equal(resolveTreeKnowledge(fake, "local\\App\\child\\grandchild").safety, "safe", "两层子目录应命中具体规则");
  assert.equal(resolveTreeKnowledge(fake, "local\\App\\other").safety, "never", "未知一层子目录由 * 兜底");
  assert.equal(resolveTreeKnowledge(fake, "local\\App\\child\\unknown"), null, "深层未知路径不得被 * 尾段命中");
});
const microsoft = matchEntry(knowledge, "local", "Microsoft", {})?.entry;
const steam = matchEntry(knowledge, "local", "Steam", {})?.entry;

function expectedFields(entry, rule, matchedBy = "knowledge-child") {
  assert.ok(entry);
  assert.ok(rule);
  return {
    safety: rule.safety,
    owner: entry.owner,
    purpose: rule.purpose,
    matchedBy,
    confidence: entry.confidence,
    category: entry.category,
  };
}

for (const [relPath, entry, pattern] of [
  ["local\\Microsoft\\Edge", microsoft, "Edge"],
  ["local\\Microsoft\\Edge\\User Data\\Default\\Cache", microsoft, "Edge\\User Data\\*\\Cache"],
  ["local\\Steam\\htmlcache\\Default\\Cache", steam, "htmlcache\\Default\\Cache"],
]) {
  test("真实知识库子规则：" + relPath, () => {
    assert.equal(knowledge.degraded, false);
    assert.deepEqual(knowledge.problems, []);
    const rule = entry?.children.find((child) => child.match === pattern);
    assert.deepEqual(resolveTreeKnowledge(knowledge, relPath), expectedFields(entry, rule));
  });
}

test("完全不存在的路径返回 null", () => {
  assert.equal(resolveTreeKnowledge(knowledge, "local\\NotARealApp\\sub"), null);
});

test("主条目精确命中保留全部字段", () => {
  assert.deepEqual(resolveTreeKnowledge(knowledge, "local\\Microsoft"), expectedFields(microsoft, microsoft, "knowledge"));
});

test("下钻命中的 matchedBy 为 knowledge-child", () => {
  assert.equal(resolveTreeKnowledge(knowledge, "local\\Microsoft\\Edge")?.matchedBy, "knowledge-child");
});

function fixtureKnowledge() {
  return [
    { match: "Parent", owner: "浅层 owner", safety: "mixed", confidence: "high", category: "app-data", children: [{ match: "Deep\\*", safety: "safe", purpose: "浅层通配子规则" }] },
    { match: "Parent\\Deep", owner: "深层 owner", safety: "never", confidence: "low", category: "config", purpose: "深层主条目", children: [{ match: "Known", safety: "never", purpose: "深层子规则" }] },
  ].map((raw, index) => coerceEntry(raw, { root: "local", index }).entry);
}

test("更深主条目子规则未中时回退较浅主条目", () => {
  const entries = fixtureKnowledge();
  assert.deepEqual(resolveTreeKnowledge(entries, "local\\Parent\\Deep\\Other"), expectedFields(entries[0], entries[0].children[0]));
});

test("更深主条目子规则命中时优先，不回退", () => {
  const entries = fixtureKnowledge();
  assert.deepEqual(resolveTreeKnowledge(entries, "local\\Parent\\Deep\\Known"), expectedFields(entries[1], entries[1].children[0]));
});

test("更深主条目精确命中优先于浅层子规则", () => {
  const entries = fixtureKnowledge();
  assert.deepEqual(resolveTreeKnowledge(entries, "local\\Parent\\Deep"), expectedFields(entries[1], entries[1], "knowledge"));
});

test("无知识库、无应用段和非法根返回 null", () => {
  assert.equal(resolveTreeKnowledge([], "local\\Microsoft\\Edge"), null);
  assert.equal(resolveTreeKnowledge(knowledge, "local"), null);
  assert.equal(resolveTreeKnowledge(knowledge, "invalid\\Microsoft"), null);
});

test("统一路径分隔符、空段及大小写", () => {
  assert.deepEqual(resolveTreeKnowledge(knowledge, "LOCAL//Microsoft/./Edge/"), resolveTreeKnowledge(knowledge, "local\\Microsoft\\Edge"));
});
