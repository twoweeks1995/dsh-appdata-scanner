// test/plan.test.mjs —— 只出计划与命令，绝不执行
import test from "node:test";
import assert from "node:assert/strict";

import { buildPlan, renderPlan, renderPlanMarkdown, renderPlanTable } from "../src/plan.mjs";
import { classifyEntries, summarize } from "../src/classifier.mjs";
import { makeChild, makeEntry } from "./helpers.mjs";

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
test("文件目标用 DeleteFile，目录目标仍是契约里的 DeleteDirectory", () => {
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
  const fileAction = plan.actions.find((action) => action.kind === "file");
  const dirAction = plan.actions.find((action) => action.kind === "dir");
  assert.ok(fileAction, "app.log 应作为可删文件进入计划");
  assert.ok(fileAction.command.includes("::DeleteFile("), fileAction.command);
  assert.ok(fileAction.command.endsWith(",'OnlyErrorDialogs','SendToRecycleBin')\""), fileAction.command);
  assert.ok(dirAction.command.includes("::DeleteDirectory("), dirAction.command);
});
