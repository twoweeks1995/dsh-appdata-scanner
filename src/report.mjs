// src/report.mjs —— 中文输出：table（终端对齐表格）/ md / json，零依赖
import { safetyLabel, summarize } from "./classifier.mjs";

const ELLIPSIS = "…";
const BOX = "─";

/** 终端显示宽度：CJK 全角算 2 列。 */
export function displayWidth(text) {
  let width = 0;
  for (const ch of String(text)) {
    const cp = ch.codePointAt(0);
    if (cp === 0x200b || cp === 0xfe0f || (cp >= 0x0300 && cp <= 0x036f)) continue;
    width += isWide(cp) ? 2 : 1;
  }
  return width;
}

function isWide(cp) {
  return (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0x303e) ||
    (cp >= 0x3041 && cp <= 0x33ff) ||
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0xa000 && cp <= 0xa4cf) ||
    (cp >= 0xa960 && cp <= 0xa97f) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe10 && cp <= 0xfe19) ||
    (cp >= 0xfe30 && cp <= 0xfe6f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1f64f) ||
    (cp >= 0x1f900 && cp <= 0x1f9ff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  );
}

/** 按显示宽度右补/左补空格。 */
export function padDisplay(text, width, align) {
  const value = String(text === undefined || text === null ? "" : text);
  const gap = width - displayWidth(value);
  if (gap <= 0) return value;
  const filler = " ".repeat(gap);
  return align === "right" ? filler + value : value + filler;
}

/** 按显示宽度截断，超出补省略号。 */
export function truncateDisplay(text, width) {
  const value = String(text === undefined || text === null ? "" : text);
  if (width <= 0) return "";
  if (displayWidth(value) <= width) return value;
  let out = "";
  let used = 0;
  for (const ch of value) {
    const w = displayWidth(ch);
    if (used + w > width - 1) break;
    out += ch;
    used += w;
  }
  return out + ELLIPSIS;
}

export function formatBytes(bytes) {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value <= 0) return "0 B";
  if (value < 1024) return value + " B";
  const units = ["KB", "MB", "GB", "TB", "PB"];
  let size = value / 1024;
  let index = 0;
  while (size >= 1024 && index < units.length - 1) {
    size /= 1024;
    index += 1;
  }
  const fixed = size >= 100 ? size.toFixed(0) : size >= 10 ? size.toFixed(1) : size.toFixed(2);
  return fixed + " " + units[index];
}

