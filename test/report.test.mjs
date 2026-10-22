// test/report.test.mjs —— 中文输出：表格对齐、md、json
import test from "node:test";
import assert from "node:assert/strict";

import {
  displayWidth,
  formatBytes,
  formatCount,
  formatTime,
  padDisplay,
  truncateDisplay,
  renderJson,
  renderMarkdown,
  renderReport,
  renderTable,
} from "../src/report.mjs";
import { classifyEntries, summarize } from "../src/classifier.mjs";
import { makeChild, makeEntry } from "./helpers.mjs";

function sample() {
  const entries = [
    makeEntry("CacheFace", { bytes: 2 * 1024 * 1024, files: 120 }),
    makeEntry("PlainBits", {
      bytes: 5 * 1024 * 1024,
      files: 40,
      children: [makeChild("sub", { bytes: 3 * 1024 * 1024 }), makeChild("cache", { bytes: 2 * 1024 * 1024 })],
    }),
    makeEntry("Store", { bytes: 1024, files: 1, exts: ["db"], rootFiles: [{ name: "s.db", bytes: 1024 }] }),
  ];
  const judgements = classifyEntries(entries, []);
  const meta = {
    generatedAt: new Date(1600000000000).toISOString(),
    scanMillis: 1234,
    roots: [{ name: "local", label: "Local", absPath: "C:\\Users\\fixture\\AppData\\Local", exists: true, dirs: 3 }],
    knowledge: { dir: "knowledge", entries: [], files: [], problems: [] },
    summary: summarize(judgements),
  };
  return { judgements, meta };
}

/** 按显示宽度截取一段，用于校验列边界。 */
function sliceByWidth(text, start, length) {
  let pos = 0;
  let used = 0;
  let out = "";
  for (const ch of text) {
    const width = displayWidth(ch);
    if (pos >= start && used + width <= length) {
      out += ch;
      used += width;
    }
    pos += width;
    if (pos >= start + length) break;
  }
  return out;
}

test("显示宽度：CJK 记 2 列，补齐与截断都按显示宽度", () => {
  assert.equal(displayWidth("目录"), 4);
  assert.equal(displayWidth("abc"), 3);
  assert.equal(displayWidth("Mixed混合"), 9);
  assert.equal(displayWidth(padDisplay("目录", 10, "left")), 10);
  assert.equal(displayWidth(padDisplay("1 GB", 10, "right")), 10);
  assert.ok(padDisplay("1 GB", 10, "right").startsWith(" "));
  assert.ok(truncateDisplay("这是一个很长的中文说明", 8).endsWith("…"));
  assert.equal(displayWidth(truncateDisplay("这是一个很长的中文说明", 8)) <= 8, true);
});

test("数值与时间格式化", () => {
  assert.equal(formatBytes(0), "0 B");
  assert.equal(formatBytes(1024), "1.00 KB");
  assert.equal(formatBytes(1536), "1.50 KB");
  assert.equal(formatBytes(1024 * 1024 * 1024), "1.00 GB");
  assert.equal(formatCount(1234567), "1,234,567");
  assert.equal(formatTime(0), "—");
  assert.equal(formatTime(Date.parse("2024-05-04T01:02:00Z")).length, 16);
});

test("table：中文表头、混合目录带 ▼、子项带 ⑂ 缩进、列边界对齐", () => {
  const { judgements, meta } = sample();
  const text = renderTable(judgements, meta);
  const lines = text.split("\n");
  assert.ok(text.includes("阶段一"));
  assert.ok(text.includes("可安全删除"));
  assert.ok(text.includes("需拆分确认"));
  assert.ok(text.includes("不可删除"));
  assert.ok(text.includes("▼"), "混合目录应有拆分标记");
  assert.ok(text.includes("└ "), "应输出子项行");
  assert.ok(text.includes("合计："));
  assert.ok(!text.includes("undefined"));

  const headerIndex = lines.findIndex((line) => line.includes("目录") && line.includes("体积") && line.includes("说明"));
  assert.ok(headerIndex >= 0, "应找到表头行");
  const noteOffset = displayWidth(lines[headerIndex]) - displayWidth("说明");
  assert.ok(noteOffset > 40);
  let checked = 0;
  for (let i = headerIndex + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.startsWith("合计：")) break;
    if (!line.trim() || line.startsWith("─") || line.startsWith("【") || line.startsWith("=")) continue;
    if (displayWidth(line) < noteOffset) continue;
    assert.ok(sliceByWidth(line, 0, noteOffset).endsWith("  "), "第 " + (i + 1) + " 行列边界未对齐：" + line);
    checked += 1;
  }
  assert.ok(checked >= 5, "至少校验 5 行（含子项行），实际 " + checked);
});

test("markdown 报告：汇总表 + 分组表 + 子项行", () => {
  const { judgements, meta } = sample();
  const text = renderMarkdown(judgements, meta);
  assert.ok(text.startsWith("# AppData Scanner报告"));
  assert.ok(text.includes("## 汇总"));
  assert.ok(text.includes("| 目录 | 体积 |"));
  assert.ok(text.includes("## 【Local】"));
  assert.ok(text.includes("└ "));
  assert.ok(text.includes("可安全删除"));
});

test("json 报告可被解析且字段完整", () => {
  const { judgements, meta } = sample();
  const text = renderJson(judgements, meta);
  const data = JSON.parse(text);
  assert.equal(data.entries.length, 3);
  assert.equal(data.summary.entries, 3);
  for (const entry of data.entries) {
    assert.ok(entry.relPath);
    assert.ok(entry.absPath);
    assert.ok(typeof entry.bytes === "number");
    if (entry.safety === "mixed") assert.ok(Array.isArray(entry.children) && entry.children.length > 0);
  }
  assert.equal(JSON.parse(renderReport(judgements, meta, "json")).entries.length, 3);
  assert.ok(renderReport(judgements, meta, "md").startsWith("# AppData"));
  assert.ok(renderReport(judgements, meta).includes("阶段一"));
});
