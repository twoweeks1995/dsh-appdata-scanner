// plugin/index.js —— host 半：把 src/ 的只读扫描引擎暴露成 HTTP JSON 接口。
// 阶段二只有读：不删除、不写文件、不入注册表。
// 唯一的副作用是 reveal：拉起 explorer.exe /select,…，且只打开 AppData 之内的已存在目录。
// 注意：reveal 故意不用 ctx.subprocess —— 它在 Windows 上会经过受限令牌的 runner，
// 而本机的 runner 起子进程会以 0xC0000142 失败；插件宿主自身不受工作区沙箱约束，故直接用 node:child_process。
import { spawn } from "node:child_process";
import { readdir, realpath, stat } from "node:fs/promises";
import { dirname, join, normalize, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { LIMITS, ROOT_NAMES, defaultRoots, scan, scanDirectory } from "../src/scanner.mjs";
import { loadKnowledge, matchEntry } from "../src/knowledge.mjs";
import { classifyEntries, summarize } from "../src/classifier.mjs";
import { buildPlan } from "../src/plan.mjs";
import {
  CONFIDENCE,
  DISCLAIMER,
  LABEL,
  SAFETY,
  lookup,
  normalizeResult,
  REASON_EMPTY,
  REASON_NEEDS_CONFIRM,
  REASON_NO_RESEARCHER,
} from "../src/lookup.mjs";

/** cordis 插件名（同时是 cordis.patch.yml 里的行 id）。 */
export const name = "appdata-scanner";
/**
 * 路由挂在 webServer 上；web 提供联网检索（@deepseek-ai/dsh-web，服务名取自它的 super(ctx, "web")，
 * 方法签名 async search(request, signal)，request = { query, maxResults }）。
 *
 * 注意：cordis 会拦截「未在 inject 里声明的服务」——访问 ctx.web 而 inject 里没有 "web" 时，
 * 取属性会直接抛 cannot get property "web" without inject，被 try/catch 吞掉后就表现为
 * “未配置联网能力”。所以必须在这里声明。
 */
export const inject = ["webServer", "web"];

const API = "/api/appdata-scanner";
const KNOWLEDGE_DIR = fileURLToPath(new URL("../knowledge/", import.meta.url));
const MAX_BODY_BYTES = 65536;
const MAX_SEARCH_RESULTS = 5;
const DEFAULT_SEARCH_TIMEOUT_MS = 20000;
/** capabilities 探针：极小查询 + 短超时，结果在内存里缓存（默认 5 分钟），不每次请求都打后端。 */
const CAPABILITY_PROBE_QUERY = "appdata";
const CAPABILITY_PROBE_TIMEOUT_MS = 5000;
const CAPABILITY_PROBE_MAX_RESULTS = 1;
const CAPABILITY_CACHE_MS = 5 * 60 * 1000;
/** dsh-web-search-deepseek 在没配 API key 时抛的 WebError 特征（code 与 message 前缀）。 */
const WEB_CREDENTIAL_MISSING_CODE = "WEB_PROVIDER_CREDENTIAL_MISSING";
const WEB_CREDENTIAL_MISSING_RE = /has no API key/i;
/** 降级成「复制查询串去问 agent」时给用户的说明。/lookup 与 /capabilities 共用。 */
const LOOKUP_COPY_HINT = "当前部署没有配置联网检索凭据。已为你准备好查询串，复制后到对话里问 agent，那边可以用账号搜索。";
const LOOKUP_COPY_HINT_NO_WEB = "当前部署没有联网检索能力。已为你准备好查询串，复制后到对话里问 agent。";
/** 搜索结果的来源条目：保留 title/snippet（缺失给空串），模型总结要用。 */
const SOURCE_FIELD_MAX = 4000;
/** profile 里 agent-default-model 配的就是这对；作为模型总结的首选路由。 */
const LLM_DEFAULT_PROVIDER = "deepseek-account";
const LLM_DEFAULT_MODEL = "deepseek-flash";
/** 模型总结：2~4 句中文，maxTokens≈400，20s 硬超时（config.llmSummaryTimeoutMs 覆盖）。 */
const LLM_SUMMARY_TIMEOUT_MS = 20000;
const LLM_SUMMARY_MAX_TOKENS = 400;
const LLM_SUMMARY_MAX_SOURCES = 5;
const LLM_SUMMARY_SNIPPET_CHARS = 300;
const LLM_SUMMARY_MAX_ROUTES = 3;
const LLM_SUMMARY_MAX_CHARS = 1200;
const LLM_SUMMARY_SYSTEM = [
  "你在帮用户判断 Windows AppData 下的某个目录能不能删。",
  "只依据用户给出的『来源摘录』作答：来源不足以判断时就写「信息不足」，不要臆断，也不要补充来源之外的事实。",
  "用简体中文回答，2~4 句话，依次说清：① 这个目录属于哪个软件；② 里面通常放什么；③ 能不能删、删了会怎样。",
  "不要输出 markdown、不要加序号或小标题、不要复述问题。",
].join("");
const EXPLORER = "explorer.exe";
/** 交给 subprocess 的收尾宽限期，以及我们等它退出的上限（超时按“已交给桌面进程”处理）。 */
const REVEAL_GRACE_MS = 2000;
const REVEAL_WAIT_MS = 5000;
const REVEAL_LOG_BYTES = 4096;
/** explorer 把请求转交给已在运行的桌面进程后以 1 退出，属成功；其它非零才算失败。 */
const REVEAL_EXIT_OK = [0, 1];
/** 树形目录：排序取值、单目录统计预算、整次请求预算、并发统计目录数、缓存与直接文件统计的并发。 */
const TREE_SORTS = ["name", "size", "date"];
const TREE_DIRS = ["asc", "desc"];
const TREE_DIR_MS = 5000;
const TREE_BUDGET_MS = 20000;
const TREE_FANOUT = 6;
const TREE_CACHE_MAX = 4000;
const TREE_STAT_CONCURRENCY = 32;

function normalizeConfig(config) {
  const src = config && typeof config === "object" ? config : {};
  const roots = Array.isArray(src.roots) ? src.roots.filter((item) => ROOT_NAMES.indexOf(item) >= 0) : [];
  const num = (value, fallback) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  };
  return {
    roots,
    maxSeconds: num(src.maxSeconds, 0),
    limits: src.limits && typeof src.limits === "object" ? src.limits : undefined,
    homeDir: typeof src.homeDir === "string" && src.homeDir ? src.homeDir : undefined,
    knowledgeDir: typeof src.knowledgeDir === "string" && src.knowledgeDir ? src.knowledgeDir : KNOWLEDGE_DIR,
    searchTimeoutMs: num(src.searchTimeoutMs, DEFAULT_SEARCH_TIMEOUT_MS),
    treeDirMs: num(src.treeDirMs, TREE_DIR_MS),
    treeBudgetMs: num(src.treeBudgetMs, TREE_BUDGET_MS),
    llmSummaryTimeoutMs: num(src.llmSummaryTimeoutMs, LLM_SUMMARY_TIMEOUT_MS),
  };
}

function log(ctx, level, message) {
  try {
    if (ctx && ctx.logger && typeof ctx.logger[level] === "function") ctx.logger[level](message);
  } catch (err) {
    // 日志不可用不应影响插件
  }
}

function sendJson(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

function fail(res, err) {
  const message = err && err.message ? err.message : String(err);
  sendJson(res, 500, { ok: false, error: message });
}

function requestUrl(req) {
  try {
    return new URL(req && req.url ? req.url : "/", "http://localhost");
  } catch (err) {
    return new URL("/", "http://localhost");
  }
}

function requireMethod(req, res, method) {
  const actual = String((req && req.method) || "GET").toUpperCase();
  if (actual === method) return true;
  sendJson(res, 405, { ok: false, error: "只支持 " + method + "（收到 " + actual + "）" });
  return false;
}

function queryNumber(params, key, fallback) {
  const raw = params.get(key);
  if (raw === null || raw === "") return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error("请求体超过 " + MAX_BODY_BYTES + " 字节");
    chunks.push(Buffer.from(chunk));
  }
  const text = chunks.length === 0 ? "" : Buffer.concat(chunks).toString("utf8");
  if (!text.trim()) return {};
  const data = JSON.parse(text);
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("请求体必须是 JSON 对象");
  return data;
}

