#!/usr/bin/env node
// src/cli.mjs —— 命令行入口：scan / report / plan（阶段一：只读、只出计划，绝不执行删除）
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { scan, scanDirectory, defaultRoots, ROOT_NAMES, ROOT_LABELS } from "./scanner.mjs";
import { loadKnowledge } from "./knowledge.mjs";
import { classifyEntries, summarize } from "./classifier.mjs";
import { renderReport, formatBytes, formatCount } from "./report.mjs";
import { buildPlan, renderPlan } from "./plan.mjs";
import { lookup, DEFAULT_CACHE_FILE, LABEL, REASON_NEEDS_CONFIRM } from "./lookup.mjs";

export const DEFAULT_KNOWLEDGE_DIR = fileURLToPath(new URL("../knowledge/", import.meta.url));

const USAGE = [
  "AppData Scanner工具 · 阶段一（只扫描、只判定、只出计划，绝不执行删除）",
  "",
  "用法：",
  "  node src/cli.mjs scan   [--roots local,roaming,locallow] [--min-mb 1] [--max-seconds 0] [--out scan.json]",
  "  node src/cli.mjs report --input scan.json [--format table|md|json] [--min-mb 0] [--out report.md]",
  "  node src/cli.mjs plan   --input scan.json [--safe-only] [--format md|table|json] [--out plan.md]",
  "  node src/cli.mjs lookup --path \"<绝对路径>\" [--force] [--input scan.json]",
  "",
  "说明：",
  "  scan    只读扫描 AppData 三个根的一级子目录，输出扫描 JSON（无 --out 时打印到标准输出）",
  "  report  读取扫描 JSON，按“知识库 -> 混合拆子项 -> 启发式 -> 推测”判定并输出报告（默认 table）",
  "  plan    读取扫描 JSON，生成删除计划与可直接复制的 PowerShell 回收站命令（默认 md）；本阶段永不执行",
  "  lookup  对单个未知目录构造联网查询串（阶段一.五）。命令行固定不联网，只打印将要发送的内容",
  "",
  "选项：",
  "  --roots        逗号分隔的根名：local,roaming,locallow（默认三个都扫）",
  "  --min-mb       只保留体积不小于该值的条目，默认 scan=1、report/plan=0",
  "  --max-seconds  扫描总预算（秒），0 表示不限制；耗尽后已扫完的条目仍然有效",
  "  --input        扫描 JSON 路径，传 - 表示从标准输入读取",
  "  --out          把结果写入文件（默认写到标准输出）",
  "  --format       report: table|md|json（默认 table）；plan: md|table|json（默认 md）",
  "  --safe-only    plan 时只处理顶层安全目录，混合目录一律不碰",
  "  --path         lookup 的目标目录（绝对路径）",
  "  --force        lookup 时忽略本地缓存，强制重新构造查询（命令行仍不联网）",
  "  --knowledge    知识库目录（默认仓库内 knowledge/）；--no-knowledge 强制只用启发式",
  "  --help         显示本帮助",
].join("\n");

/** 解析 argv：支持 --key value、--key=value、布尔开关与位置参数。 */
export function parseArgv(argv) {
  const options = {};
  const positionals = [];
  const list = Array.isArray(argv) ? argv : [];
  for (let i = 0; i < list.length; i += 1) {
    const arg = String(list[i]);
    if (arg === "--") {
      positionals.push(...list.slice(i + 1));
      break;
    }
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      if (eq > 2) {
        options[arg.slice(2, eq)] = arg.slice(eq + 1);
        continue;
      }
      const key = arg.slice(2);
      const next = list[i + 1];
      if (next !== undefined && !String(next).startsWith("--")) {
        options[key] = String(next);
        i += 1;
      } else {
        options[key] = true;
      }
      continue;
    }
    if (arg.startsWith("-") && arg.length > 1) {
      options[arg.slice(1)] = true;
      continue;
    }
    positionals.push(arg);
  }
  return { options, positionals };
}

function toNumber(value, fallback) {
  if (value === undefined || value === null || value === true) return fallback;
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function parseRoots(value) {
  if (value === undefined || value === true) return ROOT_NAMES.slice();
  const names = String(value)
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
  if (names.length === 0) return null;
  for (const name of names) {
    if (ROOT_NAMES.indexOf(name) < 0) return null;
  }
  return names;
}

function knowledgeDirFrom(options) {
  if (options["no-knowledge"]) return null;
  if (options.knowledge && options.knowledge !== true) return resolve(String(options.knowledge));
  return DEFAULT_KNOWLEDGE_DIR;
}

async function emit(text, options, io) {
  const out = options.out;
  if (out && out !== true) {
    const target = resolve(String(out));
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, text, "utf8");
    io.writeError("已写入 " + target + "\n");
    return;
  }
  io.write(text);
}

