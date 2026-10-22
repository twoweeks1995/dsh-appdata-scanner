// src/plan.mjs —— 只生成计划与命令，绝不执行（阶段一硬性约束）
import { safetyLabel } from "./classifier.mjs";
import { displayWidth, formatBytes, formatCount, formatStamp, padDisplay, truncateDisplay } from "./report.mjs";

function psCommand(method, absPath) {
  const target = String(absPath).replace(/'/g, "''");
  const inner =
    "Add-Type -AssemblyName Microsoft.VisualBasic; [Microsoft.VisualBasic.FileIO.FileSystem]::" +
    method +
    "('" +
    target +
    "','OnlyErrorDialogs','SendToRecycleBin')";
  return 'powershell -NoProfile -Command "' + inner + '"';
}

/**
 * 目录回收站删除命令（契约规定的那一条，逐字不改）。
 * 路径中的单引号按 PowerShell 单引号字符串规则转义成两个单引号。
 */
export function recycleDeleteCommand(absPath) {
  return psCommand("DeleteDirectory", absPath);
}

/** 文件目标的回收站删除命令，保留供外部调用者兼容；当前判定流程不会产生文件动作。 */
export function recycleDeleteFileCommand(absPath) {
  return psCommand("DeleteFile", absPath);
}

function pathKey(value) {
  return typeof value === "string" ? value.replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase() : "";
}

function isAbsoluteTreePath(value) {
  return (/^[a-z]:\\/i.test(value) || /^\\\\[^\\]+\\[^\\]+(?:\\|$)/.test(value)) &&
    !value.split("\\").some((part) => part === "." || part === "..");
}

function isUnderTree(parent, child) {
  const outer = pathKey(parent);
  const inner = pathKey(child);
  return isAbsoluteTreePath(outer) && isAbsoluteTreePath(inner) &&
    (inner === outer || inner.startsWith(outer + "\\"));
}

function pathSkipReason(judgement, roots) {
  const absPath = pathKey(judgement.absPath);
  if (/^[a-z]:\\(?:Windows|Program Files(?: \(x86\))?)(?:\\|$)/i.test(absPath) ||
      /\\Windows\\(?:System32|SysWOW64)(?:\\|$)/i.test(absPath)) {
    return "系统路径，拒绝生成删除命令：" + judgement.absPath;
  }
  if (roots.length > 0) {
    return roots.some((root) => isUnderTree(root, absPath)) ? "" :
      "路径不在 AppData 之下，拒绝生成删除命令：" + judgement.absPath;
  }
  const relPath = pathKey(judgement.relPath);
  const suffix = "\\" + relPath;
  const rootAbs = absPath.endsWith(suffix) ? absPath.slice(0, -suffix.length) : "";
  if (!relPath || relPath.startsWith("\\") || relPath.includes(":") ||
      relPath.split("\\").some((part) => !part || part === "." || part === "..") ||
      !isUnderTree(rootAbs, absPath)) {
    return "条目路径与相对路径不一致，拒绝生成删除命令";
  }
  return "";
}

// 保留 kind 分支以兼容外部调用者；当前判定流程不会产生文件动作。
function actionFrom(judgement, extra) {
  const info = extra || {};
  return {
    index: 0,
    source: info.source || "entry",
    parentRelPath: info.parentRelPath || null,
    root: judgement.root,
    relPath: judgement.relPath,
    absPath: judgement.absPath,
    bytes: judgement.bytes || 0,
    files: judgement.files || 0,
    safety: judgement.safety,
    category: judgement.category,
    confidence: judgement.confidence,
    purpose: judgement.purpose || "",
    ifDeleted: judgement.ifDeleted || "未知",
    kind: judgement.kind === "file" ? "file" : "dir",
    command:
      judgement.kind === "file"
        ? recycleDeleteFileCommand(judgement.absPath)
        : recycleDeleteCommand(judgement.absPath),
  };
}

function skipOf(judgement, reason) {
  return {
    root: judgement.root,
    relPath: judgement.relPath,
    absPath: judgement.absPath,
    bytes: judgement.bytes || 0,
    safety: judgement.safety,
    reason,
  };
}

/**
 * 由判定结果生成删除计划。
 * safe 条目整目录进计划；mixed 条目只把 safety=safe 的子项放进计划，绝不整删；
 * --safe-only 进一步收紧：只保留顶层 safe 条目，混合目录一律不碰。
 * 统计被截断（truncated）的条目**一律不进计划**：体积与内容都没数全，不该据此给出删除命令。
 */
export function buildPlan(judgements, options) {
  const opts = options || {};
  const safeOnly = Boolean(opts.safeOnly);
  const roots = Array.isArray(opts.roots) ? opts.roots : [];
  const minBytes = Math.max(0, Number(opts.minBytes || 0));
  const actions = [];
  const skipped = [];

  for (const judgement of judgements || []) {
    if (judgement.safety === "safe") {
      if (judgement.truncated) {
        skipped.push(skipOf(judgement, "扫描被截断，体积与内容都没数全，不生成删除命令（可重新扫描后再看）"));
        continue;
      }
      if ((judgement.bytes || 0) < minBytes) {
        skipped.push(skipOf(judgement, "体积低于阈值 " + Math.round(minBytes / 1048576) + "MB，未进入计划"));
        continue;
      }
      const pathReason = pathSkipReason(judgement, roots);
      if (pathReason) {
        skipped.push(skipOf(judgement, pathReason));
        continue;
      }
      actions.push(actionFrom(judgement, { source: "entry" }));
      continue;
    }
    if (judgement.safety === "mixed") {
      if (judgement.truncated) {
        skipped.push(skipOf(judgement, "扫描被截断，子项统计也不完整，不生成删除命令（可重新扫描后再看）"));
        continue;
      }
      const children = judgement.children || [];
      if (safeOnly) {
        skipped.push(skipOf(judgement, "--safe-only：混合目录整体不进入计划"));
        continue;
      }
      const safeChildren = children.filter((child) => child.safety === "safe" && (child.bytes || 0) >= minBytes && (child.bytes || 0) > 0);
      if (safeChildren.length === 0) {
        skipped.push(skipOf(judgement, "没有可安全删除的子项，需要人工确认后手工处理"));
        continue;
      }
      for (const child of safeChildren) {
        const pathReason = pathSkipReason(child, roots);
        if (pathReason) {
          skipped.push(skipOf(child, pathReason));
          continue;
        }
        actions.push(actionFrom(child, { source: "child", parentRelPath: judgement.relPath }));
      }
      for (const child of children) {
        if (child.safety === "safe" && (child.bytes || 0) > 0) continue;
        skipped.push(
          skipOf(
            child,
            child.safety === "never"
              ? "子项安全级为 never，不生成命令"
              : "子项为混合/未知，本阶段不向下展开，需人工确认",
          ),
        );
      }
      continue;
    }
    skipped.push(skipOf(judgement, "安全级为 " + (judgement.safety || "未知") + "，不生成删除命令"));
  }

  // 去重：若某个动作的路径已被另一个动作整块覆盖，只保留覆盖者，避免体积重复计算
  const byDepth = actions
    .map((action, order) => ({ action, order, segments: String(action.absPath).split(/[\\/]+/).length }))
    .sort((a, b) => a.segments - b.segments || b.action.bytes - a.action.bytes || a.order - b.order);
  const kept = [];
  for (const item of byDepth) {
    const covered = kept.some((other) => {
      const prefix = String(other.absPath).toLowerCase() + "\\";
      return String(item.action.absPath).toLowerCase().startsWith(prefix);
    });
    if (covered) {
      skipped.push({
        root: item.action.root,
        relPath: item.action.relPath,
        absPath: item.action.absPath,
        bytes: item.action.bytes,
        safety: item.action.safety,
        reason: "已被上级动作整块覆盖，不重复生成命令",
      });
      continue;
    }
    kept.push(item.action);
  }

  kept.sort((a, b) => b.bytes - a.bytes || String(a.absPath).localeCompare(String(b.absPath)));
  kept.forEach((action, index) => {
    action.index = index + 1;
  });

  const totalBytes = kept.reduce((sum, action) => sum + action.bytes, 0);
  return {
    generatedAt: opts.generatedAt || new Date().toISOString(),
    phase: "plan-only",
    safeOnly,
    actions: kept,
    skipped,
    totals: { actions: kept.length, bytes: totalBytes, skipped: skipped.length },
  };
}

function confidenceLabel(confidence) {
  if (confidence === "high") return "高";
  if (confidence === "medium") return "中";
  return "低";
}

function judgementLabel(item) {
  const source = item.source === "child" ? "混合目录的安全子项" : "整目录";
  return safetyLabel(item.safety) + "（" + source + " · 置信度 " + confidenceLabel(item.confidence) + "）";
}

export const PLAN_NOTE = [
  "本文件只是计划：工具不会执行任何命令，也不会改动被扫描目录。",
  "下面每条命令都会把目标移入回收站（SendToRecycleBin），请逐条复核后再手动执行。",
];

/** Markdown 计划（默认格式）。 */
export function renderPlanMarkdown(plan, meta) {
  const info = meta || {};
  const lines = [];
  lines.push("# AppData Scanner计划（阶段一 · 只出命令，绝不执行）");
  lines.push("");
  lines.push("- 生成时间：" + formatStamp(plan.generatedAt));
  lines.push("- 模式：" + (plan.safeOnly ? "--safe-only（只处理顶层安全目录）" : "默认（安全目录 + 混合目录中的安全子项）"));
  lines.push("- 计划动作：" + plan.totals.actions + " 条，合计 " + formatBytes(plan.totals.bytes));
  if (info.scanMillis) lines.push("- 扫描耗时：" + (info.scanMillis / 1000).toFixed(1) + " 秒");
  for (const line of PLAN_NOTE) lines.push("- " + line);
  lines.push("");

  if (plan.actions.length === 0) {
    lines.push("没有符合条件的目标（可能全部为混合/不可删除条目，或阈值过高）。");
    lines.push("");
  }

  plan.actions.forEach((action) => {
    lines.push("## " + action.index + ". " + action.relPath + " · " + formatBytes(action.bytes));
    lines.push("");
    lines.push("- 目标路径：" + action.absPath);
    lines.push("- 体积：" + formatBytes(action.bytes) + "（" + formatCount(action.files) + " 个文件）");
    lines.push("- 判定：" + judgementLabel(action));
    lines.push("- 目标类型：" + (action.kind === "file" ? "文件（DeleteFile）" : "目录（DeleteDirectory）"));
    if (action.parentRelPath) lines.push("- 所属目录：" + action.parentRelPath + "（混合目录，只删这一个子项）");
    lines.push("- 判定说明：" + (action.purpose || "—"));
    lines.push("- 删了会怎样：" + (action.ifDeleted || "未知"));
    lines.push("- 命令（复制到 PowerShell 执行）：");
    lines.push("");
    lines.push("~~~powershell");
    lines.push(action.command);
    lines.push("~~~");
    lines.push("");
  });

  if (plan.skipped.length > 0) {
    lines.push("## 未进入计划的项目");
    lines.push("");
    lines.push("| 路径 | 体积 | 判定 | 原因 |");
    lines.push("| --- | ---: | --- | --- |");
    for (const item of plan.skipped) {
      lines.push("| " + item.relPath + " | " + formatBytes(item.bytes) + " | " + safetyLabel(item.safety) + " | " + item.reason + " |");
    }
    lines.push("");
  }

  lines.push("## 执行前请确认");
  lines.push("");
  lines.push("1. 关闭相关程序，避免文件被占用导致删除只完成一半。");
  lines.push("2. 回收站删除可撤销，但超大目录可能因容量限制被跳过回收站。");
  lines.push("3. 混合目录只删除已确认安全的子项；整块删除会连带用户数据。");
  return lines.join("\n") + "\n";
}

const PLAN_COLUMNS = [
  { key: "index", title: "#", align: "right", max: 4 },
  { key: "path", title: "目标路径", align: "left", max: 56 },
  { key: "size", title: "体积", align: "right", max: 10 },
  { key: "safety", title: "判定", align: "left", max: 12 },
  { key: "effect", title: "删了会怎样", align: "left", max: 28 },
];

/** 终端表格形式的计划。 */
export function renderPlanTable(plan) {
  const rows = plan.actions.map((action) => ({
    index: String(action.index),
    path: action.absPath,
    size: formatBytes(action.bytes),
    safety: safetyLabel(action.safety),
    effect: action.ifDeleted || "未知",
    command: action.command,
  }));
  const widths = {};
  for (const column of PLAN_COLUMNS) {
    let width = displayWidth(column.title);
    for (const row of rows) width = Math.max(width, displayWidth(row[column.key]));
    widths[column.key] = Math.min(column.max, Math.max(column.title.length, width));
  }
  const totalWidth = PLAN_COLUMNS.reduce((sum, column) => sum + widths[column.key], 0) + 2 * (PLAN_COLUMNS.length - 1);
  const renderRow = (cells) =>
    PLAN_COLUMNS.map((column) => padDisplay(truncateDisplay(cells[column.key], widths[column.key]), widths[column.key], column.align))
      .join("  ")
      .replace(/\s+$/, "");

  const lines = [];
  lines.push("AppData Scanner计划 · 阶段一（只出命令，绝不执行）");
  lines.push("生成时间：" + formatStamp(plan.generatedAt) + "    计划动作：" + plan.totals.actions + " 条 / " + formatBytes(plan.totals.bytes));
  lines.push("");
  const header = {};
  for (const column of PLAN_COLUMNS) header[column.key] = column.title;
  lines.push(renderRow(header));
  lines.push("-".repeat(totalWidth));
  for (const row of rows) {
    lines.push(renderRow(row));
    lines.push("   " + row.command);
  }
  lines.push("");
  lines.push("提示：以上命令未被执行，也不会被执行；请自行复核后复制执行。");
  return lines.join("\n") + "\n";
}

/** JSON 计划。 */
export function renderPlanJson(plan) {
  return JSON.stringify({ version: 1, generator: "appdata-scanner", phase: "plan-only", plan }, null, 2) + "\n";
}

export function renderPlan(plan, meta, format) {
  const kind = String(format || "md").toLowerCase();
  if (kind === "json") return renderPlanJson(plan);
  if (kind === "table" || kind === "txt") return renderPlanTable(plan);
  return renderPlanMarkdown(plan, meta);
}
