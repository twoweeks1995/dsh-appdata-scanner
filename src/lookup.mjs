// src/lookup.mjs —— 阶段一.五：按需联网查询（引擎本身零网络代码）
//
// 强制规则（SPEC 第 102~110 行）：
//   · 扫描/报告/计划永不联网；只有显式 lookup 才可能发起请求，一次一条
//   · 联网结果 safety 恒为 "unknown"、confidence 恒为 "low"、标签恒为【联网·未证实】
//   · 必须保留来源 URL，并区分「检索到的事实」与「模型归纳」
//   · 结果写本地缓存，键 = 相对路径 + 内容签名，命中即不再请求
//   · 未配置联网能力时只给建议查询串，不报错
//   · 查询串只含目录名 + 少量子目录名 + 主要扩展名，不含用户名 / 绝对路径 / 文件内容
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir, userInfo } from "node:os";

export const LABEL = "【联网·未证实】";
export const SAFETY = "unknown";
export const CONFIDENCE = "low";
export const DEFAULT_CACHE_FILE = fileURLToPath(new URL("../.cache/lookup.json", import.meta.url));
export const REASON_NO_RESEARCHER = "未配置联网能力";
export const REASON_NEEDS_CONFIRM = "需要用户确认后才能发送";
export const REASON_EMPTY = "researcher 返回空结果";
export const DISCLAIMER = "以下内容来自联网检索后的模型归纳，未经本机验证；请以来源 URL 为准。";

const MAX_QUERY_LENGTH = 200;
const MAX_CHILD_NAMES = 3;
const MAX_EXTENSIONS = 3;
const GENERIC_NAMES = new Set([
  "cache",
  "caches",
  "temp",
  "tmp",
  "logs",
  "log",
  "data",
  "bin",
  "config",
  "configs",
  "settings",
  "update",
  "updates",
  "blob_storage",
  "gpucache",
  "code cache",
  "indexeddb",
  "local storage",
  "session storage",
]);
const GENERIC_USERS = new Set(["user", "users", "admin", "home", "public", "default", "guest"]);

const REGEX_SPECIALS = /[$()*+.?[\\\]^{|}]/g;

function escapeRegExp(text) {
  return String(text).replace(REGEX_SPECIALS, "\\$&");
}

/** 本机上可能与“用户身份”相关的字符串，用于发布前剔除。 */
export function usernameCandidates() {
  const found = [];
  const push = (value) => {
    const text = String(value || "").trim();
    if (text.length < 2) return;
    if (GENERIC_USERS.has(text.toLowerCase())) return;
    if (found.indexOf(text) < 0) found.push(text);
  };
  try {
    const info = userInfo();
    if (info) push(info.username);
  } catch (err) {
    // 某些环境拿不到 userInfo，忽略
  }
  push(process.env.USERNAME);
  push(process.env.USER);
  push(process.env.USERPROFILE ? basename(process.env.USERPROFILE) : "");
  try {
    push(basename(homedir()));
  } catch (err) {
    // 忽略
  }
  return found;
}