async function readScanDocument(options) {
  const input = options.input && options.input !== true ? String(options.input) : "";
  if (!input) throw new Error("report/plan 需要 --input <scan.json>（传 - 表示标准输入）");
  let text;
  if (input === "-") {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    text = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8");
  } else {
    text = await readFile(resolve(input), "utf8");
  }
  const data = JSON.parse(text.replace(/^\uFEFF/, ""));
  if (!data || !Array.isArray(data.entries)) throw new Error("扫描 JSON 格式不对：缺少 entries 数组");
  return data;
}

function resolveJudgements(doc, knowledge, options, io) {
  const minMb = Math.max(0, toNumber(options["min-mb"], 0));
  const minBytes = minMb * 1024 * 1024;
  const all = classifyEntries(doc.entries || [], knowledge, {});
  const judgements = minBytes > 0 ? all.filter((item) => (item.bytes || 0) >= minBytes) : all;
  for (const problem of (knowledge.problems || []).slice(0, 8)) {
    io.writeError("知识库提示：" + (problem.file || "-") + " " + problem.message + "\n");
  }
  const dropped = all.length - judgements.length;
  if (dropped > 0) io.writeError("已按 --min-mb " + minMb + " 过滤 " + dropped + " 个条目\n");
  return judgements;
}

function metaOf(doc, knowledge, judgements) {
  return {
    generatedAt: doc.generatedAt,
    scanMillis: doc.stats && doc.stats.millis ? doc.stats.millis : 0,
    roots: doc.roots || [],
    knowledge,
    summary: summarize(judgements),
  };
}

