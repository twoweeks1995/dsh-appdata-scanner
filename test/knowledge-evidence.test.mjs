// 发布知识库与维护者笔记隔离，缺失笔记不改变判定。
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadKnowledge, matchEntry } from "../src/knowledge.mjs";
import { classifyEntry } from "../src/classifier.mjs";
import { renderMarkdown } from "../src/report.mjs";
import { createFixture, removeFixture } from "./helpers.mjs";

const knowledgeDir = fileURLToPath(new URL("../knowledge/", import.meta.url));

function withoutEvidence(entry) {
  const { evidence, ...rest } = entry;
  return rest;
}

test("三个发布 JSON 递归无 evidence 键且保持 168 主条目与 563 子规则", async () => {
  let count = 0;
  let children = 0;
  function check(value) {
    if (!value || typeof value !== "object") return;
    assert.equal(Object.hasOwn(value, "evidence"), false);
    for (const child of Object.values(value)) check(child);
  }
  for (const root of ["local", "roaming", "locallow"]) {
    const entries = JSON.parse(await readFile(join(knowledgeDir, root + ".json"), "utf8"));
    check(entries);
    count += entries.length;
    children += entries.reduce((n, entry) => n + entry.children.length, 0);
  }
  assert.equal(count, 168);
  assert.equal(children, 563);
});

test("显式笔记按文件根和原始 match 精确合并，不覆盖公开已有值", async () => {
  const raw = { match: "Shared", safety: "never", category: "app-data", children: [] };
  const dir = await createFixture("evidence-exact", {
    "knowledge/local.json": JSON.stringify([
      raw,
      { ...raw, match: "Existing", evidence: "公开已有证据" },
      { ...raw, match: "Empty", evidence: "" },
      { ...raw, match: "Normalized/Child" },
      { ...raw, match: "WrongCase" },
    ]),
    "knowledge/roaming.json": JSON.stringify([raw]),
    "notes.json": JSON.stringify({
      local: {
        Shared: "本地笔记",
        Existing: "不得覆盖",
        Empty: "不得填充",
        "Normalized/Child": "原始键笔记",
        wrongcase: "不得忽略大小写",
      },
      roaming: { Shared: "漫游笔记" },
    }),
  });
  try {
    const result = await loadKnowledge(join(dir, "knowledge"), { evidenceFile: join(dir, "notes.json") });
    assert.equal(result.degraded, false);
    assert.equal(matchEntry(result, "local", "Shared").entry.evidence, "本地笔记");
    assert.equal(matchEntry(result, "roaming", "Shared").entry.evidence, "漫游笔记");
    assert.equal(matchEntry(result, "local", "Existing").entry.evidence, "公开已有证据");
    assert.equal(matchEntry(result, "local", "Empty").entry.evidence, "");
    assert.equal(matchEntry(result, "local", "Normalized\\Child").entry.evidence, "原始键笔记");
    assert.equal(matchEntry(result, "local", "WrongCase").entry.evidence, "");
  } finally {
    await removeFixture(dir);
  }
});

test("默认加载同级私密笔记，缺失或损坏文件静默跳过且不降级", async () => {
  const raw = { match: "Demo", safety: "never", category: "app-data", children: [] };
  const dir = await createFixture("evidence-optional", {
    "knowledge/local.json": JSON.stringify([raw]),
    ".private/knowledge-evidence.json": JSON.stringify({ local: { Demo: "默认笔记" } }),
    "without/knowledge/local.json": JSON.stringify([raw]),
    "invalid.json": "{损坏笔记",
  });
  try {
    const loaded = await loadKnowledge(join(dir, "knowledge"));
    assert.equal(loaded.entries[0].evidence, "默认笔记");
    for (const result of [
      await loadKnowledge(join(dir, "without", "knowledge")),
      await loadKnowledge(join(dir, "knowledge"), { evidenceFile: join(dir, "missing.json") }),
      await loadKnowledge(join(dir, "knowledge"), { evidenceFile: join(dir, "invalid.json") }),
    ]) {
      assert.equal(result.entries[0].evidence, "");
      assert.equal(result.degraded, false);
      assert.deepEqual(result.problems, []);
    }
  } finally {
    await removeFixture(dir);
  }
});

test("私密笔记合并不改变真实 Steam 字段和父子匹配判定", async () => {
  const dir = await createFixture("evidence-semantics", {
    "notes.json": JSON.stringify({ local: { Steam: "合成维护者笔记" } }),
  });
  try {
    const plain = await loadKnowledge(knowledgeDir, { evidenceFile: join(dir, "missing.json") });
    const merged = await loadKnowledge(knowledgeDir, { evidenceFile: join(dir, "notes.json") });
    assert.deepEqual(merged.entries.map(withoutEvidence), plain.entries.map(withoutEvidence));
    assert.equal(matchEntry(merged, "local", "Steam").entry.evidence, "合成维护者笔记");
    const scan = {
      root: "local", relPath: "Steam", childNames: ["htmlcache"],
      children: [{ name: "htmlcache", bytes: 100, files: 1 }],
      descendants: [{ relPath: "htmlcache\\Default\\Cache", depth: 3, bytes: 50, files: 1 }],
    };
    const before = classifyEntry(scan, plain);
    const after = classifyEntry(scan, merged);
    assert.equal(after.safety, "mixed");
    assert.equal(after.safety, before.safety);
    assert.equal(after.purpose, before.purpose);
    assert.deepEqual(after.children.map(withoutEvidence), before.children.map(withoutEvidence));
    assert.equal(after.children.find((child) => child.relPathFromParent === "htmlcache\\Default\\Cache").safety, "safe");
  } finally {
    await removeFixture(dir);
  }
});

test("缺失维护者笔记时，证据列显示规则来源摘要且不含机器信息", async () => {
  const dir = await createFixture("evidence-report", {
    "notes.json": JSON.stringify({ local: { Steam: "合成维护者笔记" } }),
  });
  try {
    const knowledge = await loadKnowledge(knowledgeDir, { evidenceFile: join(dir, "missing.json") });
    const judgement = classifyEntry({ root: "local", relPath: "Steam" }, knowledge);
    // classifier 的兜底会生成"知识库条目：<文件名> match=<模式>"，这是规则来源摘要而非原始证据。
    assert.equal(judgement.evidence, "知识库条目：local.json match=Steam");
    assert.doesNotMatch(judgement.evidence, /[A-Za-z]:[\\/]/, "不得出现盘符或绝对路径");
    assert.doesNotMatch(judgement.evidence, /「/, "不得出现中文引号包裹的用户命名");
    assert.doesNotMatch(judgement.evidence, /」|(?:^|\s)\/(?:[^\s/]+\/)/, "不得出现用户命名或 Bash 绝对路径");
    const markdown = renderMarkdown([judgement], {});
    const evidenceSection = markdown.split("## 判定依据摘要")[1];
    assert.ok(evidenceSection);
    assert.ok(
      evidenceSection.split("\n").some((line) => line.startsWith("| Steam |") && line.includes("知识库条目：local.json match=Steam")),
      "证据列应显示规则来源摘要",
    );
    const merged = await loadKnowledge(knowledgeDir, { evidenceFile: join(dir, "notes.json") });
    const withNotes = classifyEntry({ root: "local", relPath: "Steam" }, merged);
    assert.equal(withNotes.evidence, "合成维护者笔记");
    const withNotesReport = renderMarkdown([withNotes], {});
    assert.ok(withNotesReport.includes("合成维护者笔记"));
    assert.doesNotMatch(withNotesReport, /知识库条目：local\.json match=Steam/);
  } finally {
    await removeFixture(dir);
  }
});
