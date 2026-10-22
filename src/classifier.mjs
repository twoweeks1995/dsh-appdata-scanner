// src/classifier.mjs —— 判定：知识库命中 -> mixed 拆 children -> 启发式 -> 推测
// 判定优先级严格按 SPEC.md 第 59~68 行实现，不得调整顺序。
import { matchEntry, matchRule } from "./knowledge.mjs";
import { extOf } from "./scanner.mjs";

export const SAFETY_RANK = { safe: 0, mixed: 1, never: 2 };

const CACHE_NAME_RE = /cache|caches|gpucache|code cache|shadercache|inetcache|temp|tmp/i;
const LOG_EXT_RE = /^logs?$/;
const UPDATER_FILE_RE = /\.(exe|msi)$/i;
const DB_NAME_RE = /\.(db|db3|sqlite|sqlite3|ldb|mdb|sdf|accdb)$/i;

export const DB_EXTENSIONS = new Set([
  "db",
  "db3",
  "sqlite",
  "sqlite3",
  "ldb",
  "mdb",
  "sdf",
  "accdb",
  "dbf",
]);

/** 启发式规则 3 的门槛：根下 1~3 个安装包且均大于 50MB。 */
export const UPDATER_MIN_BYTES = 50 * 1024 * 1024;

/** 单个混合目录最多展开多少个子项（超出只在报告里提示）。 */
export const MAX_SPLIT_ITEMS = 120;

export const SAFETY_LABELS = { safe: "可安全删除", mixed: "需拆分确认", never: "不可删除" };

export function safetyLabel(safety) {
  return SAFETY_LABELS[safety] || "未知";
}

export function compareJudgements(a, b) {
  const rankA = SAFETY_RANK[a.safety] !== undefined ? SAFETY_RANK[a.safety] : 3;
  const rankB = SAFETY_RANK[b.safety] !== undefined ? SAFETY_RANK[b.safety] : 3;
  if (rankA !== rankB) return rankA - rankB;
  if ((b.bytes || 0) !== (a.bytes || 0)) return (b.bytes || 0) - (a.bytes || 0);
  return String(a.relPath || a.name || "").localeCompare(String(b.relPath || b.name || ""));
}

function verdict(fields) {
  return {
    safety: fields.safety,
    category: fields.category || "unknown",
    confidence: fields.confidence || "low",
    owner: fields.owner || "未知",
    purpose: fields.purpose || "",
    ifDeleted: fields.ifDeleted || "未知",
    evidence: fields.evidence || "",
    matchedBy: fields.matchedBy || "heuristic",
    basis: fields.basis || "",
    rule: fields.rule || null,
    notes: fields.notes || [],
    needsReview: Boolean(fields.needsReview),
    childRules: fields.childRules || [],
  };
}

/** 把一条扫描结果转成判定单元（dir）。 */
export function entryUnit(entry) {
  return {
    kind: "dir",
    name: entry.relPath || "",
    relPath: entry.relPath || "",
    exts: Array.isArray(entry.exts) ? entry.exts : [],
    logFiles: entry.logFiles || 0,
    levelDb: Boolean(entry.levelDb),
    childNames: Array.isArray(entry.childNames) ? entry.childNames : [],
    rootFiles: Array.isArray(entry.rootFiles) ? entry.rootFiles : [],
    bytes: entry.bytes || 0,
    files: entry.files || 0,
  };
}

/**
 * 一级目录下可参与拆分的路径：
 *   第 1 层子目录 + 根下散落文件（真实统计）
 *   第 2~4 层后代（来自 scanner 的 descendants，只在匹配到知识库规则时才输出）
 */