/** 分类器内部用 knowledge-child 标注拆分子项；对外的 matchedBy 只保留 knowledge/heuristic/guess 三值。 */
function normalizeMatchedBy(judgements) {
  for (const judgement of judgements) {
    for (const item of [judgement].concat(judgement.children || [])) {
      if (item.matchedBy === "knowledge-child") {
        item.matchedByRaw = item.matchedBy;
        item.matchedBy = "knowledge";
      }
    }
  }
  return judgements;
}

function createState() {
  return {
    doc: null,
    knowledge: null,
    judgements: null,
    summary: null,
    scannedAt: null,
    pending: null,
    /** 树形目录的按需统计缓存：键 = 绝对路径（小写），值 = 统计记录。 */
    treeCache: new Map(),
    /** 同一路径的并发统计去重。 */
    treePending: new Map(),
    /** 知识库单独加载时的在途 promise（tree 不触发整盘扫描，但需要知识库）。 */
    knowledgePending: null,
    /** AppData 的真实路径（realpath 结果），用于识别 junction/符号链接逃逸。 */
    rootReal: null,
    /** 联网检索能力探测结果的缓存：{ mode: "api"|"copy"|"unknown", detail, checkedAt }。 */
    lookupCapability: null,
    /** 探针在途 promise，避免并发请求各探一次。 */
    capabilityPending: null,
    /** 上一次成功的模型总结路由（provider/model），命中后优先复用。 */
    llmRoute: null,
  };
}

async function scanOnce(config) {
  const roots = defaultRoots(config.homeDir);
  const rootNames = (config.roots.length > 0 ? config.roots : ROOT_NAMES).filter((item) => roots[item]);
  const knowledge = await loadKnowledge(config.knowledgeDir, {});
  // minMb 固定 0：全量留在内存里，体积过滤交给 entries/plan 的 minBytes 参数
  const doc = await scan({ roots, rootNames, minMb: 0, maxSeconds: config.maxSeconds, limits: config.limits });
  const judgements = normalizeMatchedBy(classifyEntries(doc.entries || [], knowledge, {}));
  return { doc, knowledge, judgements, summary: summarize(judgements), scannedAt: new Date().toISOString() };
}

async function ensureScanned(ctx, state, config, force) {
  if (state.pending !== null) await state.pending;
  else if (state.judgements !== null && !force) return state;
  if (state.judgements !== null && !force) return state;
  const startedAt = Date.now();
  log(ctx, "info", "开始只读扫描 AppData（阶段二）");
  const task = scanOnce(config);
  state.pending = task;
  try {
    const result = await task;
    Object.assign(state, result);
    log(ctx, "info", "扫描完成：" + result.judgements.length + " 条判定，耗时 " + (Date.now() - startedAt) + "ms");
  } finally {
    state.pending = null;
  }
  return state;
}

function summaryPayload(state) {
  const doc = state.doc || {};
  const knowledge = state.knowledge || {};
  const summary = state.summary || summarize([]);
  return {
    ok: true,
    generatedAt: doc.generatedAt || null,
    scannedAt: state.scannedAt,
    total: summary.entries,
    reclaimableBytes: summary.recoverableBytes,
    roots: doc.roots || [],
    stats: doc.stats || null,
    budget: doc.budget || null,
    knowledge: {
      dir: knowledge.dir || null,
      files: knowledge.files || [],
      degraded: Boolean(knowledge.degraded),
      problems: (knowledge.problems || []).slice(0, 8),
    },
    summary,
  };
}

function selectEntries(state, minBytes, root) {
  const wanted = String(root || "").trim().toLowerCase();
  return (state.judgements || []).filter((item) => {
    if ((item.bytes || 0) < minBytes) return false;
    if (!wanted || wanted === "all") return true;
    return String(item.root || "").toLowerCase() === wanted;
  });
}

/**
 * 在扫描文档里找与 relPath 对应的条目。客户端在树里钻到任意深度后，传过来的是带根前缀的完整相对路径
 * （"Local\Microsoft" / "Local\Microsoft\Edge"），而文档里只有一级目录、且存的是裸名字（"Microsoft"）。
 * 按优先级依次尝试，第一个命中即用：
 *   1 exact               —— relPath 或 absPath 直接命中文档条目
 *   2 root-prefix         —— <Local|Roaming|LocalLow>\<rest>，用 rest 在该根里再找一次
 *   3 descendant-context  —— <一级名>\<二级名>（正好两层）：用一级条目 children[] 里该二级目录
 *                            自己的 childNames/extTop 补上下文（children 里只有到二级的记录）
 *   4 ancestor            —— 取根前缀之后的第一个路径段当祖先（Local\Microsoft\Edge -> Microsoft），
 *                            只借它的 childNames/extTop 补上下文
 *   5 none
 * 后两级都只补上下文：查询串里的目录名始终由 lookup 的 targetName 取 relPath 最深那段，不会变成祖先/父级名字。
 */
