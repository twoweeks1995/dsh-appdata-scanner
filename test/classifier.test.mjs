// test/classifier.test.mjs —— 判定优先级：知识库 -> 混合拆子项 -> 启发式 -> 推测
import test from "node:test";
import assert from "node:assert/strict";

import {
  classifyEntry,
  classifyEntries,
  childUnits,
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
          { match: "data", safety: "never", purpose: "用户数据目录", ifDeleted: "丢失" },
        ],
      },
    ]),
  });
  try {
    const knowledge = await loadKnowledge(kbDir);
    const entry = makeEntry("PlainBits", {
      bytes: 4096,
      children: [makeChild("sub", { bytes: 3000 }), makeChild("unknownish", { bytes: 1000 }), makeChild("data", { bytes: 96 })],
      rootFiles: [{ name: "data.txt", bytes: 96 }],
    });
    const judgement = classifyEntry(entry, knowledge);
    assert.equal(judgement.safety, "mixed");
    assert.equal(judgement.children.length, 3);
    const byName = {};
    for (const child of judgement.children) byName[child.name] = child;
    assert.equal(byName.sub.safety, "safe");
    assert.equal(byName.sub.matchedBy, "knowledge-child");
    assert.equal(byName.data.safety, "never");
    assert.equal(byName["data.txt"], undefined, "散落文件不成为判定子项");
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

// 2026-10 用户批准的 C2 决策：缓存名不能掩盖数据库，含数据库时需拆分确认。
test("SPEC C2（2026-10）：缓存名含数据库降级为 mixed", () => {
  const judgement = classifyEntry(makeEntry("CacheStore", { exts: ["db"] }), []);
  assert.equal(judgement.safety, "mixed");
  assert.equal(judgement.category, "cache");
  assert.equal(judgement.confidence, "low");
  assert.equal(judgement.matchedBy, "heuristic");
  assert.equal(judgement.basis, "cache-name-with-database");
  assert.equal(judgement.owner, "未知");
  assert.equal(judgement.needsReview, true);
  assert.match(judgement.purpose, /CacheStore.*含数据库.*不能整块删除.*拆分确认/);
  assert.match(judgement.ifDeleted, /数据库.*用户数据.*自动重建/);
  assert.match(judgement.evidence, /CacheStore.*数据库/);
  assert.ok(
    judgement.hints.some((hint) => hint.includes("数据库")) || judgement.purpose.includes("含数据库"),
    "缓存名降级后仍应保留含数据库的线索",
  );
});

test("C2 回归：缓存名不含数据库仍为 safe/low", () => {
  const judgement = classifyEntry(makeEntry("Temp", { exts: ["txt"] }), []);
  assert.equal(judgement.safety, "safe");
  assert.equal(judgement.category, "cache");
  assert.equal(judgement.confidence, "low");
  assert.equal(judgement.matchedBy, "heuristic");
  assert.equal(judgement.basis, "cache-name");
  assert.equal(judgement.needsReview, false);
});

test("C2 回归：缓存名目录 levelDb 为 true 时降级为 mixed", () => {
  const judgement = classifyEntry(makeEntry("Cache", { levelDb: true, exts: [] }), []);
  assert.equal(judgement.safety, "mixed");
  assert.equal(judgement.basis, "cache-name-with-database");
  assert.equal(judgement.needsReview, true);
});

test("C2 回归：仅 rootFiles 的数据库文件名也触发缓存名降级", () => {
  const judgement = classifyEntry(
    makeEntry("Temp", { exts: [], rootFiles: [{ name: "x.db", bytes: 10 }] }),
    [],
  );
  assert.equal(judgement.safety, "mixed");
  assert.equal(judgement.basis, "cache-name-with-database");
  assert.equal(judgement.needsReview, true);
});

test("C2 回归：缓存名含数据库的 mixed 复用既有 children 拆分", () => {
  const judgement = classifyEntry(
    makeEntry("CacheStore", {
      exts: ["db", "txt"],
      children: [makeChild("Cache", { bytes: 100 }), makeChild("Store", { exts: ["db"], bytes: 200 })],
    }),
    [],
  );
  assert.equal(judgement.safety, "mixed");
  assert.ok(Array.isArray(judgement.children));
  assert.equal(judgement.children.length, 2);
  assert.equal(judgement.children.find((child) => child.name === "Cache").safety, "safe");
  assert.equal(judgement.children.find((child) => child.name === "Store").safety, "never");
});

test("C2 回归：缓存名含数据库但无可拆项时保留既有提示", () => {
  const judgement = classifyEntry(makeEntry("Cache", { exts: ["sqlite"] }), []);
  assert.equal(judgement.safety, "mixed");
  assert.ok(Array.isArray(judgement.children));
  assert.equal(judgement.children.length, 0);
  assert.ok(judgement.hints.some((hint) => hint.includes("未发现可拆分")));
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
  assert.equal(judgement.children.length, 2);
  assert.equal(guessVerdict({ kind: "dir", name: "unknown" }).safety, "mixed");
  assert.equal(heuristicVerdict({ kind: "dir", name: "PlainBits", exts: ["txt"], rootFiles: [], childNames: [] }), null);
});

test("真实目录：1~3 个 >50MB 安装包仍走 updater/mixed 但不拆成文件单元", async () => {
  const dir = await createFixture("cls-installer", {
    "Installer/Setup.exe": 52 * 1024 * 1024,
    "Installer/Update.msi": 51 * 1024 * 1024,
  });
  try {
    const doc = await scan({ roots: { local: dir }, rootNames: ["local"], minMb: 0 });
    const judgement = classifyEntry(doc.entries[0], []);
    assert.equal(judgement.category, "updater");
    assert.equal(judgement.safety, "mixed");
    assert.equal(judgement.children.length, 0);
    assert.ok(judgement.hints.some((hint) => hint.includes("未发现可拆分")));
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

test("rootFiles 不成为文件子项，也不改变其它目录子项判定", () => {
  const entry = makeEntry("PlainBits", {
    // 真实扫描中 childNames 必然包含 children 的名字;夹具必须自洽,否则会误触发规则 3(根下无子目录的 updater 判定)
    childNames: ["sub", "logs"],
    children: [makeChild("sub"), makeChild("logs", { exts: ["log"] })],
  });
  const baseline = classifyEntry(entry, []);
  const judgement = classifyEntry({ ...entry, rootFiles: [{ name: "big.exe", bytes: 60 * 1024 * 1024 }] }, []);
  assert.ok(judgement.children.every((child) => child.kind === "dir"));
  assert.ok(!judgement.children.some((child) => child.kind === "file" || child.name === "big.exe"));
  assert.deepEqual(judgement.children, baseline.children, "文件名不能作为子目录判定依据");
  for (const field of ["safety", "category", "matchedBy", "basis", "purpose"]) {
    assert.equal(judgement[field], baseline[field]);
  }
});

test("混合目录保留真实空子目录并从 childNames 补缺，不重复且只补一级", () => {
  const entry = makeEntry("PlainBits", {
    children: [makeChild("realEmpty", { bytes: 0, files: 0, exts: [] }), makeChild("sub", { childNames: ["nestedEmpty"] })],
    childNames: ["realEmpty", "sub", "missingEmpty", "missingEmpty"],
  });
  const units = childUnits(entry);
  assert.equal(units.length, 3);
  const empty = units.find((unit) => unit.name === "missingEmpty");
  assert.equal(empty.kind, "dir");
  assert.equal(empty.depth, 1);
  assert.equal(empty.bytes, 0);
  assert.equal(empty.files, 0);
  assert.deepEqual(empty.exts, []);
  assert.deepEqual(empty.rootFiles, []);
  assert.ok(!units.some((unit) => unit.name === "nestedEmpty"));
  const judgement = classifyEntry(entry, []);
  assert.equal(judgement.safety, "mixed");
  assert.equal(judgement.children.length, 3);
  for (const name of ["realEmpty", "missingEmpty"]) {
    const child = judgement.children.find((item) => item.name === name);
    assert.equal(child.kind, "dir");
    assert.equal(child.bytes, 0);
    assert.equal(child.files, 0);
  }
});

test("补入的空子目录正常命中知识库子规则安全级", async () => {
  const kbDir = await createFixture("cls-empty-rule", {
    "local.json": JSON.stringify([{
      match: "PlainBits", owner: "Fixture Corp", purpose: "混合目录", category: "app-data",
      safety: "mixed", confidence: "high", ifDeleted: "整删会有损失",
      children: [
        { match: "emptySafe", safety: "safe", purpose: "可重建目录", ifDeleted: "自动重建" },
        { match: "emptyKeep", safety: "never", purpose: "用户目录", ifDeleted: "丢失" },
      ],
    }]),
  });
  try {
    const knowledge = await loadKnowledge(kbDir);
    const judgement = classifyEntry(makeEntry("PlainBits", { childNames: ["emptySafe", "emptyKeep"] }), knowledge);
    assert.equal(judgement.children.length, 2);
    for (const [name, safety] of [["emptySafe", "safe"], ["emptyKeep", "never"]]) {
      const child = judgement.children.find((item) => item.name === name);
      assert.equal(child.kind, "dir");
      assert.equal(child.bytes, 0);
      assert.equal(child.files, 0);
      assert.equal(child.safety, safety);
      assert.equal(child.matchedBy, "knowledge-child");
      assert.equal(child.rule, name);
    }
  } finally {
    await removeFixture(kbDir);
  }
});

test("130 个子目录含 10 个空目录时仍保留 120 个真实子项及准确省略行", () => {
  const children = Array.from({ length: 120 }, (_, i) => makeChild("part" + i, { bytes: i + 1 }));
  const emptyNames = Array.from({ length: 10 }, (_, i) => "empty" + i);
  const entry = makeEntry("PlainBits", { children, childNames: [...children.map((child) => child.name), ...emptyNames] });
  const units = childUnits(entry);
  assert.equal(units.length, 130);
  assert.equal(units.filter((unit) => unit.files === 0 && unit.bytes === 0).length, 10);
  const judgement = classifyEntry(entry, []);
  assert.equal(judgement.children.length, 121);
  const omitted = judgement.children.find((child) => child.name === "…");
  assert.ok(omitted);
  assert.match(omitted.purpose, /还有 10 个子项未列出/);
  assert.equal(omitted.bytes, 0);
  const kept = judgement.children.filter((child) => child !== omitted);
  assert.equal(kept.length, 120);
  assert.ok(kept.every((child) => child.bytes > 0));
  assert.deepEqual(new Set(kept.map((child) => child.name)), new Set(children.map((child) => child.name)));
});