/** 去掉盘符路径、UNC、posix 路径与用户名，只留语义文字。 */
export function sanitize(text) {
  let out = String(text === undefined || text === null ? "" : text);
  out = out.replace(/[A-Za-z]:[\\/][^\s"']*/g, " ");
  out = out.replace(/\\\\[^\s"']+/g, " ");
  out = out.replace(/(^|\s)\/(?:[^\s/]+\/)*[^\s/]*/g, " ");
  out = out.replace(/\bUsers[\\/][^\s\\/]+/gi, " ");
  for (const name of usernameCandidates()) {
    out = out.replace(new RegExp(escapeRegExp(name), "gi"), " ");
  }
  return out.replace(/\s+/g, " ").trim();
}

function targetName(input) {
  const relPath = String((input && input.relPath) || "");
  const segments = relPath.split(/[\\/]+/).filter(Boolean);
  if (segments.length > 0) return segments[segments.length - 1];
  const absPath = String((input && input.absPath) || "");
  return basename(absPath) || "";
}

/** 子目录名：剔除 GUID/哈希/纯数字，通用名（Cache/Temp…）排到最后。 */
export function pickChildNames(childNames, limit) {
  const max = Number(limit) > 0 ? Number(limit) : MAX_CHILD_NAMES;
  const list = Array.isArray(childNames) ? childNames : [];
  const preferred = [];
  const generic = [];
  const seen = new Set();
  for (const raw of list) {
    const name = sanitize(raw).replace(/[\r\n\t]/g, " ").trim();
    if (!name || name.length > 32) continue;
    if (!/[A-Za-z\u4e00-\u9fff]/.test(name)) continue;
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}/i.test(name)) continue;
    if (/^[0-9a-f]{16,}$/i.test(name)) continue;
    if (name.indexOf("#") >= 0) continue; // 形如 “xxx#3#1973000289” 的用户自建名，不进查询串
    if (/\d{6,}/.test(name)) continue;    // 长数字串多为 ID/时间戳，没有检索价值
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    if (GENERIC_NAMES.has(key)) generic.push(name);
    else preferred.push(name);
  }
  return preferred.concat(generic).slice(0, max);
}

/** 主要扩展名：只保留短小的字母数字扩展名。 */
export function pickExtensions(extTop, limit) {
  const max = Number(limit) > 0 ? Number(limit) : MAX_EXTENSIONS;
  const list = Array.isArray(extTop) ? extTop : [];
  const out = [];
  for (const pair of list) {
    const ext = String(Array.isArray(pair) ? pair[0] : pair || "").toLowerCase().trim();
    if (!ext || ext.length > 8) continue;
    if (!/^[a-z0-9_-]+$/.test(ext)) continue;
    if (out.indexOf(ext) >= 0) continue;
    out.push(ext);
    if (out.length >= max) break;
  }
  return out;
}

/**
 * 构造建议查询串：目录名 + 少量子目录名 + 主要扩展名。
 * 绝不包含用户名、盘符、完整路径或文件内容。
 */
export function buildQuery(input) {
  const source = input || {};
  const name = sanitize(targetName(source)) || "未知目录";
  const children = pickChildNames(source.childNames).map((item) => sanitize(item)).filter(Boolean);
  const exts = pickExtensions(source.extTop);
  const parts = [name, "AppData", "目录", "能否删除", "用途"];
  if (children.length > 0) parts.push("子目录", children.join(" "));
  if (exts.length > 0) parts.push("文件类型", exts.join(" "));
  const query = sanitize(parts.join(" ")).replace(/\s+/g, " ").trim();
  return query.slice(0, MAX_QUERY_LENGTH);
}

function fnv1a(text) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0;
  }
  return ("00000000" + hash.toString(16)).slice(-8);
}

/** 内容签名：相对路径 + 子目录名集合 + 扩展名分布，用于缓存键。 */
export function contentSignature(input) {
  const source = input || {};
  const rel = String(source.relPath || "").toLowerCase();
  const children = (Array.isArray(source.childNames) ? source.childNames : [])
    .map((name) => String(name).toLowerCase())
    .sort()
    .slice(0, 50)
    .join(",");
  const exts = (Array.isArray(source.extTop) ? source.extTop : [])
    .map((pair) => (Array.isArray(pair) ? String(pair[0]).toLowerCase() + ":" + pair[1] : String(pair).toLowerCase()))
    .join(",");
  const raw = rel + "|" + children + "|" + exts;
  return fnv1a(raw) + "-" + raw.length;
}

export function cacheKey(input) {
  return String((input && input.relPath) || "").toLowerCase() + "::" + contentSignature(input);
}

/** 规整 researcher 的返回值：区分「来源线索」与「模型归纳」。 */
export function normalizeResult(raw) {
  if (!raw || typeof raw !== "object") return null;
  const summary = typeof raw.summary === "string" ? raw.summary.trim() : "";
  const sources = (Array.isArray(raw.sources) ? raw.sources : [])
    .map((item) => String(item === undefined || item === null ? "" : item).trim())
    .filter(Boolean);
  const facts = (Array.isArray(raw.facts) ? raw.facts : [])
    .map((item) => ({
      text: String((item && item.text) || "").trim(),
      source: String((item && item.source) || "").trim(),
    }))
    .filter((item) => item.text);
  if (!summary && sources.length === 0 && facts.length === 0) return null;
  return {
    kind: "模型归纳",
    verified: false,
    summary,
    sources,
    facts,
    disclaimer: DISCLAIMER,
  };
}