function findEntry(state, relPath, absPath) {
  const entries = state.doc && Array.isArray(state.doc.entries) ? state.doc.entries : [];
  const wantedRel = String(relPath || "").trim().replace(/\//g, "\\").toLowerCase();
  const wantedAbs = String(absPath || "").trim().toLowerCase();
  for (const entry of entries) {
    if (wantedAbs && String(entry.absPath || "").toLowerCase() === wantedAbs) return { entry, matchedBy: "exact" };
    if (wantedRel && String(entry.relPath || "").toLowerCase() === wantedRel) return { entry, matchedBy: "exact" };
  }
  if (!wantedRel) return { entry: null, matchedBy: "none" };
  const segments = wantedRel.split("\\").filter(Boolean);
  const rootKey = segments.length > 0 && ROOT_NAMES.indexOf(segments[0]) >= 0 ? segments[0] : "";
  const rest = rootKey ? segments.slice(1) : segments;
  const byName = (name, requireSameRoot) => {
    for (const entry of entries) {
      if (requireSameRoot && entry.root !== rootKey) continue;
      if (String(entry.relPath || "").toLowerCase() === name) return entry;
    }
    return null;
  };
  if (rootKey && rest.length === 1) {
    const stripped = byName(rest[0], true);
    if (stripped) return { entry: stripped, matchedBy: "root-prefix" };
  }
  // descendant-context：只有正好两层时才能用 children[] 的二级记录；更深层没有对应记录，继续回落
  if (rest.length === 2) {
    const parentEntry = byName(rest[0], Boolean(rootKey));
    const childRecord = childRecordOf(parentEntry, rest[1]);
    // 记录里得真有可用的上下文才算命中，否则不硬凑，继续往 ancestor 回落
    if (childRecord) {
      const hasChildNames = Array.isArray(childRecord.childNames) && childRecord.childNames.length > 0;
      const hasExtTop = Array.isArray(childRecord.extTop) && childRecord.extTop.length > 0;
      if (hasChildNames || hasExtTop) {
        return { entry: parentEntry, context: childRecord, matchedBy: "descendant-context" };
      }
    }
  }
  if (rest.length >= 2) {
    const ancestor = byName(rest[0], Boolean(rootKey));
    if (ancestor) return { entry: ancestor, matchedBy: "ancestor" };
  }
  return { entry: null, matchedBy: "none" };
}

/** 在一级条目的 children[] 里按名字找二级记录（大小写不敏感，找不到返回 null）。 */
function childRecordOf(entry, name) {
  const wanted = String(name || "").toLowerCase();
  if (!wanted) return null;
  const children = entry && Array.isArray(entry.children) ? entry.children : [];
  for (const child of children) {
    if (String(child && child.name ? child.name : "").toLowerCase() === wanted) return child;
  }
  return null;
}

/** 没配联网检索凭据（账号模式在 HTTP 路由里永远用不上，只剩 API key 一条路）。 */
function isCredentialMissing(err) {
  if (!err) return false;
  if (err.code === WEB_CREDENTIAL_MISSING_CODE) return true;
  return WEB_CREDENTIAL_MISSING_RE.test(String(err.message || ""));
}

/** 把后端错误收敛成可读中文：界面不该出现整段英文实现细节。 */
function searchErrorReason(err) {
  const code = err && err.code ? String(err.code) : "";
  const text = String((err && err.message) || err || "");
  let detail;
  if (err && err.name === "AbortError") detail = "检索超时";
  else if (/timeout|timed out|abort/i.test(text)) detail = "检索超时";
  else if (/ECONNREFUSED|ENOTFOUND|EAI_AGAIN|network|fetch failed/i.test(text)) detail = "检索服务不可用";
  else if (/rate.?limit|quota|429/i.test(text)) detail = "检索配额已用尽";
  else detail = "检索服务返回了错误";
  return "联网检索失败：" + detail + (code ? "（" + code + "）" : "");
}

/**
 * 用 ctx.web.search() 实现 lookup 需要的 researcher。
 * web 服务不可用时返回 null（调用方据此降级，不抛错）。
 * 服务用 ctx.get("web") 取：cordis 的 get 不要求 inject，属性访问在未 inject 时会抛。
 * opts 可覆盖单次调用的 maxResults / 超时（capabilities 探针要用 1 条 + 5s）。
 */
function makeResearcher(ctx, config) {
  const web = getService(ctx, "web");
  if (!web || typeof web.search !== "function") return null;
  return async (query, options) => {
    const opts = options && typeof options === "object" ? options : {};
    const timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : config.searchTimeoutMs;
    const maxResults = Number(opts.maxResults) > 0 ? Number(opts.maxResults) : MAX_SEARCH_RESULTS;
    const signal = typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function"
      ? AbortSignal.timeout(timeoutMs)
      : undefined;
    const result = await web.search({ query, maxResults }, signal);
    // sources 保留 { url, title, snippet }：标题与摘录是模型总结的唯一依据，不能只留 url
    return {
      summary: result && typeof result.content === "string" ? result.content : "",
      sources: normalizeSources(result && result.sources),
    };
  };
}

function summaryRoute(ctx, state, config) {
  return async (req, res) => {
    if (!requireMethod(req, res, "GET")) return;
    try {
      await ensureScanned(ctx, state, config, false);
      sendJson(res, 200, summaryPayload(state));
    } catch (err) {
      fail(res, err);
    }
  };
}

function entriesRoute(ctx, state, config) {
  return async (req, res) => {
    if (!requireMethod(req, res, "GET")) return;
    try {
      const params = requestUrl(req).searchParams;
      const minBytes = queryNumber(params, "minBytes", 0);
      const root = params.get("root") || "";
      await ensureScanned(ctx, state, config, false);
      const entries = selectEntries(state, minBytes, root);
      const summary = summarize(entries);
      sendJson(res, 200, {
        ok: true,
        scannedAt: state.scannedAt,
        minBytes,
        root: root || null,
        total: entries.length,
        reclaimableBytes: summary.recoverableBytes,
        summary,
        entries,
      });
    } catch (err) {
      fail(res, err);
    }
  };
}

function planRoute(ctx, state, config) {
  return async (req, res) => {
    if (!requireMethod(req, res, "GET")) return;
    try {
      const params = requestUrl(req).searchParams;
      const minBytes = queryNumber(params, "minBytes", 0);
      const safeOnly = String(params.get("safeOnly") || "").toLowerCase();
      await ensureScanned(ctx, state, config, false);
      const plan = buildPlan(state.judgements || [], {
        minBytes,
        safeOnly: safeOnly === "1" || safeOnly === "true",
      });
      sendJson(res, 200, Object.assign({ ok: true, scannedAt: state.scannedAt }, plan));
    } catch (err) {
      fail(res, err);
    }
  };
}

function scanRoute(ctx, state, config) {
  return async (req, res) => {
    if (!requireMethod(req, res, "POST")) return;
    try {
      await ensureScanned(ctx, state, config, true);
      // 重扫后必须让树缓存整体失效：tree 按绝对路径缓存统计结果，
      // 只刷新扫描文档而不清缓存，界面上会一直显示删除之前的旧体积。
      state.treeCache.clear();
      state.treePending.clear();
      sendJson(res, 200, summaryPayload(state));
    } catch (err) {
      fail(res, err);
    }
  };
}

/**
 * 读一个 cordis 服务但不要求 inject：cordis 的 ctx.get(name) 明确「without the inject requirement」，
 * 未提供的服务返回 undefined；而 ctx.<name> 属性访问在未 inject 时会抛 cannot get property ... without inject。
 */
function getService(ctx, name) {
  if (!ctx) return undefined;
  try {
    if (typeof ctx.get === "function") {
      const found = ctx.get(name);
      if (found !== undefined && found !== null) return found;
    }
  } catch (err) {
    // 服务不可用：交给调用方降级
  }
  return undefined;
}

/** 只把字符串字段当值（其余一律空串，接口里绝不出现 undefined）。 */
function textField(value, limit) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) return "";
  return Number(limit) > 0 ? text.slice(0, Number(limit)) : text;
}

/** 规整一条来源：保留 url / title / snippet，缺失给空串。 */
function normalizeSource(item) {
  if (typeof item === "string") return { url: textField(item, SOURCE_FIELD_MAX), title: "", snippet: "" };
  if (!item || typeof item !== "object") return null;
  const url = textField(item.url, SOURCE_FIELD_MAX);
  const title = textField(item.title, SOURCE_FIELD_MAX);
  const snippet = textField(
    item.snippet !== undefined ? item.snippet
      : item.text !== undefined ? item.text
        : item.excerpt !== undefined ? item.excerpt
          : item.content,
    SOURCE_FIELD_MAX,
  );
  if (!url && !title && !snippet) return null;
  return { url, title, snippet };
}

function normalizeSources(list) {
  const out = [];
  for (const item of Array.isArray(list) ? list : []) {
    const source = normalizeSource(item);
    if (source) out.push(source);
  }
  return out;
}

/** 组装给模型的用户消息：目录名 + 已知上下文 + 每条来源的 title/snippet（最多 5 条，各截 300 字）。 */
function buildSummaryPrompt(input) {
  const lines = ["目录：" + (textField(input && input.relPath, 300) || "（未知）")];
  const children = (Array.isArray(input && input.childNames) ? input.childNames : [])
    .map((name) => textField(name, 40))
    .filter(Boolean)
    .slice(0, 12);
  const exts = (Array.isArray(input && input.extTop) ? input.extTop : [])
    .map((pair) => textField(Array.isArray(pair) ? pair[0] : pair, 12))
    .filter(Boolean)
    .slice(0, 8);
  if (children.length > 0) lines.push("已知子目录：" + children.join("、"));
  if (exts.length > 0) lines.push("已知文件类型：" + exts.join("、"));
  const sources = (Array.isArray(input && input.sources) ? input.sources : []).slice(0, LLM_SUMMARY_MAX_SOURCES);
  if (sources.length === 0) {
    lines.push("来源摘录：（本次没有取到可用的来源）");
  } else {
    lines.push("来源摘录：");
    sources.forEach((source, index) => {
      lines.push((index + 1) + ". " + (source.title || "（无标题）"));
      if (source.snippet) lines.push("   " + source.snippet.slice(0, LLM_SUMMARY_SNIPPET_CHARS));
    });
  }
  return lines.join("\n");
}

