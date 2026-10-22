// test/classifier.test.mjs —— 判定优先级：知识库 -> 混合拆子项 -> 启发式 -> 推测
import test from "node:test";
import assert from "node:assert/strict";

import {
  classifyEntry,
  classifyEntries,
  hasDatabase,
  heuristicVerdict,
  guessVerdict,
  safetyLabel,
  summarize,
} from "../src/classifier.mjs";
import { loadKnowledge } from "../src/knowledge.mjs";
import { scan } from "../src/scanner.mjs";
import { createFixture, makeChild, makeEntry, removeFixture } from "./helpers.mjs";

test("知识库命中优先于启发式", async () => {
  const kbDir = await createFixture("cls-kb", {
    "local.json": JSON.stringify([
      {
        match: "CacheFace",
        owner: "Fixture Corp",
        purpose: "知识库里的缓存目录",
        category: "cache",
        safety: "safe",
        confidence: "high",
        ifDeleted: "自动重建",
        evidence: "夹具知识库",
      },
    ]),
  });
  try {
    const knowledge = await loadKnowledge(kbDir);
    const judgement = classifyEntry(makeEntry("CacheFace", { bytes: 2048 }), knowledge);
    assert.equal(judgement.matchedBy, "knowledge");
    assert.equal(judgement.owner, "Fixture Corp");
    assert.equal(judgement.safety, "safe");
    assert.equal(judgement.confidence, "high");
    assert.equal(judgement.purpose, "知识库里的缓存目录");
  } finally {
    await removeFixture(kbDir);
  }
});

test("知识库 mixed 条目按 children 拆分出子项判定", async () => {
  const kbDir = await createFixture("cls-split", {
    "local.json": JSON.stringify([
      {
        match: "PlainBits",
        owner: "Fixture Corp",
        purpose: "混合目录",
        category: "app-data",
        safety: "mixed",
        confidence: "high",
        ifDeleted: "整删会有损失",
        children: [
          { match: "sub", safety: "safe", purpose: "可重建的子目录", ifDeleted: "自动重建" },
          { match: "data.txt", safety: "never", purpose: "用户数据", ifDeleted: "丢失" },
        ],
      },
    ]),
  });
  try {
    const knowledge = await loadKnowledge(kbDir);
    const entry = makeEntry("PlainBits", {
      bytes: 4096,
      children: [makeChild("sub", { bytes: 3000 }), makeChild("unknownish", { bytes: 1000 })],
      rootFiles: [{ name: "data.txt", bytes: 96 }],
    });
    const judgement = classifyEntry(entry, knowledge);
    assert.equal(judgement.safety, "mixed");
    assert.equal(judgement.children.length, 3);
    const byName = {};
    for (const child of judgement.children) byName[child.name] = child;
    assert.equal(byName.sub.safety, "safe");
    assert.equal(byName.sub.matchedBy, "knowledge-child");
    assert.equal(byName["data.txt"].safety, "never");
    assert.equal(byName.unknownish.safety, "mixed");
    assert.equal(byName.unknownish.needsReview, true);
  } finally {
    await removeFixture(kbDir);
  }
});

test("没有知识库时靠启发式给出合理结果", () => {
  const cache = classifyEntry(makeEntry("CacheFace", { childNames: ["Cache"] }), []);
  assert.equal(cache.safety, "safe");
  assert.equal(cache.category, "cache");
  assert.equal(cache.confidence, "low");
  assert.equal(cache.matchedBy, "heuristic");

  const logs = classifyEntry(makeEntry("LogOnly", { exts: ["log"], logFiles: 2, files: 2 }), []);
  assert.equal(logs.safety, "safe");
  assert.equal(logs.category, "logs");

  const store = classifyEntry(makeEntry("Store", { exts: ["db"], rootFiles: [{ name: "settings.db", bytes: 4096 }] }), []);
  assert.equal(store.safety, "never");

  const levelDb = classifyEntry(makeEntry("Sessions", { exts: ["ldb"], levelDb: true }), []);
  assert.equal(levelDb.safety, "never");
  assert.equal(hasDatabase(makeEntry("Sessions", { levelDb: true })), true);
});