async function readCache(file) {
  try {
    const text = await readFile(file, "utf8");
    const data = JSON.parse(text.replace(/^\uFEFF/, ""));
    if (data && typeof data === "object" && data.entries && typeof data.entries === "object") return data;
    return { version: 1, entries: {} };
  } catch (err) {
    return { version: 1, entries: {} };
  }
}

async function writeCache(file, data) {
  try {
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify(data, null, 2) + "\n", "utf8");
    return true;
  } catch (err) {
    return false;
  }
}

/**
 * 单条目录的联网查询。
 * @param {object} options
 * @param {string} options.relPath    相对 AppData 根的路径（用于缓存键与展示）
 * @param {string} [options.absPath]  绝对路径（只用于推导目录名，绝不进查询串）
 * @param {string[]} [options.childNames] 一级子目录名
 * @param {[string, number][]} [options.extTop] 主要扩展名
 * @param {((query: string) => Promise<{summary: string, sources: string[]} | null>) | null} options.researcher
 *        注入的联网能力；为 null 时只返回建议查询串
 * @param {{file?: string, force?: boolean, now?: number}} [options.cache]
 * @param {boolean | ((query: string) => boolean | Promise<boolean>)} [options.confirm]
 *        隐私确认：SPEC 要求发送前展示确切内容并确认；未确认不发送
 */
export async function lookup(options) {
  const opts = options || {};
  const relPath = String(opts.relPath || "");
  const signatureInput = { relPath, childNames: opts.childNames, extTop: opts.extTop };
  const query = buildQuery({ relPath, absPath: opts.absPath, childNames: opts.childNames, extTop: opts.extTop });
  const signature = contentSignature(signatureInput);
  const key = cacheKey(signatureInput);

  const cacheOptions = opts.cache || {};
  const cacheFile = cacheOptions.file ? String(cacheOptions.file) : DEFAULT_CACHE_FILE;
  const force = Boolean(cacheOptions.force);

  const base = {
    relPath,
    query,
    signature,
    cacheFile,
    safety: SAFETY,
    confidence: CONFIDENCE,
    label: LABEL,
    cached: false,
    result: null,
    reason: null,
  };

  if (!force) {
    const cache = await readCache(cacheFile);
    const hit = cache.entries[key];
    if (hit && hit.result) {
      return Object.assign({}, base, {
        cached: true,
        savedAt: hit.savedAt || null,
        result: normalizeResult(hit.result),
        reason: null,
      });
    }
  }

  const researcher = opts.researcher;
  if (typeof researcher !== "function") {
    return Object.assign({}, base, { result: null, reason: REASON_NO_RESEARCHER, needsConfirm: false });
  }

  let confirmed = opts.confirm === true;
  if (!confirmed && typeof opts.confirm === "function") {
    try {
      confirmed = Boolean(await opts.confirm(query));
    } catch (err) {
      confirmed = false;
    }
  }
  if (!confirmed) {
    return Object.assign({}, base, { result: null, reason: REASON_NEEDS_CONFIRM, needsConfirm: true });
  }

  let raw = null;
  let failure = null;
  try {
    raw = await researcher(query);
  } catch (err) {
    failure = "researcher 调用失败：" + (err && err.message ? err.message : String(err));
  }
  if (failure) return Object.assign({}, base, { result: null, reason: failure, needsConfirm: false });

  const result = normalizeResult(raw);
  if (!result) {
    return Object.assign({}, base, { result: null, reason: REASON_EMPTY, needsConfirm: false });
  }

  const cache = await readCache(cacheFile);
  const savedAt = new Date(Number(cacheOptions.now) || Date.now()).toISOString();
  cache.version = 1;
  cache.entries[key] = { relPath, signature, query, savedAt, result };
  const saved = await writeCache(cacheFile, cache);
  return Object.assign({}, base, { result, reason: null, needsConfirm: false, cacheSaved: saved, savedAt });
}