/** 收敛模型输出：去 markdown 围栏、去包裹引号、压空白、限长。 */
function cleanSummaryText(text) {
  let out = typeof text === "string" ? text.trim() : "";
  if (!out) return "";
  out = out.split("```").join(" ");
  out = out.replace(/^["'「『]+/, "").replace(/["'」』]+$/, "").trim();
  out = out.replace(/\s+/g, " ").trim();
  return out.slice(0, LLM_SUMMARY_MAX_CHARS);
}

/**
 * 调一次模型并累积 text-delta，返回纯文本。
 * 用 AbortController + Promise.race 做硬超时：provider 不理会 signal 也不会把请求挂死。
 */
async function streamModelText(llm, route, userText, timeoutMs) {
  const controller = typeof AbortController === "function" ? new AbortController() : null;
  let timer = null;
  const timeoutError = new Error("模型调用超时（" + timeoutMs + "ms）");
  const timeout = new Promise((resolve, reject) => {
    timer = setTimeout(() => {
      if (controller) {
        try {
          controller.abort();
        } catch (err) {
          // abort 失败不影响降级
        }
      }
      reject(timeoutError);
    }, Math.max(1, timeoutMs));
    if (timer && typeof timer.unref === "function") timer.unref();
  });
  const consume = (async () => {
    let text = "";
    let reasoning = "";
    const request = {
      provider: route.provider,
      model: route.model,
      messages: [{ role: "user", content: [{ type: "text", text: userText }] }],
      system: LLM_SUMMARY_SYSTEM,
      temperature: 0.2,
      maxTokens: LLM_SUMMARY_MAX_TOKENS,
    };
    if (controller) request.signal = controller.signal;
    for await (const chunk of llm.stream(request)) {
      if (!chunk || typeof chunk !== "object") continue;
      if (chunk.type === "text-delta" && typeof chunk.text === "string") text += chunk.text;
      else if (chunk.type === "reasoning-delta" && typeof chunk.text === "string") reasoning += chunk.text;
      else if (chunk.type === "finish") {
        const reason = chunk.reason && typeof chunk.reason === "object" ? chunk.reason : {};
        if (reason.kind === "error" || reason.kind === "aborted") {
          const detail = reason.failure && reason.failure.message ? reason.failure.message : String(reason.kind);
          throw new Error("模型调用失败：" + detail);
        }
      }
    }
    return text.trim() || reasoning.trim();
  })();
  // race 结束后 consume 仍可能再 reject：这里兜住，避免 unhandled rejection
  consume.catch(() => {});
  try {
    return await Promise.race([consume, timeout]);
  } finally {
    if (timer !== null) clearTimeout(timer);
    if (controller) {
      try {
        controller.abort();
      } catch (err) {
        // ignore
      }
    }
  }
}

/**
 * 候选路由（最多 3 条，按顺序尝试）：
 *   ① 上次成功的 ② deepseek-account/deepseek-flash（profile 默认）③ listProviders() 里第一个（配它的首个模型）
 *   listProviders() 只用来记录日志与兜底，不挑「非账号」provider——LLM 适配器走 credentials 解析，
 *   和 web 搜索的 currentInitiator 限制不一样。
 */
async function resolveLlmRoutes(ctx, state) {
  const llm = getService(ctx, "llm");
  if (!llm || typeof llm.stream !== "function") return { llm: null, routes: [] };
  const routes = [];
  const seen = new Set();
  const push = (provider, model) => {
    const p = textField(provider, 120);
    const m = textField(model, 120);
    if (!p || !m) return;
    const key = p + "/" + m;
    if (seen.has(key)) return;
    seen.add(key);
    routes.push({ provider: p, model: m });
  };
  if (state.llmRoute) push(state.llmRoute.provider, state.llmRoute.model);
  push(LLM_DEFAULT_PROVIDER, LLM_DEFAULT_MODEL);
  let providers = [];
  try {
    const list = typeof llm.listProviders === "function" ? llm.listProviders() : [];
    providers = Array.isArray(list) ? list : [];
  } catch (err) {
    providers = [];
  }
  const names = providers.map((item) => textField(item && (item.id || item.name), 80)).filter(Boolean);
  log(ctx, "info", "模型总结：llm 可用，providers = " + (names.join(", ") || "（空）"));
  if (providers.length > 0) {
    const first = providers[0] || {};
    const providerId = textField(first.id || first.name, 120);
    let modelId = "";
    try {
      const models = typeof llm.listModels === "function" ? await llm.listModels(providerId) : [];
      if (Array.isArray(models) && models.length > 0 && models[0]) modelId = textField(models[0].id || models[0].name, 120);
    } catch (err) {
      modelId = "";
    }
    push(providerId, modelId || LLM_DEFAULT_MODEL);
  }
  return { llm, routes: routes.slice(0, LLM_SUMMARY_MAX_ROUTES) };
}

/** 用模型产出一段中文总结；任何失败都返回 null（调用方据此 summaryMode="none"），绝不抛。 */
async function summarizeWithModel(ctx, state, config, input) {
  try {
    const resolved = await resolveLlmRoutes(ctx, state);
    if (!resolved.llm || resolved.routes.length === 0) return null;
    const prompt = buildSummaryPrompt(input);
    for (const route of resolved.routes) {
      try {
        const text = await streamModelText(resolved.llm, route, prompt, config.llmSummaryTimeoutMs);
        const cleaned = cleanSummaryText(text);
        if (cleaned) {
          state.llmRoute = route;
          return cleaned;
        }
      } catch (err) {
        log(ctx, "warn", "模型总结失败（" + route.provider + "/" + route.model + "）：" + (err && err.message ? err.message : String(err)));
      }
    }
    return null;
  } catch (err) {
    return null;
  }
}

/** 降级形态：把已构造好的查询串交回对话，前端据此显示「复制」而不是报错。 */
function copyPayload(payload, hint, reason) {
  return Object.assign(payload, {
    mode: "copy",
    needsCopy: true,
    needsConfirm: false,
    hint,
    reason: reason || null,
  });
}

/** 记住一次真实检索的结果，顺带刷新 /capabilities 的缓存（探针与真实调用互为佐证）。 */
function rememberCapability(state, mode, detail) {
  state.lookupCapability = { mode, detail, checkedAt: Date.now() };
}

/**
 * 用一次极小查询探测联网检索能力（maxResults=1、5s 超时），结果缓存 CAPABILITY_CACHE_MS，
 * 并发请求共用同一个在途探针。没有 ctx.web -> copy；命中凭据缺失 -> copy；成功 -> api；其它 -> unknown。
 */
async function probeLookupCapability(ctx, state, config) {
  const cached = state.lookupCapability;
  if (cached !== null && Date.now() - cached.checkedAt < CAPABILITY_CACHE_MS) {
    return { record: cached, cached: true };
  }
  if (state.capabilityPending === null) {
    state.capabilityPending = (async () => {
      const record = { mode: "unknown", detail: "", checkedAt: Date.now() };
      const researcher = makeResearcher(ctx, config);
      if (researcher === null) {
        record.mode = "copy";
        record.detail = "no-web";
      } else {
        try {
          await researcher(CAPABILITY_PROBE_QUERY, {
            maxResults: CAPABILITY_PROBE_MAX_RESULTS,
            timeoutMs: CAPABILITY_PROBE_TIMEOUT_MS,
          });
          record.mode = "api";
          record.detail = "probe-ok";
        } catch (err) {
          if (isCredentialMissing(err)) {
            record.mode = "copy";
            record.detail = "no-api-key";
          } else {
            record.detail = err && (err.code || err.name) ? String(err.code || err.name) : "probe-failed";
          }
        }
      }
      state.lookupCapability = record;
      return record;
    })().finally(() => {
      state.capabilityPending = null;
    });
  }
  return { record: await state.capabilityPending, cached: false };
}

function capabilitiesRoute(ctx, state, config) {
  return async (req, res) => {
    if (!requireMethod(req, res, "GET")) return;
    try {
      const probed = await probeLookupCapability(ctx, state, config);
      sendJson(res, 200, {
        ok: true,
        lookup: probed.record.mode,
        cached: probed.cached,
        checkedAt: new Date(probed.record.checkedAt).toISOString(),
        detail: probed.record.detail || null,
      });
    } catch (err) {
      fail(res, err);
    }
  };
}

function lookupRoute(ctx, state, config) {
  return async (req, res) => {
    if (!requireMethod(req, res, "POST")) return;
    try {
      const body = await readJsonBody(req);
      const relPath = String(body.relPath || "").trim();
      if (!relPath) {
        sendJson(res, 400, { ok: false, error: "缺少 relPath" });
        return;
      }
      await ensureScanned(ctx, state, config, false);
      const hit = findEntry(state, relPath, body.absPath);
      const entry = hit.entry;
      /** 上下文来源：descendant-context 时是二级子目录记录，其余情况就是条目本身。 */
      const context = hit.context || entry;
      const researcher = makeResearcher(ctx, config);
      // researcher 传 null 只为拿到 buildQuery 的查询串与基线字段：本阶段不落盘任何缓存
      const base = await lookup({
        relPath,
        absPath: entry ? entry.absPath : body.absPath,
        childNames: context ? context.childNames || [] : Array.isArray(body.childNames) ? body.childNames : [],
        extTop: context ? context.extTop || [] : Array.isArray(body.extTop) ? body.extTop : [],
        researcher: null,
        cache: { force: true },
      });
      const payload = {
        ok: true,
        relPath: base.relPath,
        query: base.query,
        safety: SAFETY,
        confidence: CONFIDENCE,
        label: LABEL,
        disclaimer: DISCLAIMER,
        matched: Boolean(entry),
        matchedBy: hit.matchedBy,
        // descendant-context 时说明上下文取自哪条二级记录（体检/排查用；其余情况为 null）
        context: hit.context
          ? { name: hit.context.name, bytes: hit.context.bytes || 0, files: hit.context.files || 0 }
          : null,
        cached: false,
        result: null,
        reason: null,
        needsConfirm: false,
        /** api=真的联网检索过；copy=没有凭据，只能把查询串交回对话；unknown=还没试。 */
        mode: "unknown",
      };
      if (researcher === null) {
        sendJson(res, 200, copyPayload(payload, LOOKUP_COPY_HINT_NO_WEB, REASON_NO_RESEARCHER));
        return;
      }
      if (body.confirm !== true) {
        sendJson(res, 200, Object.assign(payload, { reason: REASON_NEEDS_CONFIRM, needsConfirm: true }));
        return;
      }
      let raw = null;
      try {
        raw = await researcher(base.query);
      } catch (err) {
        // 没配 API key 不算失败：账号模式在 HTTP 路由里永远用不上，只能降级成「把查询串交回对话」
        if (isCredentialMissing(err)) {
          rememberCapability(state, "copy", "lookup-no-key");
          sendJson(res, 200, copyPayload(payload, LOOKUP_COPY_HINT, null));
          return;
        }
        sendJson(res, 200, Object.assign(payload, {
          reason: searchErrorReason(err),
          errorCode: err && err.code ? String(err.code) : null,
        }));
        return;
      }
      rememberCapability(state, "api", "lookup-ok");
      const sources = normalizeSources(raw && raw.sources);
      // normalizeResult 只收 url 字符串（sources 里放对象会被 String() 掉），所以先只喂 url，
      // 再把富来源（url/title/snippet）覆盖回去。
      const normalized = normalizeResult({
        summary: raw && typeof raw.summary === "string" ? raw.summary : "",
        sources: sources.map((item) => item.url).filter(Boolean),
      }) || (sources.length > 0
        ? { kind: "模型归纳", verified: false, summary: "", sources: [], facts: [], disclaimer: DISCLAIMER }
        : null);
      if (normalized === null) {
        sendJson(res, 200, Object.assign(payload, { mode: "api", reason: REASON_EMPTY }));
        return;
      }
      let summary = String(normalized.summary || "").trim();
      let summaryMode = summary ? "provider" : "none";
      if (!summary) {
        // provider 没给归纳时，把来源摘录交给模型做一段中文总结；失败就保持 none，绝不 500
        const generated = await summarizeWithModel(ctx, state, config, {
          relPath: base.relPath,
          childNames: context ? context.childNames || [] : [],
          extTop: context ? context.extTop || [] : [],
          sources,
        });
        if (generated) {
          summary = generated;
          summaryMode = "model";
        }
      }
      sendJson(res, 200, Object.assign(payload, {
        mode: "api",
        summaryMode,
        result: Object.assign({}, normalized, { summary, summaryMode, sources }),
      }));
    } catch (err) {
      fail(res, err);
    }
  };
}

/**
 * 照抄 @deepseek-ai/dsh-native-command 的 explorerTarget()：explorer 自己再解析一遍命令行，
 * 会在逗号和等号处断字段，所以只转义这两个；但 explorer 不认百分号转义的非 ASCII（会退回文档目录），
 * 故把非 ASCII 的百分号转义还原成字面字符，ASCII 转义保留。
 */
function explorerTarget(windowsPath) {
  return pathToFileURL(windowsPath, { windows: true })
    .href.replace(/(?:%[89A-F][0-9A-F])+/gi, (escaped) => decodeURIComponent(escaped))
    .replaceAll(",", "%2C")
    .replaceAll("=", "%3D");
}

function isAbsoluteWindowsPath(value) {
  return typeof value === "string" && (/^[a-zA-Z]:[\\/]/.test(value) || value.startsWith("\\\\"));
}

/** 含 .. 的段。必须在 normalize/resolve 之前判原文，否则 .. 会被吃掉。 */
function hasParentSegment(value) {
  for (const part of String(value === null || value === undefined ? "" : value).split(/[\\/]+/)) {
    if (part.trim() === "..") return true;
  }
  return false;
}

/** absPath 相对根的部分（无前导分隔符）；absPath 就是根时返回 ""。 */
function relFromRoot(rootAbs, absPath) {
  const outer = String(rootAbs || "").replace(/[\\/]+$/, "");
  const text = String(absPath || "").replace(/[\\/]+$/, "");
  if (text.length <= outer.length) return "";
  return text.slice(outer.length + 1);
}

/**
 * AppData 围墙内的路径校验：/tree 的相对 path 与 /reveal 的绝对路径共用这一套。
 * 依次过：字符串/非空/NUL -> 带盘符的绝对路径 -> 原文含 .. -> normalize 后必须严格在
 * AppData 之下（前缀比较带分隔符，C:\x\AppData2 不算 AppData）-> realpath 之后仍在前缀之内
 * （挡 junction / 符号链接逃逸）-> 必须是已存在的目录。
 * 任何一关不过都返回 { status, error }，调用方不得继续（/reveal 尤其不能走到 spawn）。
 */
async function inspectAppDataPath(state, config, rawAbsPath) {
  const rootAbs = appDataRoot(config);
  if (!state.rootReal) state.rootReal = await realpath(rootAbs).catch(() => rootAbs);
  if (typeof rawAbsPath !== "string") return { status: 400, error: "path 必须是字符串" };
  const text = rawAbsPath.trim();
  if (!text) return { status: 400, error: "path 不能为空" };
  if (text.indexOf("\u0000") >= 0) return { status: 400, error: "path 含非法字符" };
  if (!isAbsoluteWindowsPath(text)) return { status: 400, error: "path 必须是带盘符的绝对路径：" + text };
  if (hasParentSegment(text)) return { status: 400, error: "path 不允许包含 ..：" + text };
  const absPath = normalize(text);
  if (!isUnderTree(rootAbs, absPath)) return { status: 400, error: "path 不在 AppData 之下：" + absPath };
  const real = await realpath(absPath).catch(() => null);
  if (real === null) return { status: 400, error: "目录不存在：" + absPath };
  if (!isUnderTree(state.rootReal, real)) {
    return { status: 400, error: "path 解析后指向 AppData 之外（符号链接/目录联接）：" + real };
  }
  let info;
  try {
    info = await stat(real);
  } catch (err) {
    return { status: 400, error: "无法访问：" + absPath };
  }
  if (!info.isDirectory()) return { status: 400, error: "path 不是目录：" + absPath };
  return { rootAbs, absPath, rel: relFromRoot(rootAbs, absPath) };
}

/**
 * /reveal 的两种入参形态 -> 一个候选绝对路径（校验仍交给 inspectAppDataPath）：
 *   1. { absPath }                                  —— 行数据里就有 absPath
 *   2. { root, relPath }，root 为 AppData 绝对路径   —— 当前 client 发的形态（path.resolve(root, relPath)）
 *   3. { root, relPath }，root 为 local/roaming/locallow —— 旧形态，映射到 <AppData>\<根目录名>
 */
function revealCandidate(config, body) {
  const source = body && typeof body === "object" ? body : {};
  const absInput = typeof source.absPath === "string" ? source.absPath.trim() : "";
  if (absInput) {
    if (hasParentSegment(absInput)) return { status: 400, error: "absPath 不允许包含 ..：" + absInput };
    return { candidate: absInput };
  }
  const rootInput = typeof source.root === "string" ? source.root.trim() : "";
  const relInput = typeof source.relPath === "string" ? source.relPath.trim() : "";
  if (!rootInput || !relInput) return { status: 400, error: "缺少 absPath，或缺少 root + relPath" };
  if (hasParentSegment(relInput) || hasParentSegment(rootInput)) {
    return { status: 400, error: "relPath 不允许包含 ..：" + relInput };
  }
  if (isAbsoluteWindowsPath(rootInput)) return { candidate: resolve(rootInput, relInput) };
  const rootName = rootInput.toLowerCase();
  const roots = defaultRoots(config.homeDir);
  if (ROOT_NAMES.indexOf(rootName) < 0 || !roots[rootName]) {
    return { status: 400, error: "root 既不是绝对路径，也不是 local/roaming/locallow：" + rootInput };
  }
  return { candidate: resolve(roots[rootName], relInput) };
}

/**
 * 在资源管理器里选中一个目录。
 *
 * 为什么不用 ctx.subprocess：Windows 上 dsh-subprocess-local 的 launchWindowsJob 会把命令交给
 * 一个受限令牌的 runner 去跑（spawn(runner, ["--", ...argv])）。本机这条路径上的子进程会以
 * 0xC0000142 (STATUS_DLL_INIT_FAILED) 直接死掉，所以 explorer 从来没真正启动过——而旧代码把
 * “拿不到 done / 超时 / 形状不认识”统统当成成功，于是前端只看到对勾。
 *
 * 插件宿主运行在 Electron 主进程内、不受工作区沙箱约束（见 dsh-plugin-manager README：
 * "installed Host code executes in-process outside the workspace sandbox"），因此这里直接用
 * node:child_process 启动，并且**只在退出码为 0 或 1 时才算成功**：
 * explorer 的退出码 1 表示「请求已转交给正在运行的桌面进程」，官方注释明确说明属成功。
 */
function revealInExplorer(absPath) {
  if (process.platform !== "win32") {
    return Promise.resolve({ ok: false, status: 501, error: "「在资源管理器中打开」目前仅支持 Windows" });
  }
  const argv = [EXPLORER, "/select," + explorerTarget(absPath)];
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(argv[0], argv.slice(1), { detached: true, stdio: "ignore", windowsHide: false });
    } catch (err) {
      resolve({ ok: false, status: 500, error: EXPLORER + " 启动失败：" + (err && err.message ? err.message : String(err)) });
      return;
    }
    let settled = false;
    let timer = null;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      if (timer !== null) clearTimeout(timer);
      resolve(value);
    };
    timer = setTimeout(() => {
      finish({ ok: false, status: 500, error: EXPLORER + " 在 " + REVEAL_WAIT_MS + "ms 内没有退出，可能未生效（argv=" + argv[1] + "）" });
    }, REVEAL_WAIT_MS);
    if (timer && typeof timer.unref === "function") timer.unref();
    child.once("error", (err) => {
      finish({ ok: false, status: 500, error: EXPLORER + " 启动失败：" + (err && err.message ? err.message : String(err)) });
    });
    child.once("exit", (code, signal) => {
      if (code !== null && REVEAL_EXIT_OK.indexOf(code) >= 0) {
        finish({ ok: true });
        return;
      }
      finish({ ok: false, status: 500, error: EXPLORER + " 退出异常：code=" + code + " signal=" + signal + " argv=" + argv[1] });
    });
    try {
      child.unref();
    } catch (err) {
      /* unref 失败不影响结果判定 */
    }
  });
}

