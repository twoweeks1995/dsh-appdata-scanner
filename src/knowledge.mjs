// src/knowledge.mjs —— 知识库加载与匹配（零依赖）
// 知识库文件：knowledge/<root>.json，内容为数组，元素 schema 见 SPEC.md。
// 契约要求：文件缺失 / 目录缺失 / 内容损坏都必须降级为空知识库，让启发式兜底。
import { readdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";

export const ROOT_NAMES = ["local", "roaming", "locallow"];

export const CATEGORIES = [
  "browser-profile",
  "app-data",
  "cache",
  "logs",
  "installer-cache",
  "crash-dump",
  "temp",
  "updater",
  "virtualization",
  "system",
  "game-data",
  "chat-data",
  "dev-toolchain",
  "unknown",
];

export const SAFETIES = ["safe", "mixed", "never"];
export const CONFIDENCES = ["high", "medium", "low"];

const REGEX_SPECIALS = /[$()*+.?[\\\]^{|}]/g;

/** 统一成反斜杠分隔、无首尾分隔符、无空段、无 "." 段的相对路径。 */
export function normalizeRelPath(value) {
  if (typeof value !== "string") return "";
  const parts = value.split(/[\\/]+/);
  const kept = [];
  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed || trimmed === ".") continue;
    kept.push(trimmed);
  }
  return kept.join("\\");
}

/**
 * match 通配转正则：* 只匹配单层内的任意字符（不含反斜杠），** 匹配任意层，? 匹配单字符。
 * 整串锚定、大小写不敏感（契约要求）。
 */
export function globToRegExp(pattern) {
  const text = normalizeRelPath(pattern);
  let source = "^";
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === "*") {
      if (text[i + 1] === "*") {
        source += ".*";
        i += 1;
      } else {
        source += "[^\\\\]*";
      }
      continue;
    }
    if (ch === "?") {
      source += "[^\\\\]";
      continue;
    }
    source += ch.replace(REGEX_SPECIALS, "\\$&");
  }
  return new RegExp(source + "$", "i");
}

/**
 * 预编译一条 match：返回 null 表示空匹配串。
 * spec = 非通配的“字面段”数量，即具体度（"Edge\User Data\*\Cache" -> 3，"*" -> 0）。
 */
export function patternInfo(pattern) {
  const text = normalizeRelPath(pattern);
  if (!text) return null;
  let literal = 0;
  let wild = false;
  for (const ch of text) {
    if (ch === "*" || ch === "?") wild = true;
    else if (ch !== "\\") literal += 1;
  }
  let spec = 0;
  for (const segment of text.split("\\")) {
    if (segment && segment !== "*" && segment !== "**" && segment !== "?") spec += 1;
  }
  return { text, re: globToRegExp(text), wild, literal, spec };
}

export function matchesPattern(info, relPath) {
  if (!info) return false;
  const text = normalizeRelPath(relPath);
  if (!text) return false;
  return info.re.test(text);
}

/** 路径的所有尾段：a\b\c -> [a\b\c, b\c, c] */
export function pathSuffixes(relPath) {
  const text = normalizeRelPath(relPath);
  if (!text) return [];
  const parts = text.split("\\");
  const out = [];
  for (let i = 0; i < parts.length; i += 1) out.push(parts.slice(i).join("\\"));
  return out;
}

function asText(value) {
  if (typeof value === "string") return value.trim();
  if (value === null || value === undefined) return "";
  return String(value);
}

function entryList(knowledge) {
  if (Array.isArray(knowledge)) return knowledge;
  if (knowledge && Array.isArray(knowledge.entries)) return knowledge.entries;
  return [];
}

function coerceChildren(rawChildren, notes) {
  const children = [];
  if (!Array.isArray(rawChildren)) return children;
  for (const raw of rawChildren) {
    if (!raw || typeof raw !== "object") {
      notes.push("children 中存在非对象条目，已忽略");
      continue;
    }
    const info = patternInfo(raw.match !== undefined ? raw.match : raw.pattern);
    if (!info) {
      notes.push("children 条目缺少 match，已忽略");
      continue;
    }
    // children 允许 safe / mixed / never；mixed 容器不能整删，应展开更具体的子规则
    // 非法值按 never 处理（保守：宁可不删）
    const safety = SAFETIES.indexOf(raw.safety) >= 0 ? raw.safety : "never";
    if (SAFETIES.indexOf(raw.safety) < 0) notes.push("children 条目 safety 非法（" + asText(raw.safety) + "），按 never 处理");
    children.push({
      match: info.text,
      info,
      order: children.length,
      safety,
      purpose: asText(raw.purpose),
      ifDeleted: asText(raw.ifDeleted),
      evidence: asText(raw.evidence),
    });
  }
  return children;
}