export function childUnits(entry) {
  const parentRel = entry.relPath || "";
  const parentAbs = entry.absPath || "";
  const toRoot = (rel) => (parentRel ? parentRel + "\\" + rel : rel);
  const toAbs = (rel) => (parentAbs ? parentAbs + "\\" + rel : rel);
  const units = [];

  for (const child of entry.children || []) {
    units.push({
      kind: "dir",
      depth: 1,
      name: child.name,
      relPathFromParent: child.name,
      relPathFromRoot: toRoot(child.name),
      absPath: toAbs(child.name),
      exts: Array.isArray(child.exts) ? child.exts : [],
      logFiles: child.logFiles || 0,
      levelDb: Boolean(child.levelDb),
      childNames: Array.isArray(child.childNames) ? child.childNames : [],
      rootFiles: Array.isArray(child.rootFiles) ? child.rootFiles : [],
      bytes: child.bytes || 0,
      files: child.files || 0,
      newestMtime: child.newestMtime || null,
      oldestMtime: child.oldestMtime || null,
    });
  }
  for (const file of entry.rootFiles || []) {
    const name = file.name;
    const ext = extOf(name);
    units.push({
      kind: "file",
      depth: 1,
      name,
      relPathFromParent: name,
      relPathFromRoot: toRoot(name),
      absPath: toAbs(name),
      exts: ext ? [ext] : [],
      logFiles: ext === "log" ? 1 : 0,
      levelDb: false,
      childNames: [],
      rootFiles: [{ name, bytes: file.bytes || 0 }],
      bytes: file.bytes || 0,
      files: 1,
      newestMtime: null,
      oldestMtime: null,
    });
  }
  for (const descendant of entry.descendants || []) {
    units.push({
      kind: "dir",
      depth: descendant.depth || 2,
      name: String(descendant.relPath || "").split("\\").pop() || descendant.relPath,
      relPathFromParent: descendant.relPath,
      relPathFromRoot: toRoot(descendant.relPath),
      absPath: toAbs(descendant.relPath),
      exts: Array.isArray(descendant.exts) ? descendant.exts : [],
      logFiles: descendant.logFiles || 0,
      levelDb: Boolean(descendant.levelDb),
      childNames: [],
      rootFiles: [],
      bytes: descendant.bytes || 0,
      files: descendant.files || 0,
      newestMtime: descendant.newestMtime || null,
      oldestMtime: descendant.oldestMtime || null,
    });
  }
  return units;
}

export function hasDatabase(unit) {
  if (unit.levelDb) return true;
  for (const ext of unit.exts || []) {
    if (DB_EXTENSIONS.has(String(ext).toLowerCase())) return true;
  }
  const names = [unit.name].concat(unit.childNames || []).filter(Boolean);
  for (const name of names) {
    if (String(name).toLowerCase() === "leveldb") return true;
  }
  for (const file of unit.rootFiles || []) {
    if (DB_NAME_RE.test(file.name)) return true;
  }
  return false;
}

function cacheNameHit(unit) {
  const names = [unit.name].concat(unit.childNames || []).filter(Boolean);
  for (const name of names) {
    if (CACHE_NAME_RE.test(name)) return name;
  }
  return "";
}

/**
 * 启发式判定（SPEC 第 63~67 行的四条规则，按给出顺序逐条尝试）。
 * 全部不命中返回 null，交给推测。
 */
