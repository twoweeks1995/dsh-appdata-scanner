// test/plan.test.mjs —— 只出计划与命令，绝不执行
import test from "node:test";
import assert from "node:assert/strict";

import { buildPlan, renderPlan, renderPlanMarkdown, renderPlanTable } from "../src/plan.mjs";
import { classifyEntries, summarize } from "../src/classifier.mjs";
import { makeChild, makeEntry } from "./helpers.mjs";
import { loadKnowledge } from "../src/knowledge.mjs";
import { fileURLToPath } from "node:url";

const TEMP_PATH = "C:\\Users\\fixture\\AppData\\Local\\Temp";
const CONTRACT_COMMAND =
  "powershell -NoProfile -Command \"Add-Type -AssemblyName Microsoft.VisualBasic; [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory('" +
  TEMP_PATH +
  "','OnlyErrorDialogs','SendToRecycleBin')\"";

function sample() {
  const judgements = classifyEntries(
    [
      makeEntry("Temp", { bytes: 1000, files: 2 }),
      makeEntry("PlainBits", {
        bytes: 5000,
        files: 8,
        children: [makeChild("cache", { bytes: 3000 }), makeChild("keep", { bytes: 2000, exts: ["db"] })],
      }),
      makeEntry("Store", { bytes: 900, exts: ["db"], rootFiles: [{ name: "s.db", bytes: 900 }] }),
    ],
    [],
  );
  return { judgements, meta: { generatedAt: new Date(1600000000000).toISOString(), scanMillis: 1000, summary: summarize(judgements) } };
}

test("命令模板与设计契约逐字一致", async () => {
  const { recycleDeleteCommand } = await import("../src/plan.mjs");
  assert.equal(recycleDeleteCommand(TEMP_PATH), CONTRACT_COMMAND);
  assert.ok(recycleDeleteCommand("C:\\it's").includes("'C:\\it''s'"));
});

test("safe 条目进计划，mixed 只出安全子项，never 只进跳过清单", () => {
  const { judgements } = sample();
  const plan = buildPlan(judgements);
  assert.equal(plan.totals.actions, 2);
  const targets = plan.actions.map((action) => action.absPath.replace(/\\/g, "/"));
  assert.ok(targets.some((path) => path.endsWith("/AppData/Local/Temp")), targets.join(" | "));
  assert.ok(targets.some((path) => path.endsWith("/AppData/Local/PlainBits/cache")), targets.join(" | "));
  assert.ok(!targets.some((path) => path.endsWith("/PlainBits")), "混合目录整体不得进入计划");
  assert.ok(!targets.some((path) => path.endsWith("/PlainBits/keep")), "never 子项不得进入计划");
  for (const action of plan.actions) {
    assert.ok(action.command.startsWith('powershell -NoProfile -Command "Add-Type -AssemblyName Microsoft.VisualBasic'), action.command);
    assert.ok(action.command.includes("SendToRecycleBin"), action.command);
    assert.ok(action.command.includes("'" + action.absPath + "'"), action.command);
  }
  assert.ok(plan.skipped.length >= 2);
  const reasons = plan.skipped.map((item) => item.reason).join(" ");
  assert.ok(reasons.includes("never") || reasons.includes("不生成"));
});

test("--safe-only 时混合目录整体不碰", () => {
  const { judgements } = sample();
  const plan = buildPlan(judgements, { safeOnly: true });
  assert.equal(plan.totals.actions, 1);
  assert.ok(plan.actions[0].absPath.endsWith("Temp"));
  assert.ok(plan.skipped.some((item) => item.reason.includes("--safe-only")));
});

test("plan markdown 含目标路径/体积/判定/删了会怎样/命令", () => {
  const { judgements, meta } = sample();
  const plan = buildPlan(judgements);
  const text = renderPlanMarkdown(plan, meta);
  for (const field of ["目标路径：", "体积：", "判定：", "判定说明：", "删了会怎样：", "命令（复制到 PowerShell 执行）："]) {
    assert.ok(text.includes(field), "缺少字段：" + field);
  }
  assert.ok(text.includes("~~~powershell"));
  assert.ok(text.includes("SendToRecycleBin"));
  assert.ok(text.includes("未进入计划的项目"));
  assert.ok(text.includes("绝不执行"));
  assert.ok(!text.includes("undefined"));
});

test("plan 表格与 json 输出可用", () => {
  const { judgements, meta } = sample();
  const plan = buildPlan(judgements);
  const table = renderPlanTable(plan);
  assert.ok(table.includes("目标路径"));
  assert.ok(table.includes("powershell -NoProfile -Command"));
  const parsed = JSON.parse(renderPlan(plan, meta, "json"));
  assert.equal(parsed.plan.actions.length, 2);
  assert.ok(renderPlan(plan, meta).includes("# AppData Scanner计划"));
});