export async function run(argv, customIo) {
  const io = {
    write: (customIo && customIo.write) || ((text) => process.stdout.write(text)),
    writeError: (customIo && customIo.writeError) || ((text) => process.stderr.write(text)),
  };
  const { options, positionals } = parseArgv(argv);
  const command = positionals[0];

  if (!command || options.help || command === "help") {
    io.write(USAGE + "\n");
    return { code: command || options.help ? 0 : 2 };
  }

  try {
    if (command === "scan") {
      const rootNames = parseRoots(options.roots);
      if (!rootNames) {
        io.writeError("--roots 取值非法，只能是 local,roaming,locallow 的组合\n");
        return { code: 2 };
      }
      const minMb = Math.max(0, toNumber(options["min-mb"], 1));
      const maxSeconds = Math.max(0, toNumber(options["max-seconds"], 0));
      const roots = defaultRoots(options.home && options.home !== true ? String(options.home) : undefined);
      io.writeError(
        "开始扫描（只读）：" + rootNames.map((name) => (ROOT_LABELS[name] || name) + "=" + roots[name]).join("  ") + "\n",
      );
      const doc = await scan({
        roots,
        rootNames,
        minMb,
        maxSeconds,
        onProgress: (info) => io.writeError("  [" + info.root + " " + info.index + "/" + info.total + "] " + info.name + "\n"),
      });
      const text = JSON.stringify(doc, null, 2) + "\n";
      await emit(text, options, io);
      io.writeError(
        "扫描完成：" + doc.stats.scanned + " 个一级目录，保留 " + doc.stats.kept + " 个（低于 --min-mb " + minMb + " 的 " + doc.stats.filtered + " 个已过滤），耗时 " + (doc.stats.millis / 1000).toFixed(1) + " 秒" + (doc.budget.exhausted ? "（总预算耗尽，部分目录未扫）" : "") + "\n",
      );
      return { code: 0 };
    }

    if (command === "lookup") {
      const target = options.path && options.path !== true ? String(options.path) : "";
      if (!target) {
        io.writeError("lookup 需要 --path <绝对路径>\n" + USAGE + "\n");
        return { code: 2 };
      }
      const absPath = resolve(target);
      const roots = defaultRoots(options.home && options.home !== true ? String(options.home) : undefined);
      let relPath = basename(absPath);
      let rootName = "local";
      for (const name of Object.keys(roots)) {
        const base = String(roots[name]).replace(/[\\/]+$/, "");
        if (!base) continue;
        const lowerBase = base.toLowerCase();
        const lowerPath = absPath.toLowerCase();
        if (lowerPath === lowerBase) break;
        if (lowerPath.startsWith(lowerBase + "\\") || lowerPath.startsWith(lowerBase + "/")) {
          rootName = name;
          relPath = absPath.slice(base.length).replace(/^[\\/]+/, "");
          break;
        }
      }
      let entry = null;
      if (options.input && options.input !== true) {
        const doc = await readScanDocument(options);
        const wanted = absPath.toLowerCase().replace(/[\\/]+$/, "");
        entry = (doc.entries || []).find((item) => String(item.absPath || "").toLowerCase().replace(/[\\/]+$/, "") === wanted) || null;
        if (!entry) {
          io.writeError("扫描 JSON 里没有这个路径：" + absPath + "（去掉 --input 可直接扫这一个目录）\n");
          return { code: 1 };
        }
        relPath = entry.relPath || relPath;
      } else {
        io.writeError("正在只读统计目标目录（不会联网）：" + absPath + "\n");
        entry = await scanDirectory(rootName, absPath, {});
      }
      const outcome = await lookup({
        relPath,
        absPath,
        childNames: (entry && entry.childNames) || [],
        extTop: (entry && entry.extTop) || [],
        researcher: null,
        cache: { force: Boolean(options.force) },
      });
      const lines = [];
      lines.push("联网查询 · 阶段一.五（只构造查询串，绝不在本命令内发起网络请求）");
      lines.push("");
      lines.push("目标路径：" + absPath);
      lines.push("相对路径：" + (relPath || "(未知)"));
      lines.push("目录内容：" + formatCount((entry && entry.files) || 0) + " 个文件 / " + formatBytes((entry && entry.bytes) || 0));
      lines.push("将要发送的查询串：" + outcome.query);
      lines.push("安全性：" + outcome.safety + "（" + outcome.label + " / 置信度 " + outcome.confidence + "）");
      if (outcome.cached && outcome.result) {
        lines.push("缓存：命中（" + outcome.cacheFile + "）" + (outcome.savedAt ? "，采集于 " + outcome.savedAt : ""));
        if (outcome.result.summary) lines.push("【联网·未证实】" + outcome.result.summary);
        for (const source of outcome.result.sources || []) lines.push("  来源：" + source);
        lines.push("  " + outcome.result.disclaimer);
      } else {
        lines.push("缓存：未命中（" + outcome.cacheFile + "）");
        lines.push("联网能力：" + (outcome.reason === REASON_NEEDS_CONFIRM ? "已配置，但需要用户先确认发送内容" : "未配置（researcher = null）"));
        lines.push("原因：" + (outcome.reason || "-"));
        lines.push("启用方式：给 lookup() 注入 researcher(query) => Promise<{ summary, sources }>；");
        lines.push("          DSH 插件里可用 ctx.web.search() 实现。命令行本阶段固定不联网，避免把机器信息发出去。");
      }
      lines.push("");
      lines.push("隐私：查询串只包含目录名、最多 3 个子目录名与 3 类扩展名；已剔除用户名、盘符与完整路径。");
      lines.push("提示：联网结果的安全级恒为 " + outcome.safety + "、标签恒为 " + LABEL + "，不会因为联网结论把目录标成 safe。");
      io.write(lines.join("\n") + "\n");
      return { code: 0 };
    }

    if (command === "report" || command === "plan") {
      const doc = await readScanDocument(options);
      const knowledge = await loadKnowledge(knowledgeDirFrom(options), {});
      const judgements = resolveJudgements(doc, knowledge, options, io);
      const meta = metaOf(doc, knowledge, judgements);
      if (command === "report") {
        const text = renderReport(judgements, meta, options.format && options.format !== true ? String(options.format) : "table");
        await emit(text, options, io);
        return { code: 0 };
      }
      const plan = buildPlan(judgements, {
        safeOnly: Boolean(options["safe-only"]),
        minBytes: Math.max(0, toNumber(options["min-mb"], 0)) * 1024 * 1024,
        generatedAt: doc.generatedAt,
      });
      const text = renderPlan(plan, meta, options.format && options.format !== true ? String(options.format) : "md");
      await emit(text, options, io);
      io.writeError("计划生成：" + plan.totals.actions + " 条动作，合计 " + plan.totals.bytes + " 字节；未执行任何命令\n");
      return { code: 0 };
    }

    io.writeError("未知命令：" + command + "\n" + USAGE + "\n");
    return { code: 2 };
  } catch (err) {
    io.writeError("运行失败：" + (err && err.message ? err.message : String(err)) + "\n");
    return { code: 1 };
  }
}

const invokedDirectly = (() => {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return pathToFileURL(resolve(entry)).href === import.meta.url;
  } catch (err) {
    return false;
  }
})();

if (invokedDirectly) {
  run(process.argv.slice(2))
    .then((result) => {
      process.exitCode = result.code;
    })
    .catch((err) => {
      process.stderr.write("运行失败：" + (err && err.stack ? err.stack : String(err)) + "\n");
      process.exitCode = 1;
    });
}