export function heuristicVerdict(unit) {
  // 规则 1：名称或子目录名匹配缓存模式 -> safe / confidence low
  const cacheHit = cacheNameHit(unit);
  if (cacheHit) {
    return verdict({
      safety: "safe",
      category: "cache",
      confidence: "low",
      matchedBy: "heuristic",
      basis: "cache-name",
      owner: "未知",
      purpose: "【启发式】名称或子目录名与缓存模式匹配（" + cacheHit + "），内容通常可由软件重新生成",
      ifDeleted: "软件或系统下次运行时会自动重建；一般无用户数据损失（若含登录态请先人工确认）",
      evidence: "启发式规则 1 命中：" + cacheHit,
    });
  }

  // 补充规则（只作用于混合目录拆出来的文件子项）：单个安装包 -> safe / installer-cache。
  // SPEC 的四条规则都是针对目录的，这里只补一条文件级规则，不改变目录规则的先后顺序。
  if (unit.kind === "file" && UPDATER_FILE_RE.test(unit.name || "") && (unit.bytes || 0) > UPDATER_MIN_BYTES) {
    return verdict({
      safety: "safe",
      category: "installer-cache",
      confidence: "low",
      matchedBy: "heuristic",
      basis: "installer-file",
      owner: "未知",
      purpose: "【启发式】单个体积超过 50MB 的安装包（" + unit.name + "），安装完成后不再需要",
      ifDeleted: "安装包需要重新下载；已安装的程序不受影响",
      evidence: "启发式补充规则命中：安装包 " + unit.name,
    });
  }

  // 规则 2：目录内只有 *.log -> logs / safe
  const exts = (unit.exts || []).map((ext) => String(ext).toLowerCase()).filter(Boolean);
  if (exts.length > 0 && exts.every((ext) => LOG_EXT_RE.test(ext))) {
    return verdict({
      safety: "safe",
      category: "logs",
      confidence: "low",
      matchedBy: "heuristic",
      basis: "log-only",
      owner: "未知",
      purpose: "【启发式】目录内只有 .log 日志文件，没有其它数据类型",
      ifDeleted: "日志历史记录会丢失，不影响程序运行；多数程序会自动生成新日志",
      evidence: "启发式规则 2 命中：扩展名只有 " + exts.join("/"),
    });
  }

  // 规则 3：根下只有 1~3 个 *.exe|*.msi 且均 > 50MB -> updater / mixed
  const rootFiles = unit.rootFiles || [];
  if (
    unit.kind === "dir" &&
    (unit.childNames || []).length === 0 &&
    rootFiles.length >= 1 &&
    rootFiles.length <= 3 &&
    rootFiles.every((file) => UPDATER_FILE_RE.test(file.name) && (file.bytes || 0) > UPDATER_MIN_BYTES)
  ) {
    return verdict({
      safety: "mixed",
      category: "updater",
      confidence: "low",
      matchedBy: "heuristic",
      basis: "installer-files",
      owner: "未知",
      purpose: "【启发式】根目录只有 " + rootFiles.length + " 个体积超过 50MB 的安装包，缺少其它证据，按混合目录拆分",
      ifDeleted: "安装包删除后需要重新下载；已安装的程序不受影响",
      evidence: "启发式规则 3 命中：" + rootFiles.map((file) => file.name).join("、"),
    });
  }

  // 规则 4：含 *.db|*.sqlite|leveldb|*.ldb -> never
  if (hasDatabase(unit)) {
    const extsHit = (unit.exts || []).filter((ext) => DB_EXTENSIONS.has(String(ext).toLowerCase()));
    const detail = unit.levelDb
      ? "目录内存在 leveldb 数据库"
      : extsHit.length
        ? "存在数据库文件（" + extsHit.join("/") + "）"
        : "存在数据库文件";
    return verdict({
      safety: "never",
      category: "app-data",
      confidence: "low",
      matchedBy: "heuristic",
      basis: "database",
      owner: "未知",
      purpose: "【启发式】" + detail + "，通常是程序的状态库或用户数据",
      ifDeleted: "可能丢失书签、登录态、聊天记录或程序配置，一般不可恢复",
      evidence: "启发式规则 4 命中：" + detail,
    });
  }

  return null;
}

/** 推测：安全级 mixed + confidence low + purpose 前缀【推测】。 */
export function guessVerdict(unit) {
  if (unit.kind === "file") {
    return verdict({
      safety: "never",
      category: "unknown",
      confidence: "low",
      matchedBy: "guess",
      basis: "unknown-file",
      owner: "未知",
      purpose: "【推测】散落的未知文件：" + unit.name,
      ifDeleted: "用途不明；可能是配置或用户数据，删除后可能无法恢复",
      evidence: "无知识库命中，也没有可用的启发式证据",
      needsReview: true,
    });
  }
  return verdict({
    safety: "mixed",
    category: "unknown",
    confidence: "low",
    matchedBy: "guess",
    basis: "unknown",
    owner: "未知",
    purpose: "【推测】目录用途无法从名称与内容推断，需要人工确认后再决定",
    ifDeleted: "无法判断；整块删除可能连带用户数据，请按子项拆分处理",
    evidence: "无知识库命中，启发式四条规则均未命中",
    needsReview: true,
  });
}

function baseFromKnowledge(entry, matchedBy) {
  return verdict({
    safety: entry.safety,
    category: entry.category,
    confidence: entry.confidence,
    owner: entry.owner,
    purpose: entry.purpose,
    ifDeleted: entry.ifDeleted,
    evidence: entry.evidence || "知识库条目：" + (entry.source || "") + " match=" + entry.match,
    matchedBy,
    basis: "knowledge",
    rule: entry.match,
    notes: entry.notes || [],
    childRules: entry.children || [],
    needsReview: false,
  });
}