test("计划里绝不包含任何删除执行痕迹", () => {
  const { judgements, meta } = sample();
  const plan = buildPlan(judgements);
  const text = renderPlanMarkdown(plan, meta) + renderPlanTable(plan);
  assert.ok(!/已删除|删除完成|执行完毕/.test(text));
});
test("minBytes 同时过滤整目录动作与混合目录子项", () => {
  const judgements = classifyEntries(
    [
      makeEntry("Temp", { bytes: 1000 }),
      makeEntry("PlainBits", {
        bytes: 9000,
        children: [
          makeChild("cache", { bytes: 30 * 1024 * 1024 }),
          makeChild("smallcache", { bytes: 1024 * 1024 }),
        ],
      }),
    ],
    [],
  );
  const all = buildPlan(judgements);
  assert.equal(all.totals.actions, 3);
  const big = buildPlan(judgements, { minBytes: 20 * 1024 * 1024 });
  assert.equal(big.totals.actions, 1);
  assert.ok(big.actions[0].absPath.endsWith("PlainBits\\cache"));
  assert.ok(big.skipped.some((item) => item.reason.includes("阈值")));
});
test("统计被截断的条目不生成任何删除命令", () => {
  const judgements = classifyEntries(
    [
      makeEntry("CacheJunk", { bytes: 8000, files: 9, truncated: true }),
      makeEntry("Temp", { bytes: 1000, files: 2 }),
    ],
    [],
  );
  const plan = buildPlan(judgements);
  const targets = plan.actions.map((action) => action.absPath.replace(/\\/g, "/"));
  assert.ok(!targets.some((path) => path.endsWith("/CacheJunk")), "截断条目不得进入计划：" + targets.join(" | "));
  assert.ok(targets.some((path) => path.endsWith("/Temp")), "未截断的 safe 条目应照常进入计划");
  assert.ok(plan.skipped.some((item) => String(item.reason).includes("截断")), "应在跳过清单里说明原因");
});

test("截断的混合目录：连可删子项也不进计划", () => {
  const judgements = classifyEntries(
    [makeEntry("PlainBits", { bytes: 9000, children: [makeChild("cache", { bytes: 3000 })], truncated: true })],
    [],
  );
  const plan = buildPlan(judgements);
  assert.equal(plan.totals.actions, 0, "父目录统计不完整时，子项的体积同样不可信");
  assert.ok(plan.skipped.some((item) => String(item.reason).includes("截断")));
});

test("当前判定流程只产生 dir 动作并使用 DeleteDirectory", () => {
  const judgements = classifyEntries(
    [
      makeEntry("PlainBits", {
        bytes: 9000,
        children: [makeChild("cache", { bytes: 3000 })],
        rootFiles: [{ name: "app.log", bytes: 4000 }],
      }),
    ],
    [],
  );
  const plan = buildPlan(judgements);
  assert.equal(plan.actions.length, 1);
  assert.ok(plan.actions.every((action) => action.kind === "dir"));
  assert.ok(!plan.actions.some((action) => action.absPath.endsWith("app.log")));
  for (const action of plan.actions) {
    assert.ok(action.command.includes("::DeleteDirectory("), action.command);
  }
});

const LOCAL_ROOT = "C:\\Users\\fixture\\AppData\\Local";

function safeJudgement(absPath, relPath = "x") {
  return { root: "local", relPath, absPath, bytes: 1024, safety: "safe" };
}

test("提供 roots 时只生成根内命令，根外动作注明拒绝原因", () => {
  const plan = buildPlan([
    safeJudgement(LOCAL_ROOT + "\\x"),
    safeJudgement("D:\\outside\\x"),
  ], { roots: [LOCAL_ROOT] });
  assert.equal(plan.actions.length, 1);
  assert.equal(plan.actions[0].absPath, LOCAL_ROOT + "\\x");
  assert.equal(plan.skipped.length, 1);
  assert.ok(plan.skipped[0].reason.includes("不在 AppData 之下"));
  assert.deepEqual(Object.keys(plan.skipped[0]), ["root", "relPath", "absPath", "bytes", "safety", "reason"]);
});

test("根比较忽略大小写和分隔符，允许根本身但不允许 AppData2 相似前缀", () => {
  const root = "C:\\Users\\fixture\\AppData";
  for (const target of [root, root.toUpperCase() + "\\LOCAL\\x", root.replace(/\\/g, "/") + "/Local/x"]) {
    assert.equal(buildPlan([safeJudgement(target)], { roots: [root + "\\"] }).actions.length, 1);
  }
  const plan = buildPlan([safeJudgement(root + "2\\Local\\x")], { roots: [root] });
  assert.equal(plan.actions.length, 0);
  assert.ok(plan.skipped[0].reason.includes("不在 AppData 之下"));
});