export function formatCount(count) {
  const value = Math.round(Number(count) || 0);
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

const pad2 = (value) => String(value).padStart(2, "0");

export function formatTime(ms) {
  const value = Number(ms);
  if (!Number.isFinite(value) || value <= 0) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return (
    date.getFullYear() +
    "-" +
    pad2(date.getMonth() + 1) +
    "-" +
    pad2(date.getDate()) +
    " " +
    pad2(date.getHours()) +
    ":" +
    pad2(date.getMinutes())
  );
}

export function formatStamp(iso) {
  const time = Date.parse(String(iso || ""));
  if (!Number.isFinite(time)) return formatTime(Date.now());
  return formatTime(time);
}

const LEGEND = [
  "安全级说明：可安全删除＝删除后由软件或系统自动重建，无数据损失；",
  "            需拆分确认＝目录内混合内容，必须按子项分别处理；",
  "            不可删除＝删除会造成不可恢复的数据损失或程序不可用。",
];

const COLUMNS = [
  { key: "path", title: "目录", align: "left", max: 42, min: 8 },
  { key: "size", title: "体积", align: "right", max: 10, min: 6 },
  { key: "files", title: "文件数", align: "right", max: 9, min: 6 },
  { key: "mtime", title: "最近修改", align: "left", max: 16, min: 10 },
  { key: "safety", title: "判定", align: "left", max: 12, min: 6 },
  { key: "category", title: "类别", align: "left", max: 16, min: 6 },
  { key: "note", title: "说明", align: "left", max: 36, min: 8 },
];

function noteFor(judgement) {
  const parts = [];
  if (judgement.purpose) parts.push(judgement.purpose);
  if (judgement.truncated) parts.push("（统计被截断）");
  return parts.join(" ");
}

function hintLines(judgements) {
  const entries = (judgements || []).flatMap((judgement) => [
    judgement,
    ...(judgement.children || []).map((child) => ({
      ...child,
      relPath: child.relPath || judgement.relPath + "/" + (child.relPathFromParent || child.name),
    })),
  ]);
  const hinted = entries.filter((entry) => (entry.hints || []).length > 0).sort((a, b) => b.bytes - a.bytes);
  const lines = hinted.slice(0, 40).map((entry) => "- " + entry.relPath + "(" + safetyLabel(entry.safety) + "):" + entry.hints.join(";"));
  if (hinted.length > 40) lines.push("另有 " + (hinted.length - 40) + " 条未显示");
  return lines;
}

function rowOf(judgement) {
  return {
    path: judgement.relPath + (judgement.safety === "mixed" && (judgement.children || []).length > 0 ? " ▼" : ""),
    size: formatBytes(judgement.bytes),
    files: formatCount(judgement.files),
    mtime: formatTime(judgement.newestMtime),
    safety: safetyLabel(judgement.safety),
    category: judgement.category,
    note: noteFor(judgement),
  };
}

function childRowOf(child) {
  return {
    path: "  └ " + (child.relPathFromParent || child.name || child.relPath),
    size: formatBytes(child.bytes),
    files: formatCount(child.files),
    mtime: formatTime(child.newestMtime),
    safety: safetyLabel(child.safety),
    category: child.category,
    note: noteFor(child),
  };
}

function columnWidths(rows) {
  const widths = {};
  for (const column of COLUMNS) {
    let width = displayWidth(column.title);
    for (const row of rows) width = Math.max(width, displayWidth(row[column.key]));
    widths[column.key] = Math.min(column.max, Math.max(column.min, width));
  }
  return widths;
}

function renderRow(row, widths) {
  return COLUMNS.map((column) => padDisplay(truncateDisplay(row[column.key], widths[column.key]), widths[column.key], column.align))
    .join("  ")
    .replace(/\s+$/, "");
}

function totalWidth(widths) {
  return COLUMNS.reduce((sum, column) => sum + widths[column.key], 0) + 2 * (COLUMNS.length - 1);
}

function groupByRoot(judgements) {
  const groups = new Map();
  for (const judgement of judgements || []) {
    const key = judgement.root || "unknown";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(judgement);
  }
  return groups;
}

function rootLabel(meta, rootName) {
  const info = ((meta && meta.roots) || []).find((item) => item.name === rootName);
  const label = info && info.label ? info.label : rootName;
  const absPath = info && info.absPath ? info.absPath : "";
  return "【" + label + "】" + (absPath ? " " + absPath : "");
}

function knowledgeLine(meta) {
  const knowledge = meta && meta.knowledge;
  if (!knowledge) return "知识库：未加载（仅启发式）";
  if (!knowledge.entries || knowledge.entries.length === 0) {
    return "知识库：空（" + (knowledge.dir || "未指定") + "），判定以启发式为主";
  }
  return "知识库：" + knowledge.entries.length + " 条（" + (knowledge.files || []).map((file) => file.file + ":" + file.accepted).join("，") + "）";
}

/** 终端表格。 */
export function renderTable(judgements, meta) {
  const info = meta || {};
  const summary = info.summary || summarize(judgements || []);
  const groups = groupByRoot(judgements || []);
  const rows = [];
  for (const [, list] of groups) {
    for (const judgement of list) {
      rows.push(rowOf(judgement));
      for (const child of judgement.children || []) rows.push(childRowOf(child));
    }
  }
  const widths = columnWidths(rows);
  const rule = BOX.repeat(totalWidth(widths));
  const lines = [];
  lines.push("=".repeat(Math.max(totalWidth(widths), 60)));
  lines.push("AppData Scanner报告 · 阶段一（只扫描与判定，不执行任何删除）");
  lines.push("生成时间：" + formatStamp(info.generatedAt) + "    扫描耗时：" + (info.scanMillis ? (info.scanMillis / 1000).toFixed(1) + " 秒" : "—"));
  lines.push(knowledgeLine(info));
  const rootLines = ((info.roots) || []).map((item) => {
    const state = item.exists ? item.dirs + " 个一级目录" : "不存在/" + (item.error || "未找到");
    return "  " + String(item.label || item.name).padEnd(9) + item.absPath + "  (" + state + ")";
  });
  for (const line of rootLines) lines.push(line);
  lines.push("=".repeat(Math.max(totalWidth(widths), 60)));

  if (rows.length === 0) {
    lines.push("没有体积达到阈值的条目。");
  } else {
    for (const [rootName, list] of groups) {
      lines.push("");
      lines.push(rootLabel(info, rootName));
      lines.push(renderRow(Object.fromEntries(COLUMNS.map((column) => [column.key, column.title])), widths));
      lines.push(rule);
      for (const judgement of list) {
        lines.push(renderRow(rowOf(judgement), widths));
        for (const child of judgement.children || []) lines.push(renderRow(childRowOf(child), widths));
      }
    }
  }

  lines.push("");
  lines.push(rule);
  lines.push(
    "合计：" +
      summary.entries +
      " 个条目 / " +
      formatBytes(summary.totalBytes) +
      "    可整删 " +
      formatBytes(summary.safeBytes) +
      " / 需拆分 " +
      formatBytes(summary.mixedBytes) +
      " / 不可删 " +
      formatBytes(summary.neverBytes),
  );
  lines.push(
    "可回收：" +
      formatBytes(summary.recoverableBytes) +
      "（可整删 " +
      formatBytes(summary.safeBytes) +
      " + 混合目录里的安全子项 " +
      formatBytes(summary.safeChildrenBytes) +
      "）",
  );
  lines.push(
    "拆分：" +
      summary.mixed +
      " 个混合目录已展开为 " +
      summary.mixedChildren +
      " 个子项；需人工复核条目 " +
      summary.needsReview +
      " 个" +
      (summary.truncated > 0 ? "；统计被截断条目 " + summary.truncated + " 个" : ""),
  );
  const hints = hintLines(judgements);
  if (hints.length > 0) lines.push("", "提示：", ...hints, "");
  for (const line of LEGEND) lines.push(line);
  lines.push("提示：本阶段不执行删除。生成删除命令请运行 plan（命令只会输出，不会执行）。");
  return lines.join("\n") + "\n";
}

function mdCell(text) {
  return String(text === undefined || text === null ? "" : text).replace(/\|/g, "\\|");
}

function mdRow(cells) {
  return "| " + cells.map(mdCell).join(" | ") + " |";
}

/** Markdown 报告。 */
export function renderMarkdown(judgements, meta) {
  const info = meta || {};
  const summary = info.summary || summarize(judgements || []);
  const groups = groupByRoot(judgements || []);
  const lines = [];
  lines.push("# AppData Scanner报告（阶段一 · 只出判定，不执行删除）");
  lines.push("");
  lines.push("- 生成时间：" + formatStamp(info.generatedAt));
  lines.push("- 扫描耗时：" + (info.scanMillis ? (info.scanMillis / 1000).toFixed(1) + " 秒" : "—"));
  lines.push("- " + knowledgeLine(info));
  for (const item of info.roots || []) {
    const state = item.exists ? item.dirs + " 个一级目录" : "不存在（" + (item.error || "未找到") + "）";
    lines.push("- 根目录 " + (item.label || item.name) + "：" + item.absPath + "（" + state + "）");
  }
  lines.push("");
  lines.push("## 汇总");
  lines.push("");
  lines.push(mdRow(["项目", "数值"]));
  lines.push(mdRow(["---", "---"]));
  lines.push(mdRow(["条目数", summary.entries]));
  lines.push(mdRow(["总体积", formatBytes(summary.totalBytes)]));
  lines.push(mdRow(["可整删（safe 条目）", formatBytes(summary.safeBytes)]));
  lines.push(mdRow(["混合目录里的安全子项", formatBytes(summary.safeChildrenBytes)]));
  lines.push(mdRow(["**可回收合计**", formatBytes(summary.recoverableBytes)]));
  lines.push(mdRow(["需拆分确认（mixed）", formatBytes(summary.mixedBytes)]));
  lines.push(mdRow(["不可删除（never）", formatBytes(summary.neverBytes)]));
  lines.push(mdRow(["混合目录 / 已拆分子项", summary.mixed + " / " + summary.mixedChildren]));
  lines.push(mdRow(["需人工复核条目", summary.needsReview]));
  lines.push("");

  for (const [rootName, list] of groups) {
    lines.push("## " + rootLabel(info, rootName));
    lines.push("");
    lines.push(mdRow(["目录", "体积", "文件数", "最近修改", "判定", "类别", "说明"]));
    lines.push(mdRow(["---", "---:", "---:", "---", "---", "---", "---"]));
    for (const judgement of list) {
      lines.push(
        mdRow([
          judgement.relPath,
          formatBytes(judgement.bytes),
          formatCount(judgement.files),
          formatTime(judgement.newestMtime),
          safetyLabel(judgement.safety),
          judgement.category,
          noteFor(judgement),
        ]),
      );
      for (const child of judgement.children || []) {
        lines.push(
          mdRow([
            "└ " + (child.relPathFromParent || child.name || child.relPath),
            formatBytes(child.bytes),
            formatCount(child.files),
            formatTime(child.newestMtime),
            safetyLabel(child.safety),
            child.category,
            noteFor(child),
          ]),
        );
      }
    }
    lines.push("");
  }

  const hints = hintLines(judgements);
  if (hints.length > 0) lines.push("## 提示/注意", "", ...hints, "");

  lines.push("## 判定依据摘要");
  lines.push("");
  lines.push(mdRow(["目录", "依据", "证据"]));
  lines.push(mdRow(["---", "---", "---"]));
  for (const judgement of judgements || []) {
    lines.push(mdRow([judgement.relPath, basisLabel(judgement), judgement.evidence || "—"]));
  }
  lines.push("");
  lines.push("> 安全级说明：可安全删除＝删除后自动重建、无数据损失；需拆分确认＝目录内混合，必须按子项处理；不可删除＝删除会造成不可恢复的损失。");
  return lines.join("\n") + "\n";
}

export function basisLabel(judgement) {
  if (judgement.matchedBy === "knowledge") return "知识库";
  if (judgement.matchedBy === "knowledge-child") return "知识库 children";
  if (judgement.matchedBy === "heuristic") return "启发式（" + (judgement.basis || "-") + "）";
  return "推测（无证据）";
}

/** JSON 报告。 */
export function renderJson(judgements, meta) {
  const info = meta || {};
  const payload = {
    version: 1,
    generator: "appdata-scanner",
    generatedAt: info.generatedAt || new Date().toISOString(),
    summary: info.summary || summarize(judgements || []),
    roots: info.roots || [],
    knowledge: info.knowledge
      ? { dir: info.knowledge.dir, entries: (info.knowledge.entries || []).length, problems: info.knowledge.problems || [] }
      : null,
    entries: judgements || [],
  };
  return JSON.stringify(payload, null, 2) + "\n";
}

export function renderReport(judgements, meta, format) {
  const kind = String(format || "table").toLowerCase();
  if (kind === "json") return renderJson(judgements, meta);
  if (kind === "md" || kind === "markdown") return renderMarkdown(judgements, meta);
  return renderTable(judgements, meta);
}