function hintsFor(entry, base) {
  const hints = [];
  if (entry.truncated) {
    hints.push("统计被截断（" + (entry.truncatedReason || "unknown") + "），体积与文件数偏小");
  }
  if (base.safety !== "never" && hasDatabase(entryUnit(entry))) {
    hints.push("目录内检测到数据库文件，删除前请确认是否含用户数据");
  }
  if (!entry.files) hints.push("目录内没有文件");
  return hints;
}

function ruleCategory(rule) {
  if (rule.safety === "safe") return "cache";
  return "app-data";
}

function childJudgement(parent, unit, base) {
  const notes = (base.notes || []).slice();
  const judgement = {
    depth: unit.depth || 2,
    kind: unit.kind,
    root: parent.root,
    name: unit.name,
    relPathFromParent: unit.relPathFromParent,
    relPath: unit.relPathFromRoot,
    absPath: unit.absPath,
    bytes: unit.bytes,
    files: unit.files,
    newestMtime: unit.newestMtime || null,
    oldestMtime: unit.oldestMtime || null,
    safety: base.safety,
    category: base.category,
    confidence: base.confidence,
    owner: base.owner || "未知",
    purpose: base.purpose || "",
    ifDeleted: base.ifDeleted || "未知",
    evidence: base.evidence || "",
    matchedBy: base.matchedBy,
    basis: base.basis || "",
    rule: base.rule || null,
    notes,
    hints: [],
    needsReview: Boolean(base.needsReview),
    parentRelPath: parent.relPath,
    children: [],
  };
  if (judgement.safety === "mixed" && unit.kind === "dir") {
    judgement.needsReview = true;
    if (!judgement.purpose) judgement.purpose = "【推测】子项内容混合，需要人工确认";
    if (!notes.some((note) => note.indexOf("两层") >= 0)) notes.push("本阶段只展开到第 4 层，未再向下拆分该子项");
  }
  return judgement;
}

/**
 * 拆分混合目录。
 * 命中知识库 children 的路径按“具体度”（match 里非通配的字面段数）决定胜出者：
 * 具体度高者优先，同具体度按声明顺序；被更具体的后代压倒的祖先命中降级为 mixed 并注明，
 * 避免出现“祖先说 never / safe，实际里面另有乾坤”的整块结论。
 */
export function splitChildren(entry, knowledge, childRules) {
  const rules = Array.isArray(childRules) ? childRules : [];
  const units = childUnits(entry);
  const hits = [];
  for (const unit of units) {
    if (rules.length === 0) break;
    // 第一层按契约：相对父条目；第二层宽容为相对根（知识库把前缀也写进去时仍能命中）。
    // 不做“尾段匹配”，否则 "browser" 之类规则会误伤 updated\browser 这种同名子目录。
    const hit = matchRule(rules, unit.relPathFromParent, [unit.relPathFromRoot]);
    if (hit) hits.push({ unit, hit });
  }

  // “更具体的规则统辖整棵子树”：
  //   后代规则更具体 -> 祖先的粗命中降级（不能整删），标记 superseded
  //   祖先规则更具体 -> 后代的粗命中根本不成立（例如被 * 兜底误伤的深路径），标记 dropped
  const superseded = new Set();
  const dropped = new Set();
  for (const item of hits) {
    const spec = item.hit.rule.info.spec;
    for (const other of hits) {
      if (other === item) continue;
      if (!other.unit.relPathFromParent.startsWith(item.unit.relPathFromParent + "\\")) continue;
      const otherSpec = other.hit.rule.info.spec;
      if (otherSpec > spec) superseded.add(item.unit);
      else if (otherSpec < spec) dropped.add(other.unit);
    }
  }

  const items = [];
  for (const item of hits) {
    if (dropped.has(item.unit) && !superseded.has(item.unit)) continue;
    const rule = item.hit.rule;
    // 松散文件命中「*」兜底规则没有信息量（文件本来就不是删除目标），跳过以免报告被 DLL 淹掉
    if (item.unit.kind === "file" && rule.info.spec === 0 && !superseded.has(item.unit)) continue;
    if (superseded.has(item.unit)) {
      items.push(
        childJudgement(entry, item.unit, {
          safety: "mixed",
          category: "unknown",
          confidence: "low",
          purpose: "【拆分】目录内存在更具体的知识库规则，不能整块删除，只能删其中的具体子项",
          ifDeleted: "整删会连带不可删内容；请只处理下面更具体的子项",
          evidence: "命中规则 " + rule.match + "，但内部还有更具体的规则",
          matchedBy: "knowledge-child",
          basis: "knowledge",
          rule: rule.match,
          needsReview: true,
        }),
      );
      continue;
    }
    items.push(
      childJudgement(entry, item.unit, {
        safety: rule.safety,
        category: ruleCategory(rule),
        confidence: "high",
        owner: "",
        purpose: rule.purpose || "知识库 children 命中：" + rule.match,
        ifDeleted: rule.ifDeleted || "未说明",
        evidence: "知识库 children 命中：" + rule.match,
        matchedBy: "knowledge-child",
        basis: "knowledge",
        rule: rule.match,
      }),
    );
  }

  // 第 1 层里没被知识库命中的，按 SPEC 顺序回落到启发式 / 推测
  const hitPaths = new Set(hits.map((item) => item.unit.relPathFromParent));
  for (const unit of units) {
    if (unit.depth !== 1 || hitPaths.has(unit.relPathFromParent)) continue;
    const rootHit = matchEntry(knowledge, entry.root, unit.relPathFromRoot, { suffix: true });
    const fallback = rootHit
      ? baseFromKnowledge(rootHit.entry, "knowledge")
      : heuristicVerdict(unit) || guessVerdict(unit);
    items.push(childJudgement(entry, unit, fallback));
  }

  return tidySplitItems(items, entry, MAX_SPLIT_ITEMS);
}