test("无 roots 或空 roots 时拒绝相对路径不一致和缺失的条目", () => {
  for (const options of [undefined, { roots: [] }]) {
    for (const relPath of ["Beta", "", undefined]) {
      const entry = safeJudgement(LOCAL_ROOT + "\\Alpha", relPath);
      entry.relPath = relPath;
      const plan = buildPlan([entry], options);
      assert.equal(plan.actions.length, 0);
      assert.ok(plan.skipped[0].reason.includes("不一致"));
    }
    assert.equal(buildPlan([safeJudgement(LOCAL_ROOT + "\\Alpha", "alpha")], options).actions.length, 1);
  }
});

test("无 roots 的系统路径即使尾段一致仍优先命中系统禁列表", () => {
  const plan = buildPlan([safeJudgement("C:\\Windows\\System32\\x", "x")]);
  assert.equal(plan.actions.length, 0);
  assert.ok(plan.skipped[0].reason.includes("系统路径"));
});

test("伪造 roots 不能绕过五类系统路径禁列表", () => {
  const targets = [
    "C:\\Windows", "d:\\WINDOWS\\Temp\\x", "C:\\Program Files\\x",
    "D:\\Program Files (x86)\\x", "D:\\backup\\Windows\\System32\\x",
    "D:/backup/Windows/SysWOW64/x",
  ];
  for (const absPath of targets) {
    const plan = buildPlan([safeJudgement(absPath)], { roots: [absPath, "C:\\Windows"] });
    assert.equal(plan.actions.length, 0, absPath);
    assert.ok(plan.skipped[0].reason.includes("系统路径"), absPath);
  }
});

test("系统目录相似名称不是禁列表命中", () => {
  for (const absPath of ["D:\\Windows2\\x", "D:\\Program Files2\\x", "D:\\backup\\Windows\\System32x\\x"]) {
    assert.equal(buildPlan([safeJudgement(absPath)], { roots: [absPath] }).actions.length, 1);
  }
});

test("根内字面前缀不能放行路径穿越或非绝对路径", () => {
  for (const absPath of [LOCAL_ROOT + "\\..\\..\\outside\\x", "relative\\x", undefined]) {
    const plan = buildPlan([safeJudgement(absPath)], { roots: [LOCAL_ROOT] });
    assert.equal(plan.actions.length, 0);
    assert.ok(plan.skipped[0].reason.includes("不在 AppData 之下"));
  }
});

test("mixed 的安全子项逐个受 roots 和一致性校验", () => {
  for (const options of [{ roots: [LOCAL_ROOT] }, undefined]) {
    const invalid = safeJudgement(options ? "D:\\outside\\x" : LOCAL_ROOT + "\\Alpha", "Parent\\x");
    const valid = safeJudgement(LOCAL_ROOT + "\\Parent\\cache", "Parent\\cache");
    const parent = { ...safeJudgement(LOCAL_ROOT + "\\Parent", "Parent"), safety: "mixed", children: [invalid, valid] };
    const plan = buildPlan([parent], options);
    assert.equal(plan.actions.length, 1);
    assert.equal(plan.actions[0].absPath, valid.absPath);
    assert.ok(plan.skipped.some((entry) => entry.absPath === invalid.absPath && entry.reason.includes(options ? "不在 AppData 之下" : "不一致")));
  }
});

test("真实知识库的 Steam 和 Partitions 缓存在两种准入模式下照常生成命令", async () => {
  const knowledge = await loadKnowledge(fileURLToPath(new URL("../knowledge/", import.meta.url)), {});
  const judgements = classifyEntries([
    makeEntry("Steam", { children: [makeChild("htmlcache\\Default\\Cache", { bytes: 3000 })] }),
    makeEntry("aDrive", { root: "roaming", children: [makeChild("Partitions\\account\\Cache", { bytes: 4000 })] }),
  ], knowledge);
  for (const options of [undefined, { roots: [LOCAL_ROOT, LOCAL_ROOT.replace(/Local$/, "Roaming")] }]) {
    const plan = buildPlan(judgements, options);
    assert.equal(plan.actions.length, 2);
    assert.ok(plan.actions.some((entry) => entry.relPath === "Steam\\htmlcache\\Default\\Cache"));
    assert.ok(plan.actions.some((entry) => entry.relPath === "aDrive\\Partitions\\account\\Cache"));
    assert.ok(plan.actions.every((entry) => entry.command.includes("::DeleteDirectory(") && entry.command.includes("SendToRecycleBin")));
  }
});

test("recycleDeleteFileCommand 保留供外部调用者使用的逐字模板", async () => {
  const { recycleDeleteFileCommand } = await import("../src/plan.mjs");
  const filePath = TEMP_PATH + "\\app.log";
  assert.equal(recycleDeleteFileCommand(filePath), CONTRACT_COMMAND.replace("::DeleteDirectory(", "::DeleteFile(").replace(TEMP_PATH, filePath));
  assert.ok(recycleDeleteFileCommand("C:\\it's\\app.log").includes("'C:\\it''s\\app.log'"));
});