/** 把一条原始知识库记录规整成内部条目；无法使用时返回 entry: null 并给出原因。 */
export function coerceEntry(raw, context) {
  const notes = [];
  const ctx = context || {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { entry: null, notes: ["条目不是对象"] };
  }
  const info = patternInfo(raw.match !== undefined ? raw.match : raw.pattern);
  if (!info) return { entry: null, notes: ["缺少 match 字段"] };
  const safety = SAFETIES.indexOf(raw.safety) >= 0 ? raw.safety : "";
  if (!safety) return { entry: null, notes: ["safety 非法或缺失：" + asText(raw.safety)] };
  let category = "unknown";
  if (CATEGORIES.indexOf(raw.category) >= 0) category = raw.category;
  else notes.push("category 非法或缺失（" + asText(raw.category) + "），按 unknown 处理");
  let confidence = "medium";
  if (CONFIDENCES.indexOf(raw.confidence) >= 0) confidence = raw.confidence;
  else notes.push("confidence 非法或缺失，按 medium 处理");
  const children = coerceChildren(raw.children, notes);
  if (safety === "mixed" && children.length === 0) {
    notes.push("safety=mixed 但没有可用的 children，拆分将退化为按扫描到的子目录启发式判定");
  }
  const declaredRoot = ROOT_NAMES.indexOf(asText(raw.root).toLowerCase()) >= 0 ? asText(raw.root).toLowerCase() : "";
  const contextRoot = ROOT_NAMES.indexOf(asText(ctx.root)) >= 0 ? asText(ctx.root) : "";
  return {
    entry: {
      root: declaredRoot || contextRoot,
      source: ctx.file || "",
      index: typeof ctx.index === "number" ? ctx.index : -1,
      order: typeof ctx.index === "number" ? ctx.index : 1e9,
      match: info.text,
      pattern: info,
      owner: asText(raw.owner) || "未知",
      purpose: asText(raw.purpose),
      category,
      safety,
      confidence,
      ifDeleted: asText(raw.ifDeleted) || "未知",
      evidence: asText(raw.evidence),
      children,
      notes,
    },
    notes,
  };
}

/**
 * 加载 knowledge/ 目录下所有 *.json。
 * 任何一层失败都只记到 problems，返回空（或部分）知识库，绝不抛错。
 */
export async function loadKnowledge(dir, options) {
  const opts = options || {};
  const result = { dir: dir ? String(dir) : "", entries: [], files: [], problems: [], degraded: false };
  if (!dir) {
    result.problems.push({ file: "", message: "未指定知识库目录，仅使用启发式判定" });
    result.degraded = true;
    return result;
  }
  let names;
  try {
    names = await readdir(dir);
  } catch (err) {
    const code = err && err.code ? err.code : "ERROR";
    result.problems.push({ file: String(dir), message: "知识库目录不可读（" + code + "），仅使用启发式判定" });
    result.degraded = true;
    return result;
  }
  const jsonFiles = names.filter((name) => name.toLowerCase().endsWith(".json")).sort();
  if (jsonFiles.length === 0) {
    result.problems.push({ file: String(dir), message: "知识库目录内没有 *.json，仅使用启发式判定" });
    result.degraded = true;
    return result;
  }
  // 维护者笔记独立保存，缺失或损坏不影响公开知识库加载。
  let evidenceNotes = null;
  const evidenceFile = opts.evidenceFile === undefined
    ? join(dir, "..", ".private", "knowledge-evidence.json")
    : opts.evidenceFile;
  try {
    evidenceNotes = JSON.parse((await readFile(evidenceFile, "utf8")).replace(/^\uFEFF/, ""));
  } catch {
    // 私密笔记不是判定依赖，静默跳过。
  }
  for (const file of jsonFiles) {
    const full = join(dir, file);
    let text;
    try {
      text = await readFile(full, "utf8");
    } catch (err) {
      result.problems.push({ file, message: "读取失败：" + (err && err.code ? err.code : String(err && err.message)) });
      continue;
    }
    text = text.replace(/^\uFEFF/, "");
    let data;
    try {
      data = JSON.parse(text);
    } catch (err) {
      result.problems.push({ file, message: "JSON 解析失败：" + String(err && err.message) });
      continue;
    }
    let list = null;
    if (Array.isArray(data)) list = data;
    else if (data && Array.isArray(data.entries)) list = data.entries;
    if (!list) {
      result.problems.push({ file, message: "内容不是数组（既不是数组也没有 entries 数组），已跳过" });
      continue;
    }
    const stem = basename(file).replace(/\.json$/i, "").toLowerCase();
    const fileRoot = ROOT_NAMES.indexOf(stem) >= 0 ? stem : "";
    if (!fileRoot && !opts.allowUnknownFileName) {
      result.problems.push({ file, message: "文件名不是 local/roaming/locallow，条目仍需自带 root 字段才能生效" });
    }
    let accepted = 0;
    list.forEach((raw, index) => {
      const coerced = coerceEntry(raw, { file, index: index + 1, root: fileRoot });
      if (!coerced.entry) {
        result.problems.push({ file, message: "第 " + (index + 1) + " 条被忽略：" + coerced.notes.join("；") });
        return;
      }
      const group = evidenceNotes && Object.hasOwn(evidenceNotes, stem) ? evidenceNotes[stem] : null;
      const match = raw.match;
      if (!Object.hasOwn(raw, "evidence") && group && Object.hasOwn(group, match) && typeof group[match] === "string") {
        coerced.entry.evidence = group[match];
      }
      result.entries.push(coerced.entry);
      accepted += 1;
    });
    result.files.push({ file, declared: list.length, accepted });
  }
  if (result.entries.length === 0) result.degraded = true;
  return result;
}