/**
 * 拆分子项后处理：
 * 1) 同一子树的同安全级后代只留最上层（避免 “never 套 never” 重复占行）
 * 2) safe 子项内部若还有不可删内容，降级为 mixed（不能整块删）
 * 3) 超过条数上限时截断并追加一条提示
 */
function tidySplitItems(items, entry, limit) {
  const ordered = items
    .map((item, order) => ({ item, order }))
    .sort((a, b) => a.item.depth - b.item.depth || b.item.bytes - a.item.bytes || a.order - b.order);
  const kept = [];
  for (const { item } of ordered) {
    const key = String(item.relPathFromParent || "").toLowerCase();
    if (!key) continue;
    const shadowed = kept.some((other) => {
      if (other.safety !== item.safety) return false;
      return key.startsWith(String(other.relPathFromParent || "").toLowerCase() + "\\");
    });
    if (shadowed) continue;
    kept.push(item);
  }

  for (const item of kept) {
    if (item.safety !== "safe") continue;
    const prefix = String(item.relPathFromParent || "").toLowerCase() + "\\";
    const inner = kept.find(
      (other) =>
        other !== item &&
        other.safety !== "safe" &&
        String(other.relPathFromParent || "").toLowerCase().startsWith(prefix),
    );
    if (!inner) continue;
    item.safety = "mixed";
    item.needsReview = true;
    item.purpose = "【拆分】内部还有不可删内容，不能整块删除，只能删具体子项";
    item.ifDeleted = "整删会连带 " + inner.relPathFromParent + "，请只处理其中被标为可安全删除的子项";
    item.notes.push("内部存在 " + inner.relPathFromParent + "（" + safetyLabel(inner.safety) + "）");
  }

  kept.sort(compareJudgements);
  if (kept.length > limit) {
    const dropped = kept.length - limit;
    const trimmed = kept.slice(0, limit);
    trimmed.push(
      childJudgement(
        entry,
        { kind: "dir", depth: 2, name: "…", relPathFromParent: "…", relPathFromRoot: entry.relPath + "\\…", absPath: "", bytes: 0, files: 0 },
        {
          safety: "mixed",
          category: "unknown",
          confidence: "low",
          purpose: "还有 " + dropped + " 个子项未列出（超过单目录 " + limit + " 条上限，可用更大 --min-mb 收紧）",
          ifDeleted: "—",
          evidence: "拆分条目上限",
          matchedBy: "guess",
          needsReview: true,
        },
      ),
    );
    return trimmed;
  }
  return kept;
}