function revealRoute(state, config) {
  return async (req, res) => {
    if (!requireMethod(req, res, "POST")) return;
    let body;
    try {
      body = await readJsonBody(req);
    } catch (err) {
      sendJson(res, 400, { ok: false, error: err && err.message ? err.message : String(err) });
      return;
    }
    // 安全边界从「只能打开扫描过的条目」放宽到「只能打开 AppData 之内的已存在目录」：
    // 树形视图可以展开任意层，条目集合不再可枚举，所以围墙落在 AppData 这一层。
    // 校验不过一律 400 且直接返回——绝不走到 spawn。
    let candidate;
    let target;
    try {
      candidate = revealCandidate(config, body);
      if (!candidate.status) target = await inspectAppDataPath(state, config, candidate.candidate);
    } catch (err) {
      fail(res, err);
      return;
    }
    if (candidate.status) {
      sendJson(res, candidate.status, { ok: false, error: candidate.error });
      return;
    }
    if (target.status) {
      sendJson(res, target.status, { ok: false, error: target.error });
      return;
    }
    const outcome = await revealInExplorer(target.absPath);
    if (!outcome.ok) {
      sendJson(res, outcome.status || 500, { ok: false, error: outcome.error });
      return;
    }
    sendJson(res, 200, { ok: true, absPath: target.absPath });
  };
}