test("SPEC 优先级：缓存名规则先于数据库规则", () => {
  const judgement = classifyEntry(
    makeEntry("CacheStore", { exts: ["db"], rootFiles: [{ name: "x.db", bytes: 10 }] }),
    [],
  );
  assert.equal(judgement.safety, "safe");
  assert.equal(judgement.category, "cache");
  assert.ok(
    judgement.hints.some((hint) => hint.indexOf("数据库") >= 0),
    "命中缓存名但仍应提示目录含数据库",
  );
});

test("无法判定时回落到推测：mixed + low + 【推测】前缀 + 子项拆分", () => {
  const entry = makeEntry("PlainBits", {
    bytes: 3000,
    files: 3,
    exts: ["txt", "md"],
    children: [makeChild("sub", { bytes: 2000 }), makeChild("inner", { bytes: 800 })],
    rootFiles: [{ name: "readme.txt", bytes: 100 }],
  });
  const judgement = classifyEntry(entry, []);
  assert.equal(judgement.safety, "mixed");
  assert.equal(judgement.confidence, "low");
  assert.equal(judgement.matchedBy, "guess");
  assert.ok(judgement.purpose.startsWith("【推测】"));
  assert.equal(judgement.needsReview, true);
  assert.equal(judgement.children.length, 3);
  assert.equal(guessVerdict({ kind: "file", name: "x.dat" }).safety, "never");
  assert.equal(heuristicVerdict({ kind: "dir", name: "PlainBits", exts: ["txt"], rootFiles: [], childNames: [] }), null);
});

test("真实目录：1~3 个 >50MB 安装包走 updater/mixed 并拆出安装包子项", async () => {
  const dir = await createFixture("cls-installer", {
    "Installer/Setup.exe": 52 * 1024 * 1024,
    "Installer/Update.msi": 51 * 1024 * 1024,
  });
  try {
    const doc = await scan({ roots: { local: dir }, rootNames: ["local"], minMb: 0 });
    const judgement = classifyEntry(doc.entries[0], []);
    assert.equal(judgement.category, "updater");
    assert.equal(judgement.safety, "mixed");
    assert.equal(judgement.children.length, 2);
    for (const child of judgement.children) {
      assert.equal(child.safety, "safe", "安装包子项应判为可安全删除");
      assert.equal(child.category, "installer-cache");
    }
  } finally {
    await removeFixture(dir);
  }
});