/** 判定一条一级目录。 */
export function classifyEntry(entry, knowledge, options) {
  const opts = options || {};
  const hit = matchEntry(knowledge, entry.root, entry.relPath, {
    suffix: Boolean(opts.suffixKnowledgeMatch),
  });
  const base = hit ? baseFromKnowledge(hit.entry, "knowledge") : null;
  const chosen = base || heuristicVerdict(entryUnit(entry)) || guessVerdict(entryUnit(entry));

  const judgement = {
    depth: 1,
    root: entry.root,
    relPath: entry.relPath,
    absPath: entry.absPath,
    bytes: entry.bytes || 0,
    files: entry.files || 0,
    dirs: entry.dirs || 0,
    newestMtime: entry.newestMtime || null,
    oldestMtime: entry.oldestMtime || null,
    extTop: Array.isArray(entry.extTop) ? entry.extTop : [],
    exts: Array.isArray(entry.exts) ? entry.exts : [],
    childNames: Array.isArray(entry.childNames) ? entry.childNames : [],
    truncated: Boolean(entry.truncated),
    safety: chosen.safety,
    category: chosen.category,
    confidence: chosen.confidence,
    owner: chosen.owner || "未知",
    purpose: chosen.purpose || "",
    ifDeleted: chosen.ifDeleted || "未知",
    evidence: chosen.evidence || "",
    matchedBy: chosen.matchedBy,
    basis: chosen.basis || "",
    rule: chosen.rule,
    notes: (chosen.notes || []).slice(),
    hints: hintsFor(entry, chosen),
    needsReview: Boolean(chosen.needsReview),
    children: [],
  };

  if (judgement.safety === "mixed") {
    judgement.children = splitChildren(entry, knowledge, chosen.childRules);
    if (judgement.children.length === 0) {
      judgement.hints.push("未发现可拆分的子项，混合目录无法安全整删");
    }
  }
  return judgement;
}

/** 批量判定 + 汇总。 */
export function classifyEntries(entries, knowledge, options) {
  const list = Array.isArray(entries) ? entries : [];
  const judgements = list.map((entry) => classifyEntry(entry, knowledge, options));
  judgements.sort((a, b) => {
    if (a.root !== b.root) return String(a.root).localeCompare(String(b.root));
    return compareJudgements(a, b);
  });
  return judgements;
}

/** 汇总体积与条目数，供 report/plan 使用。 */
export function summarize(judgements) {
  const summary = {
    entries: 0,
    totalBytes: 0,
    safeBytes: 0,
    mixedBytes: 0,
    neverBytes: 0,
    recoverableBytes: 0,
    safe: 0,
    mixed: 0,
    never: 0,
    unknown: 0,
    mixedChildren: 0,
    safeChildrenBytes: 0,
    needsReview: 0,
    truncated: 0,
  };
  const safeChildPaths = [];
  for (const judgement of judgements || []) {
    summary.entries += 1;
    summary.totalBytes += judgement.bytes || 0;
    if (judgement.truncated) summary.truncated += 1;
    if (judgement.needsReview) summary.needsReview += 1;
    if (judgement.safety === "safe") {
      summary.safe += 1;
      summary.safeBytes += judgement.bytes || 0;
    } else if (judgement.safety === "mixed") {
      summary.mixed += 1;
      summary.mixedBytes += judgement.bytes || 0;
      for (const child of judgement.children || []) {
        summary.mixedChildren += 1;
        if (child.safety === "safe") safeChildPaths.push({ absPath: String(child.absPath || ""), bytes: child.bytes || 0 });
      }
    } else if (judgement.safety === "never") {
      summary.never += 1;
      summary.neverBytes += judgement.bytes || 0;
    } else {
      summary.unknown += 1;
    }
  }
  // 嵌套的 safe 子项只算一次（父目录已覆盖的路径不再重复计入可回收体积）
  safeChildPaths.sort((a, b) => a.absPath.split("\\").length - b.absPath.split("\\").length || b.bytes - a.bytes);
  const covered = [];
  for (const item of safeChildPaths) {
    const key = item.absPath.toLowerCase();
    if (!key) continue;
    if (covered.some((prefix) => key.startsWith(prefix))) continue;
    covered.push(key + "\\");
    summary.safeChildrenBytes += item.bytes;
  }
  summary.recoverableBytes = summary.safeBytes + summary.safeChildrenBytes;
  return summary;
}