// ---------------------------------------------------------------------------------------------
// 阶段二.五：树形目录（GET /tree）
// ---------------------------------------------------------------------------------------------
// 契约：只返回目录（任何文件都不出现在 entries 里）；path 相对 AppData 根；
// 服务端排序；按需统计 + 内存缓存（键 = 绝对路径）；单目录与整次请求都有时间预算，
// 超时返回已统计到的部分并标 truncated。统计复用 src/scanner.mjs 的 scanDirectory
// （与六条既有路由同一个递归 walker），不另写一套遍历。
// 每次请求先 await ensureScanned()：state.pending 把并发调用合并成一次扫描，
// 扫完之后一级目录的递归体积直接来自扫描文档（精确，也不会因 5s 单目录预算而偏小）。

/** AppData 根由 defaultRoots() 的 Local 反推，保证与既有路由看的是同一个 C:\Users\<user>\AppData。 */
function appDataRoot(config) {
  return dirname(defaultRoots(config.homeDir).local);
}

function treeKey(absPath) {
  return String(absPath === null || absPath === undefined ? "" : absPath).toLowerCase();
}

/** child 是否就是 parent 本身或在其之下（Windows 语义：忽略大小写与尾部分隔符）。 */
function isUnderTree(parent, child) {
  const outer = String(parent || "").replace(/[\\/]+$/, "").toLowerCase();
  const inner = String(child || "").replace(/[\\/]+$/, "").toLowerCase();
  if (!outer || !inner) return false;
  return inner === outer || inner.startsWith(outer + "\\");
}

/**
 * 把 "Local\Microsoft" 切成段。只接受「段的拼接」：
 * 盘符、UNC、前导分隔符、任何 ".."、Windows 非法字符一律拒绝，返回 { error }。
 */
