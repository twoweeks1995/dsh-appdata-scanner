// 真实知识库的保守语义与分类输出约束。
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  CATEGORIES,
  ROOT_NAMES,
  coerceEntry,
  loadKnowledge,
  matchEntry,
  matchRule,
} from "../src/knowledge.mjs";
import { classifyEntry } from "../src/classifier.mjs";

const knowledgeDir = new URL("../knowledge/", import.meta.url);
const knowledge = await loadKnowledge(fileURLToPath(knowledgeDir));

function synthetic(root, relPath, childNames = [], descendantPaths = []) {
  return {
    root,
    relPath,
    bytes: 100,
    files: 1,
    childNames,
    children: childNames.map((name) => ({ name, bytes: 100, files: 1 })),
    descendants: descendantPaths.map((relPath) => ({
      relPath,
      depth: relPath.split("\\").length,
      bytes: 50,
      files: 1,
    })),
  };
}

function childAt(judgement, relPath) {
  const child = judgement.children.find((item) => item.relPathFromParent === relPath);
  assert.ok(child, "分类结果应包含子路径：" + relPath);
  return child;
}

function rulesFor(root, relPath) {
  const hit = matchEntry(knowledge, root, relPath);
  assert.ok(hit, "真实知识库应命中：" + root + "\\" + relPath);
  return hit.entry.children;
}

test("真实知识库保持 168 主条目、563 子规则及合法分类约束", async () => {
  assert.equal(knowledge.degraded, false);
  assert.deepEqual(knowledge.problems, []);
  assert.equal(knowledge.entries.length, 168);
  assert.equal(knowledge.entries.reduce((count, entry) => count + entry.children.length, 0), 563);
  for (const root of ROOT_NAMES) {
    const entries = JSON.parse(await readFile(new URL(root + ".json", knowledgeDir), "utf8"));
    for (const entry of entries) {
      assert.ok(CATEGORIES.includes(entry.category), root + "\\" + entry.match + " 的分类必须合法");
      assert.ok(Array.isArray(entry.children), "子规则必须为数组");
      if (entry.safety === "mixed") assert.ok(entry.children.length > 0, "混合主条目必须有子规则");
      for (const child of entry.children) {
        assert.ok(["safe", "mixed", "never"].includes(child.safety), "子规则只允许可删除、混合或不可删除：" + child.match);
      }
    }
  }
});

test("mixed 子规则必须有更具体的子规则（容器必须可以展开）", () => {
  for (const entry of knowledge.entries) {
    for (const parent of entry.children) {
      if (parent.safety !== "mixed") continue;
      const prefix = parent.match.toLowerCase() + "\\";
      assert.ok(entry.children.some((child) => child.match.toLowerCase().startsWith(prefix)),
        "混合子规则必须有更具体的子规则：" + entry.root + "\\" + entry.match + " → " + parent.match);
    }
  }
});

test("父级判为 safe 时不得存在更具体的 never 后代（否则母目录应当是 mixed）", () => {
  const under = (parent, child) => {
    const p = String(parent).toLowerCase();
    const c = String(child).toLowerCase();
    return c !== p && c.startsWith(p + "\\");
  };
  for (const entry of knowledge.entries) {
    for (const parent of entry.children) {
      if (parent.safety !== "safe") continue;
      for (const child of entry.children) {
        if (child.safety !== "never") continue;
        assert.equal(under(parent.match, child.match), false,
          "父规则 " + parent.match + " 判为可删除，但其下 " + child.match + " 判为不可删除 —— 母目录应为 mixed");
      }
    }
    if (entry.safety === "safe") {
      for (const child of entry.children) {
        assert.notEqual(child.safety, "never",
          "主条目 " + entry.match + " 判为可删除，但子规则 " + child.match + " 判为不可删除");
      }
    }
  }
});