/** 排序键：具体度高者优先；具体度相同则声明顺序靠前者优先；再相同则走的尾段更少者优先。 */
function isBetter(candidate, best) {
  if (!best) return true;
  if (candidate.spec !== best.spec) return candidate.spec > best.spec;
  if (candidate.order !== best.order) return candidate.order < best.order;
  return candidate.viaDepth < best.viaDepth;
}

/**
 * 在知识库中找最匹配 entry 相对路径的条目。
 * 打分：精确匹配优先 -> 字面量更多（更具体）优先 -> 需要走的尾段更少优先。
 */
export function matchEntry(knowledge, root, relPath, options) {
  const opts = options || {};
  const target = normalizeRelPath(relPath);
  if (!target) return null;
  const candidates = opts.suffix ? pathSuffixes(target) : [target];
  let best = null;
  for (const entry of entryList(knowledge)) {
    if (entry.root && root && entry.root !== root) continue;
    if (!entry.pattern) continue;
    let hitPath = null;
    let viaDepth = -1;
    for (let i = 0; i < candidates.length; i += 1) {
      if (matchesPattern(entry.pattern, candidates[i])) {
        hitPath = candidates[i];
        viaDepth = i;
        break;
      }
    }
    if (hitPath === null) continue;
    const score = { spec: entry.pattern.spec, order: typeof entry.order === "number" ? entry.order : 1e9, viaDepth };
    if (isBetter(score, best ? best.score : null)) best = { entry, score, hitPath };
  }
  return best;
}

function pathList(value) {
  const out = [];
  const list = Array.isArray(value) ? value : value ? [value] : [];
  for (const candidate of list) {
    const text = normalizeRelPath(candidate);
    if (text && out.indexOf(text) < 0) out.push(text);
  }
  return out;
}

/**
 * 在 children 规则中匹配一条子路径。
 * 契约：children[].match 相对父条目，所以 primary 传相对父路径；fallback 传给宽容写法用
 * （相对根的完整路径 + 各尾段）。两层都命中不了才算未命中。
 * 排序按“具体度”而非数组顺序：字面段多者优先，同具体度按声明顺序。
 */
export function matchRule(rules, primary, fallback) {
  if (!Array.isArray(rules) || rules.length === 0) return null;
  const tiers = [pathList(primary), pathList(fallback)].filter((tier) => tier.length > 0);
  for (const tier of tiers) {
    let best = null;
    for (const rule of rules) {
      if (!rule || !rule.info) continue;
      let hitPath = null;
      for (const path of tier) {
        if (matchesPattern(rule.info, path)) {
          hitPath = path;
          break;
        }
      }
      if (hitPath === null) continue;
      const score = { spec: rule.info.spec, order: typeof rule.order === "number" ? rule.order : 1e9, viaDepth: 0 };
      if (isBetter(score, best ? best.score : null)) best = { rule, score, hitPath };
    }
    if (best) return best;
  }
  return null;
}
