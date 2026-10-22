// test/knowledge.test.mjs —— 知识库加载与通配匹配
import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";

import {
  globToRegExp,
  loadKnowledge,
  matchEntry,
  matchRule,
  matchesPattern,
  normalizeRelPath,
  pathSuffixes,
  patternInfo,
} from "../src/knowledge.mjs";
import { FIXTURE_ROOT, createFixture, removeFixture } from "./helpers.mjs";

test("知识库目录缺失时降级为空数组且不抛错", async () => {
  const result = await loadKnowledge(join(FIXTURE_ROOT, "no-such-knowledge-dir"));
  assert.deepEqual(result.entries, []);
  assert.equal(result.degraded, true);
  assert.ok(result.problems.length > 0);
});

test("未指定知识库目录时也降级为空", async () => {
  const result = await loadKnowledge(null);
  assert.deepEqual(result.entries, []);
  assert.equal(result.degraded, true);
});

test("加载知识库：根名来自文件名、children 被解析", async () => {
  const dir = await createFixture("kb-ok", {
    "local.json": JSON.stringify([
      {
        match: "Microsoft\\\\Edge",
        owner: "Microsoft Edge",
        purpose: "浏览器 profile",
        category: "browser-profile",
        safety: "mixed",
        confidence: "high",
        ifDeleted: "等于浏览器重置",
        children: [{ match: "User Data\\\\*\\\\Cache", safety: "safe", purpose: "网页缓存", ifDeleted: "自动重建" }],
        evidence: "实测",
      },
    ]),
  });
  try {
    const result = await loadKnowledge(dir);
    assert.equal(result.entries.length, 1);
    assert.equal(result.entries[0].root, "local");
    assert.equal(result.entries[0].safety, "mixed");
    assert.equal(result.entries[0].children.length, 1);
    assert.equal(result.entries[0].children[0].safety, "safe");
    assert.equal(result.degraded, false);
  } finally {
    await removeFixture(dir);
  }
});

test("坏 JSON 与非法条目只记录问题，不影响其它条目", async () => {
  const dir = await createFixture("kb-bad", {
    "local.json": "{ 这不是 JSON",
    "roaming.json": JSON.stringify([
      { match: "Foo", safety: "safe", category: "cache", confidence: "high", owner: "X", purpose: "p", ifDeleted: "d" },
      { match: "", safety: "safe" },
      { match: "Bar", safety: "maybe" },
    ]),
  });
  try {
    const result = await loadKnowledge(dir);
    assert.equal(result.entries.length, 1);
    assert.equal(result.entries[0].root, "roaming");
    assert.ok(result.problems.length >= 3);
  } finally {
    await removeFixture(dir);
  }
});

test("通配匹配：大小写不敏感、* 不跨层、** 跨层", () => {
  assert.ok(matchesPattern(patternInfo("Microsoft\\\\Edge"), "microsoft\\EDGE"));
  assert.ok(matchesPattern(patternInfo("Microsoft\\\\*"), "Microsoft\\Edge"));
  assert.ok(!matchesPattern(patternInfo("Microsoft\\\\*"), "Microsoft\\Edge\\User Data"));
  assert.ok(matchesPattern(patternInfo("**\\\\Cache"), "Microsoft\\Edge\\User Data\\Default\\Cache"));
  assert.equal(normalizeRelPath("/a//b/"), "a\\b");
  assert.deepEqual(pathSuffixes("a\\b\\c"), ["a\\b\\c", "b\\c", "c"]);
  assert.ok(globToRegExp("Cache").test("CACHE"));
});

test("matchEntry 优先精确匹配，其次更具体的通配", async () => {
  const dir = await createFixture("kb-rank", {
    "local.json": JSON.stringify([
      { match: "Microsoft\\\\**", safety: "safe", category: "cache", confidence: "medium", owner: "通配", purpose: "通配条目", ifDeleted: "d" },
      { match: "Microsoft\\\\Edge", safety: "never", category: "browser-profile", confidence: "high", owner: "精确", purpose: "精确条目", ifDeleted: "d" },
    ]),
  });
  try {
    const knowledge = await loadKnowledge(dir);
    const hit = matchEntry(knowledge, "local", "Microsoft\\Edge");
    assert.equal(hit.entry.owner, "精确");
    const miss = matchEntry(knowledge, "roaming", "Microsoft\\Edge");
    assert.equal(miss, null, "根名不同的条目不应命中");
    const viaSuffix = matchEntry(knowledge, "local", "Microsoft\\Edge\\User Data", { suffix: false });
    assert.equal(viaSuffix.entry.owner, "通配");
  } finally {
    await removeFixture(dir);
  }
});

test("matchRule 两层：相对父目录优先，其次相对根；不做尾段匹配", () => {
  const rules = [
    { match: "User Data\\\\*\\\\Cache", info: patternInfo("User Data\\\\*\\\\Cache"), safety: "safe" },
    { match: "Cache", info: patternInfo("Cache"), safety: "never" },
  ];
  const byParent = matchRule(rules, ["User Data\\Default\\Cache", "Edge\\User Data\\Default\\Cache"]);
  assert.equal(byParent.rule.match, "User Data\\\\*\\\\Cache");
  const bySuffix = matchRule(rules, ["Default\\Cache"]);
  assert.equal(bySuffix, null, "不含 Cache 单段的写法不应命中");
});
test("children 规则按具体度排序，不看声明顺序", () => {
  // 粗规则声明在前（catch-all 风格），具体规则在后：具体规则必须胜出
  const rules = [
    { match: "Edge\\*", info: patternInfo("Edge\\*"), safety: "never", order: 0 },
    { match: "Edge\\*\\Cache", info: patternInfo("Edge\\*\\Cache"), safety: "safe", order: 1 },
  ];
  const hit = matchRule(rules, ["Edge\\Default\\Cache"]);
  assert.equal(hit.rule.match, "Edge\\*\\Cache");
  assert.equal(hit.rule.safety, "safe");
  // 具体度相同则按声明顺序
  const tied = [
    { match: "**\\Cache", info: patternInfo("**\\Cache"), safety: "safe", order: 0 },
    { match: "Edge\\*", info: patternInfo("Edge\\*"), safety: "never", order: 5 },
  ];
  const tieHit = matchRule(tied, ["Edge\\Cache"]);
  assert.equal(tieHit.rule.match, "**\\Cache", "同具体度取声明靠前者");
  // 相对父路径优先于相对根路径
  const tiers = [
    { match: "Cache", info: patternInfo("Cache"), safety: "never", order: 9 },
    { match: "Microsoft\\Cache", info: patternInfo("Microsoft\\Cache"), safety: "safe", order: 0 },
  ];
  const tierHit = matchRule(tiers, ["Cache"], ["Microsoft\\Cache", "Cache"]);
  assert.equal(tierHit.rule.match, "Cache", "第一层（相对父）命中后不再看第二层");
});