test("每条主条目与子规则都必须写清用途（说明比判断重要）", () => {
  for (const entry of knowledge.entries) {
    assert.ok(String(entry.purpose || "").trim().length >= 6, "主条目必须说明用途：" + entry.root + "\\" + entry.match);
    assert.ok(String(entry.ifDeleted || "").trim().length > 0, "主条目必须说明删除后果：" + entry.match);
    for (const child of entry.children) {
      assert.ok(String(child.purpose || "").trim().length >= 4, "子规则必须说明用途：" + entry.match + " → " + child.match);
      assert.ok(String(child.ifDeleted || "").trim().length > 0, "子规则必须说明删除后果：" + entry.match + " → " + child.match);
    }
  }
});

test("P1 通配规则覆盖多 profile、多版本并保护用户目录", () => {
  const required = [
    ["local", "Mozilla\\Firefox", "Profiles\\*\\cache2", "safe"],
    ["local", "Mozilla\\Firefox", "Profiles\\*", "mixed"],
    ["local", "Zotero", "Zotero\\Profiles\\*\\cache2", "safe"],
    ["local", "Zotero", "Zotero\\Profiles\\*", "mixed"],
    ["local", "Zotero", "updates\\*\\*", "safe"],
    ["local", "Python", "pythoncore-*\\Doc", "safe"],
    ["local", "Python", "pythoncore-*\\Lib", "never"],
    ["local", "node-gyp", "Cache\\*\\include", "safe"],
    ["local", "Temp\\Diagnostics", "*", "safe"],
  ];
  for (const [root, parent, match, safety] of required) {
    assert.ok(rulesFor(root, parent).some((rule) => rule.match === match && rule.safety === safety), root + "\\" + parent + "\\" + match);
  }
});

// 本次删除依据是“文件不参与判定”契约（2026-10 用户决策）。
// 带点目录名（如 app-4.19.1、act-webstatic.mihoyo.com）合法，不属于文件扩展名拦截范围。
test("三个知识库没有文件扩展名或已知无扩展名文件的子规则", async () => {
  const fileExtension = /\.(?:json|db|sqlite|log|hive|ini|exe|msi|tmp|dat|config|xml|txt|ldb|pdb)$/i;
  const fileName = /^(?:Cookies|Hosts|npmrc|Login Data|Visited Links|Bookmarks|Preferences|Local State|History|Web Data|Top Sites)$/i;
  const filePattern = /^(f|data)_\*$/i;
  for (const root of ROOT_NAMES) {
    const entries = JSON.parse(await readFile(new URL(root + ".json", knowledgeDir), "utf8"));
    for (const entry of entries) {
      for (const child of entry.children) {
        const label = root + "\\" + entry.match + "\\" + child.match;
        assert.equal(fileExtension.test(child.match), false, "子规则不能指向带文件扩展名的文件：" + label);
        assert.equal(fileName.test(child.match.split("\\").at(-1)), false, "子规则不能指向已知无扩展名文件：" + label);
        assert.equal(filePattern.test(child.match.split("\\").at(-1)), false, "子规则不能指向通配缓存文件：" + label);
      }
    }
  }
});

test("带点的目录子规则仍然保留", () => {
  assert.ok(rulesFor("local", "Mudlet").some((child) => child.match === "app-4.19.1"));
  assert.ok(rulesFor("local", "JetBrains").some((child) => child.match === "*\\index"));
  for (const app of ["CherryStudio", "aDrive"]) {
    const rules = rulesFor("roaming", app);
    assert.equal(rules.filter((child) => child.match.startsWith("Partitions")).length, 11);
    for (const name of ["Cache", "Code Cache", "GPUCache"]) {
      assert.ok(rules.some((child) => child.match === "Partitions\\*\\" + name && child.safety === "safe"));
    }
  }
  assert.ok(rulesFor("locallow", "miHoYo").some((child) => child.match === "崩坏：星穹铁道\\act-webstatic.mihoyo.com"));
});