function treePathSegments(raw) {
  const text = typeof raw === "string" ? raw.trim() : "";
  if (!text) return { segments: [] };
  if (text.indexOf("\u0000") >= 0) return { error: "path 含非法字符" };
  if (/^[a-zA-Z]:/.test(text)) return { error: "path 不能带盘符：" + text };
  if (text.startsWith("\\\\") || text.startsWith("//")) return { error: "path 不能是 UNC 路径：" + text };
  if (text.startsWith("\\") || text.startsWith("/")) return { error: "path 必须是相对 AppData 的路径：" + text };
  const segments = [];
  for (const part of text.split(/[\\/]+/)) {
    const name = part.trim();
    if (!name || name === ".") continue;
    if (name === "..") return { error: "path 不允许包含 ..：" + text };
    if (name.indexOf(":") >= 0) return { error: "path 段不能包含冒号（盘符/数据流）：" + name };
    if (/[<>"|?*]/.test(name)) return { error: "path 段含 Windows 非法字符：" + name };
    segments.push(name);
  }
  return { segments };
}

/**
 * 把 path 拼成绝对路径，然后交给与 /reveal 共用的 inspectAppDataPath 校验
 * （AppData 围墙、junction 逃逸、必须是已存在的目录；不合格一律 400）。
 */
async function resolveTreeTarget(state, config, rawPath) {
  // 相对路径先按段校验（拒绝盘符/UNC/..），拼成绝对路径后与 /reveal 走同一个 inspectAppDataPath
  const parsed = treePathSegments(rawPath);
  if (parsed.error) return { status: 400, error: parsed.error };
  const rootAbs = appDataRoot(config);
  const absPath = parsed.segments.length === 0 ? resolve(rootAbs) : resolve(rootAbs, ...parsed.segments);
  return await inspectAppDataPath(state, config, absPath);
}

function treeCachePut(state, config, absPath, record) {
  const cache = state.treeCache;
  const key = treeKey(absPath);
  if (!cache.has(key) && cache.size >= TREE_CACHE_MAX) {
    // Map 保持插入顺序：超限就淘汰最早写入的一条，够用且不会无限增长
    const oldest = cache.keys().next();
    if (!oldest.done) cache.delete(oldest.value);
  }
  cache.set(key, record);
}

/**
 * 扫描文档里的一级目录记录 -> 缓存记录（/scan 跑过之后直接当热缓存用）。
 * dirs 的语义：scanDirectory 每成功 readdir 一个目录就 total.dirs += 1，**起点就是该目录自身**，
 * 所以 entry.dirs 含自身；树形目录对外要求「后代目录数，不含自身」，这里统一减 1。
 */
function recordFromEntry(entry) {
  const childNames = Array.isArray(entry.childNames) ? entry.childNames.length : 0;
  const children = Array.isArray(entry.children) ? entry.children.length : 0;
  return {
    bytes: entry.bytes || 0,
    files: entry.files || 0,
    dirs: Math.max(0, (entry.dirs || 0) - 1),
    newestMtime: entry.newestMtime || null,
    hasChildren: childNames > 0 || children > 0,
    truncated: Boolean(entry.truncated),
    truncatedReason: entry.truncatedReason || null,
    source: "scan",
    computedAt: Date.now(),
  };
}

/** 把已完成的扫描结果塞进树缓存（只补缺，不覆盖已算过的键）。 */
function seedTreeCache(state, config) {
  const entries = state.doc && Array.isArray(state.doc.entries) ? state.doc.entries : [];
  let seeded = 0;
  for (const entry of entries) {
    if (!entry || !isAbsoluteWindowsPath(entry.absPath)) continue;
    if (state.treeCache.has(treeKey(entry.absPath))) continue;
    treeCachePut(state, config, entry.absPath, recordFromEntry(entry));
    seeded += 1;
  }
  return seeded;
}

/** 统计某个目录的直接文件（递归部分由 scanDirectory 或子目录聚合负责）。 */
async function statDirectFiles(dirAbs, names, concurrency) {
  const acc = { bytes: 0, files: 0, newest: 0, errors: 0 };
  for (let i = 0; i < names.length; i += concurrency) {
    const chunk = names.slice(i, i + concurrency);
    const stats = await Promise.all(chunk.map((name) => stat(join(dirAbs, name)).catch(() => null)));
    for (const st of stats) {
      if (!st || !st.isFile()) {
        acc.errors += 1;
        continue;
      }
      acc.bytes += st.size || 0;
      acc.files += 1;
      const mtime = typeof st.mtimeMs === "number" ? st.mtimeMs : st.mtime ? st.mtime.getTime() : 0;
      if (mtime > acc.newest) acc.newest = mtime;
    }
  }
  return acc;
}

function partialRecord(reason) {
  // 预算用尽：没有统计到任何东西。dirs 记 0（不是「空目录」），并标 truncated 让调用方知道数字不可信
  return {
    bytes: 0,
    files: 0,
    dirs: 0,
    newestMtime: null,
    hasChildren: false,
    truncated: true,
    truncatedReason: reason,
    source: "skipped",
    computedAt: Date.now(),
  };
}

/**
 * 统计一个目录（递归）：先看缓存；子目录全在缓存里就直接聚合；否则交给 scanDirectory 走一遍。
 * 结果按绝对路径进缓存。截断的结果不缓存（避免把偏小的 partial 数字钉死，下次还能算全）。
 */
async function computeDirRecord(state, config, absPath, deadline) {
  if (deadline && Date.now() >= deadline) return partialRecord("budget");
  let dirents;
  try {
    dirents = await readdir(absPath, { withFileTypes: true });
  } catch (err) {
    const code = err && err.code ? err.code : "ERROR";
    const record = partialRecord("readdir:" + code);
    treeCachePut(state, config, absPath, record);
    return record;
  }
  const subdirs = [];
  const files = [];
  for (const dirent of dirents) {
    if (dirent.isSymbolicLink()) continue;
    if (dirent.isDirectory()) subdirs.push(dirent.name);
    else if (dirent.isFile()) files.push(dirent.name);
  }

  if (subdirs.length === 0) {
    const direct = await statDirectFiles(absPath, files, TREE_STAT_CONCURRENCY);
    const record = {
      bytes: direct.bytes,
      files: direct.files,
      dirs: 0,
      newestMtime: direct.newest || null,
      hasChildren: false,
      truncated: false,
      truncatedReason: null,
      source: "leaf",
      computedAt: Date.now(),
    };
    treeCachePut(state, config, absPath, record);
    return record;
  }

  const childRecords = [];
  for (const name of subdirs) {
    const cached = state.treeCache.get(treeKey(join(absPath, name)));
    if (!cached) {
      childRecords.length = 0;
      break;
    }
    childRecords.push(cached);
  }
  if (childRecords.length === subdirs.length) {
    const direct = await statDirectFiles(absPath, files, TREE_STAT_CONCURRENCY);
    const record = {
      bytes: direct.bytes,
      files: direct.files,
      dirs: 0,
      newestMtime: direct.newest || null,
      hasChildren: true,
      truncated: false,
      truncatedReason: null,
      source: "aggregate",
      computedAt: Date.now(),
    };
    for (const child of childRecords) {
      record.bytes += child.bytes || 0;
      record.files += child.files || 0;
      // 后代目录数 = 每个子目录自身(1) + 它的后代数
      record.dirs += 1 + (child.dirs || 0);
      if ((child.newestMtime || 0) > (record.newestMtime || 0)) record.newestMtime = child.newestMtime;
      if (child.truncated) {
        record.truncated = true;
        if (!record.truncatedReason) record.truncatedReason = "child-truncated";
      }
    }
    treeCachePut(state, config, absPath, record);
    return record;
  }

  const startedAt = Date.now();
  const limits = Object.assign({}, LIMITS, { dirMs: config.treeDirMs });
  const budget = Math.min(deadline || Number.MAX_SAFE_INTEGER, startedAt + config.treeDirMs);
  // 复用扫描器的递归 walker：同一个实现同时给出 bytes/files/dirs/newestMtime/truncated
  const entry = await scanDirectory("appdata", absPath, { limits, deadline: budget });
  const record = Object.assign(recordFromEntry(entry), { source: "scan", computedAt: Date.now() });
  if (!record.truncated) treeCachePut(state, config, absPath, record);
  return record;
}

async function describeDir(state, config, absPath, deadline) {
  const key = treeKey(absPath);
  const cached = state.treeCache.get(key);
  if (cached) return { record: cached, cached: true };
  const inflight = state.treePending.get(key);
  if (inflight) return { record: await inflight, cached: true };
  const task = computeDirRecord(state, config, absPath, deadline);
  state.treePending.set(key, task);
  try {
    return { record: await task, cached: false };
  } finally {
    state.treePending.delete(key);
  }
}

/** 简单的并发上限 map（顺序与入参一致）。 */
async function mapLimited(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  const width = Math.max(1, Math.min(limit, items.length));
  const runners = [];
  for (let i = 0; i < width; i += 1) {
    runners.push((async () => {
      for (;;) {
        const index = next;
        next += 1;
        if (index >= items.length) return;
        results[index] = await worker(items[index], index);
      }
    })());
  }
  await Promise.all(runners);
  return results;
}

/**
 * AppData 顶层的 4 个根在知识库里没有条目（知识库的 root 是「它们下面的内容」），
 * 但树的第一层恰恰就是它们：不给判定的话 client 会把「Local」标成未证实、还配一个毫无意义的「❓ 查一下」。
 * 所以硬编码一份，字段形状与知识库命中完全一致。
 */
const TREE_ROOT_JUDGEMENTS = Object.freeze({
  local: {
    safety: "mixed",
    owner: "Windows（AppData 根目录）",
    category: "system",
    purpose: "用户级应用数据根目录，包含所有程序的缓存与配置；具体可删项在子目录里",
    confidence: "high",
    matchedBy: "knowledge",
  },
  roaming: {
    safety: "mixed",
    owner: "Windows（AppData 根目录）",
    category: "system",
    purpose: "用户级应用数据根目录，包含所有程序的缓存与配置；具体可删项在子目录里",
    confidence: "high",
    matchedBy: "knowledge",
  },
  locallow: {
    safety: "mixed",
    owner: "Windows（AppData 根目录）",
    category: "system",
    purpose: "用户级应用数据根目录，包含所有程序的缓存与配置；具体可删项在子目录里",
    confidence: "high",
    matchedBy: "knowledge",
  },
  "flash player": {
    safety: "safe",
    owner: "Adobe Flash Player（已停止支持）",
    category: "appdata-root",
    purpose: "已废弃的 Flash Player 数据目录，本机为空",
    confidence: "high",
    matchedBy: "knowledge",
  },
});

/** 知识库加载（tree 不跑整盘扫描，但要能补 safety/owner/purpose）；失败按空知识库降级。 */
async function ensureKnowledge(state, config) {
  if (state.knowledge !== null) return state.knowledge;
  if (state.knowledgePending === null) {
    state.knowledgePending = loadKnowledge(config.knowledgeDir, {})
      .then((knowledge) => {
        state.knowledge = knowledge;
        return knowledge;
      })
      .catch(() => {
        const degraded = { dir: config.knowledgeDir, entries: [], files: [], problems: [], degraded: true };
        state.knowledge = degraded;
        return degraded;
      })
      .finally(() => {
        state.knowledgePending = null;
      });
  }
  return await state.knowledgePending;
}

/**
 * 知识库命中就给 safety/owner/purpose/matchedBy/confidence（命中不到一个字段都不给）。
 * 匹配口径与 classifyEntry 一致：root 取第一段（local/roaming/locallow），相对根的路径走 suffix 匹配。
 */
function treeKnowledgeFields(knowledge, relPath) {
  const segments = String(relPath || "").split("\\");
  const rootName = String(segments[0] || "").toLowerCase();
  if (ROOT_NAMES.indexOf(rootName) < 0) return null;
  const relToRoot = segments.slice(1).join("\\");
  if (!relToRoot) return null;
  const hit = matchEntry(knowledge, rootName, relToRoot, { suffix: true });
  if (!hit || !hit.entry) return null;
  const entry = hit.entry;
  return {
    safety: entry.safety,
    owner: entry.owner,
    purpose: entry.purpose,
    matchedBy: "knowledge",
    confidence: entry.confidence,
    category: entry.category,
  };
}

/** 排序在服务端做：name|size|date × asc|desc，同名兜底按名称升序（保证输出稳定）。 */
function treeComparator(sort, dir) {
  const factor = dir === "desc" ? -1 : 1;
  return (a, b) => {
    let primary;
    if (sort === "size") primary = (a.bytes || 0) - (b.bytes || 0);
    else if (sort === "date") primary = (a.newestMtime || 0) - (b.newestMtime || 0);
    else primary = String(a.name).localeCompare(String(b.name));
    if (primary !== 0) return primary * factor;
    return String(a.name).localeCompare(String(b.name));
  };
}

function treeRoute(ctx, state, config) {
  return async (req, res) => {
    if (!requireMethod(req, res, "GET")) return;
    const startedAt = Date.now();
    try {
      const params = requestUrl(req).searchParams;
      const sortRaw = String(params.get("sort") || "").trim().toLowerCase();
      const dirRaw = String(params.get("dir") || "").trim().toLowerCase();
      if (sortRaw && TREE_SORTS.indexOf(sortRaw) < 0) {
        sendJson(res, 400, { ok: false, error: "sort 只能是 name/size/date（收到 " + sortRaw + "）" });
        return;
      }
      if (dirRaw && TREE_DIRS.indexOf(dirRaw) < 0) {
        sendJson(res, 400, { ok: false, error: "dir 只能是 asc/desc（收到 " + dirRaw + "）" });
        return;
      }
      const sort = sortRaw || "name";
      const dir = dirRaw || "asc";

      const target = await resolveTreeTarget(state, config, params.get("path"));
      if (target.status) {
        sendJson(res, target.status, { ok: false, error: target.error });
        return;
      }

      // 先保证扫描文档就绪（并发调用由 state.pending 合并成一次扫描）：否则一级目录只能现场 walk，
      // 2GB 级目录会在 5s 预算下被截断，体积偏小、且两次调用给出的数字还不一样。
      // 放在路径校验之后：非法 path 仍然立刻 400，不用等扫描。
      await ensureScanned(ctx, state, config, false);
      const seeded = seedTreeCache(state, config);
      const knowledge = await ensureKnowledge(state, config);

      const dirents = await readdir(target.absPath, { withFileTypes: true });
      const children = [];
      let filesSkipped = 0;
      let linksSkipped = 0;
      for (const dirent of dirents) {
        if (dirent.isSymbolicLink()) {
          linksSkipped += 1;
          continue;
        }
        if (!dirent.isDirectory()) {
          filesSkipped += 1;
          continue;
        }
        children.push({ name: dirent.name, absPath: join(target.absPath, dirent.name) });
      }

      // 预算从「扫描就绪之后」起算：一次完整扫描 ~19s，若把预算起点放在请求开头，
      // 首次请求的 20s 预算会被扫描吃光，未经缓存的一级目录（Local/Roaming/LocalLow）就只剩 truncated 占位。
      const deadline = Date.now() + config.treeBudgetMs;
      const described = await mapLimited(children, TREE_FANOUT, (child) =>
        describeDir(state, config, child.absPath, deadline));

      let cacheHits = 0;
      const entries = children.map((child, index) => {
        const record = described[index].record;
        if (described[index].cached) cacheHits += 1;
        const relPath = target.rel ? target.rel + "\\" + child.name : child.name;
        const out = {
          name: child.name,
          relPath,
          absPath: child.absPath,
          bytes: record.bytes || 0,
          files: record.files || 0,
          dirs: record.dirs || 0,
          newestMtime: record.newestMtime || null,
          hasChildren: Boolean(record.hasChildren),
          truncated: Boolean(record.truncated),
        };
        if (record.truncatedReason) out.truncatedReason = record.truncatedReason;
        // 顶上 4 个根没有知识库条目，用硬编码判定兜底；其余层只认知识库
        const fields = treeKnowledgeFields(knowledge, relPath)
          || (target.rel === "" ? TREE_ROOT_JUDGEMENTS[child.name.toLowerCase()] : null);
        if (fields) Object.assign(out, fields);
        return out;
      });
      entries.sort(treeComparator(sort, dir));

      sendJson(res, 200, {
        ok: true,
        root: target.rootAbs,
        path: target.rel,
        absPath: target.absPath,
        sort,
        dir,
        total: entries.length,
        truncated: entries.some((entry) => entry.truncated),
        stats: {
          dirs: entries.length,
          filesSkipped,
          linksSkipped,
          cacheHits,
          cacheMisses: entries.length - cacheHits,
          seeded,
          dirBudgetMs: config.treeDirMs,
          budgetMs: config.treeBudgetMs,
          cacheSize: state.treeCache.size,
          elapsedMs: Date.now() - startedAt,
        },
        entries,
      });
    } catch (err) {
      fail(res, err);
    }
  };
}

/** 八条路由；全是 exact 路径，查询串与请求体由各 handler 自己解析。 */
export function makeRoutes(ctx, state, config) {
  return [
    { kind: "exact", path: API + "/summary", handler: summaryRoute(ctx, state, config) },
    { kind: "exact", path: API + "/entries", handler: entriesRoute(ctx, state, config) },
    { kind: "exact", path: API + "/plan", handler: planRoute(ctx, state, config) },
    { kind: "exact", path: API + "/scan", handler: scanRoute(ctx, state, config) },
    { kind: "exact", path: API + "/lookup", handler: lookupRoute(ctx, state, config) },
    { kind: "exact", path: API + "/reveal", handler: revealRoute(state, config) },
    { kind: "exact", path: API + "/tree", handler: treeRoute(ctx, state, config) },
    { kind: "exact", path: API + "/capabilities", handler: capabilitiesRoute(ctx, state, config) },
  ];
}

export function apply(ctx, config) {
  const options = normalizeConfig(config);
  const state = createState();
  const routes = makeRoutes(ctx, state, options);
  ctx.effect(() => {
    const disposers = routes.map((route) => ctx.webServer.register(route));
    return () => {
      for (const dispose of disposers) dispose();
    };
  }, "appdata-scanner: routes");
  log(ctx, "info", "已注册 " + routes.length + " 条路由：" + routes.map((route) => route.path).join(", "));
}