test("summarize 汇总体积，可回收体积包含混合目录中的安全子项", () => {
  const judgements = classifyEntries(
    [
      makeEntry("Temp", { bytes: 1000, files: 2 }),
      makeEntry("PlainBits", {
        bytes: 5000,
        children: [makeChild("cache", { bytes: 3000 }), makeChild("keep", { bytes: 2000, exts: ["db"] })],
      }),
      makeEntry("Store", { bytes: 900, exts: ["db"], rootFiles: [{ name: "s.db", bytes: 900 }] }),
    ],
    [],
  );
  const summary = summarize(judgements);
  assert.equal(summary.entries, 3);
  assert.equal(summary.safe, 1);
  assert.equal(summary.mixed, 1);
  assert.equal(summary.never, 1);
  assert.equal(summary.totalBytes, 6900);
  assert.ok(summary.recoverableBytes > summary.safeBytes);
  assert.equal(summary.recoverableBytes, 1000 + 3000);
  for (const judgement of judgements) {
    if (judgement.safety === "mixed") assert.ok(judgement.children.length > 0, "混合目录必须有 children 拆分");
  }
  assert.equal(safetyLabel("mixed"), "需拆分确认");
});
test("深层 descendants 命中 children 规则，更具体的后代压倒较粗祖先，同安全级后代折叠", async () => {
  const kbDir = await createFixture("cls-deep", {
    "local.json": JSON.stringify([
      {
        match: "Microsoft",
        owner: "Microsoft",
        purpose: "微软目录",
        category: "app-data",
        safety: "mixed",
        confidence: "high",
        ifDeleted: "整删等于重装",
        children: [
          { match: "Edge\\User Data\\*\\Cache", safety: "safe", purpose: "网页缓存", ifDeleted: "自动重建" },
          { match: "Edge", safety: "never", purpose: "浏览器数据", ifDeleted: "丢失书签" },
          { match: "*", safety: "never", purpose: "兜底", ifDeleted: "未知" },
        ],
      },
    ]),
  });
  try {
    const knowledge = await loadKnowledge(kbDir);
    const entry = makeEntry("Microsoft", {
      bytes: 9000,
      children: [
        makeChild("Edge", { bytes: 6000, exts: ["db"], childNames: ["User Data"] }),
        makeChild("Windows", { bytes: 3000, exts: ["dll"] }),
      ],
      descendants: [
        { depth: 3, relPath: "Edge\\User Data\\Default\\Cache", bytes: 2000, files: 9, exts: ["bin"], levelDb: false },
        { depth: 2, relPath: "Windows\\INetCache", bytes: 1200, files: 4, exts: ["tmp"], levelDb: false },
      ],
    });
    const judgement = classifyEntry(entry, knowledge);
    assert.equal(judgement.safety, "mixed");
    const byPath = {};
    for (const child of judgement.children) byPath[child.relPathFromParent] = child;
    const cache = byPath["Edge\\User Data\\Default\\Cache"];
    assert.ok(cache, "深层路径应被展开：" + Object.keys(byPath).join(", "));
    assert.equal(cache.safety, "safe");
    assert.equal(cache.rule, "Edge\\User Data\\*\\Cache");
    assert.equal(cache.absPath.endsWith("Microsoft\\Edge\\User Data\\Default\\Cache"), true);
    const edge = byPath.Edge;
    assert.equal(edge.safety, "mixed", "较粗的 never 祖先被更具体的规则压倒，降级为 mixed");
    assert.ok(edge.purpose.indexOf("更具体") >= 0);
    const windows = byPath.Windows;
    assert.equal(windows.safety, "never", "未被子规则覆盖的路径仍按自身规则判 never");
    assert.equal(
      byPath["Windows\\INetCache"],
      undefined,
      "同一子树的同安全级后代折叠到最上层，不再重复占行",
    );
  } finally {
    await removeFixture(kbDir);
  }
});
test("兜底 * 规则不得吞掉已被更具体规则统辖的子树", async () => {
  const kbDir = await createFixture("cls-catchall", {
    "roaming.json": JSON.stringify([
      {
        match: "Tencent",
        owner: "Tencent",
        purpose: "腾讯目录",
        category: "app-data",
        safety: "mixed",
        confidence: "high",
        ifDeleted: "整删会丢聊天记录",
        children: [
          { match: "xwechat\\update", safety: "safe", purpose: "更新包", ifDeleted: "下次更新重新下载" },
          { match: "*", safety: "never", purpose: "兜底", ifDeleted: "未知" },
        ],
      },
    ]),
  });
  try {
    const knowledge = await loadKnowledge(kbDir);
    const entry = makeEntry("Tencent", {
      root: "roaming",
      bytes: 5000,
      children: [makeChild("xwechat", { bytes: 4000 })],
      descendants: [
        { depth: 2, relPath: "xwechat\\update", bytes: 1000, files: 5, exts: ["patch"] },
        { depth: 3, relPath: "xwechat\\update\\patch", bytes: 800, files: 3, exts: ["patch"] },
      ],
    });
    const judgement = classifyEntry(entry, knowledge);
    const byPath = {};
    for (const child of judgement.children) byPath[child.relPathFromParent] = child;
    assert.equal(byPath["xwechat\\update"].safety, "safe", "更具体的 safe 规则必须压住内部 * 兜底");
    assert.equal(byPath["xwechat\\update\\patch"], undefined, "被更具体祖先统辖的 * 命中应被丢弃");
    assert.equal(byPath.xwechat.safety, "mixed", "上层保留但降级为需拆分");
    assert.equal(byPath.xwechat.matchedBy, "knowledge-child");
  } finally {
    await removeFixture(kbDir);
  }
});