test("Roaming 的 Microsoft 用户词典 UProof 与 Spelling 不可删除", () => {
  const result = classifyEntry(synthetic("roaming", "Microsoft", ["UProof", "Spelling"]), knowledge);
  for (const path of ["UProof", "Spelling"]) {
    assert.equal(childAt(result, path).safety, "never");
    assert.equal(childAt(result, path).matchedBy, "knowledge-child");
  }
});

for (const app of ["CherryStudio", "aDrive"]) {
  test("Roaming 的 " + app + " 分区容器不可整删，具体缓存可拆分", () => {
    const rules = rulesFor("roaming", app);
    assert.equal(matchRule(rules, "Partitions").rule.safety, "mixed");
    const containerOnly = classifyEntry(synthetic("roaming", app, ["Partitions"]), knowledge);
    assert.equal(childAt(containerOnly, "Partitions").safety, "mixed");
    const cachePath = "Partitions\\default\\Cache";
    const split = classifyEntry(synthetic("roaming", app, ["Partitions"], [cachePath]), knowledge);
    assert.equal(childAt(split, "Partitions").safety, "mixed");
    assert.equal(childAt(split, cachePath).safety, "safe");
    assert.equal(childAt(split, cachePath).rule, "Partitions\\*\\Cache");
  });
}

test("Roaming 的 Netease\\UU\\webview2cache 未确认内容前不可删除", () => {
  const path = "UU\\webview2cache";
  const result = classifyEntry(synthetic("roaming", "Netease", ["UU"], [path]), knowledge);
  assert.equal(childAt(result, path).safety, "never");
  assert.equal(childAt(result, path).rule, path);
});

test("LocalLow 的 Mozilla 不能因单次空目录样本判为可删除", () => {
  const result = classifyEntry(synthetic("locallow", "Mozilla"), knowledge);
  assert.equal(result.safety, "never");
  assert.equal(result.matchedBy, "knowledge");
});

test("Local 的 Steam 为混合数据，htmlcache 保留而明确资源缓存可删除", () => {
  const rules = rulesFor("local", "Steam");
  assert.equal(matchEntry(knowledge, "local", "Steam").entry.safety, "mixed");
  assert.equal(matchRule(rules, "htmlcache").rule.safety, "mixed");
  assert.equal(matchRule(rules, "htmlcache\\Default\\Cache").rule.safety, "safe");
  const containerOnly = classifyEntry(synthetic("local", "Steam", ["htmlcache"]), knowledge);
  assert.equal(containerOnly.safety, "mixed");
  assert.equal(childAt(containerOnly, "htmlcache").safety, "mixed");
  const cachePath = "htmlcache\\Default\\Cache";
  const split = classifyEntry(synthetic("local", "Steam", ["htmlcache"], [cachePath]), knowledge);
  assert.equal(childAt(split, "htmlcache").safety, "mixed");
  assert.equal(childAt(split, cachePath).safety, "safe");
});

test("不可删除的星号兜底提前声明也不覆盖新增具体缓存规则", async () => {
  for (const [root, app, path] of [
    ["roaming", "CherryStudio", "Partitions\\default\\Cache"],
    ["roaming", "aDrive", "Partitions\\default\\Cache"],
    ["local", "Steam", "htmlcache\\Default\\Cache"],
  ]) {
    const entries = JSON.parse(await readFile(new URL(root + ".json", knowledgeDir), "utf8"));
    const raw = entries.find((entry) => entry.match === app);
    const fallback = raw.children.find((child) => child.match === "*" && child.safety === "never");
    assert.ok(fallback, "真实条目必须有不可删除的星号兜底");
    const { entry, notes } = coerceEntry({
      ...raw,
      children: [fallback, ...raw.children.filter((child) => child !== fallback)],
    }, { root });
    assert.deepEqual(notes, []);
    assert.equal(matchRule(entry.children, "未确认组件").rule.safety, "never");
    const hit = matchRule(entry.children, path);
    assert.ok(hit);
    assert.equal(hit.rule.safety, "safe");
    assert.notEqual(hit.rule.match, "*");
  }
});
