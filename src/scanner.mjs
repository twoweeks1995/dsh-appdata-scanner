// src/scanner.mjs —— 只读扫描 AppData 三个根的一级子目录
// 硬性约束：只读；跳过符号链接与目录联接；单目录 15 秒或 20 万文件即截断。
//
// 每个一级目录除了自身统计外，还聚合两套“子路径视图”，供知识库 children 规则命中：
//   children    —— 相对一级目录的第 1 层（带扩展名、是否含 leveldb）
//   descendants —— 相对一级目录的第 2~4 层（按体积排序、带深度）
// 这样 "Edge\User Data\*\Cache" 这种多层规则才能在真实目录树里匹配到。
import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";

export const ROOT_NAMES = ["local", "roaming", "locallow"];

export const ROOT_LABELS = { local: "Local", roaming: "Roaming", locallow: "LocalLow" };

export const LIMITS = Object.freeze({
  dirMs: 15000,
  maxFiles: 200000,
  statConcurrency: 96,
  maxRootFiles: 400,
  maxChildNames: 300,
  maxChildren: 400,
  extTopN: 10,
  extListMax: 40,
  childNamesPerChild: 12,
  deepestLevel: 4,
  maxTrackedPerLevel: 4000,
  maxDescendantsPerLevel: 130,
});

/**
 * 三个根的实际路径。
 * 显式传入 homeDir 时以它为准（夹具/自测需要确定性）；否则环境变量优先，其次 %USERPROFILE%。
 */
export function defaultRoots(homeDir) {
  const env = process.env;
  const explicit = typeof homeDir === "string" && homeDir.length > 0;
  const home = explicit ? homeDir : env.USERPROFILE || env.HOME || homedir();
  return {
    local: explicit ? join(home, "AppData", "Local") : env.LOCALAPPDATA || join(home, "AppData", "Local"),
    roaming: explicit ? join(home, "AppData", "Roaming") : env.APPDATA || join(home, "AppData", "Roaming"),
    locallow: join(home, "AppData", "LocalLow"),
  };
}

export function extOf(name) {
  if (typeof name !== "string") return "";
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) return "";
  return name.slice(dot + 1).toLowerCase();
}

function newAcc() {
  return {
    bytes: 0,
    files: 0,
    dirs: 0,
    newest: 0,
    oldest: 0,
    extCount: new Map(),
    levelDb: false,
    logFiles: 0,
    childNames: [],
  };
}

function addFile(target, size, mtime, ext) {
  target.bytes += size;
  target.files += 1;
  if (mtime > 0) {
    if (mtime > target.newest) target.newest = mtime;
    if (target.oldest === 0 || mtime < target.oldest) target.oldest = mtime;
  }
  if (ext) {
    target.extCount.set(ext, (target.extCount.get(ext) || 0) + 1);
    if (ext === "log") target.logFiles += 1;
  }
}

function sortedExts(extCount) {
  return [...extCount.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

function extTopList(extCount, limit) {
  return sortedExts(extCount)
    .slice(0, limit)
    .map((pair) => [pair[0], pair[1]]);
}

function extList(extCount, limit) {
  return sortedExts(extCount)
    .slice(0, limit)
    .map((pair) => pair[0]);
}

function accRecord(name, acc, limits) {
  return {
    name,
    bytes: acc.bytes,
    files: acc.files,
    newestMtime: acc.newest || null,
    oldestMtime: acc.oldest || null,
    extTop: extTopList(acc.extCount, 5),
    exts: extList(acc.extCount, 20),
    logFiles: acc.logFiles,
    levelDb: acc.levelDb,
    childNames: acc.childNames.slice(0, limits.childNamesPerChild),
  };
}

/** 列出某个根下的一级子目录（跳过符号链接/目录联接）。 */
export async function listFirstLevel(absPath) {
  const found = { dirs: [], linksSkipped: 0, errors: 0, error: null };
  let dirents;
  try {
    dirents = await readdir(absPath, { withFileTypes: true });
  } catch (err) {
    found.errors += 1;
    found.error = err && err.code ? err.code : String(err && err.message);
    return found;
  }
  for (const dirent of dirents) {
    if (dirent.isSymbolicLink()) {
      found.linksSkipped += 1;
      continue;
    }
    if (dirent.isDirectory()) found.dirs.push(dirent.name);
  }
  found.dirs.sort((a, b) => a.localeCompare(b));
  return found;
}

/**
 * 扫描一个一级子目录。
 * @param {string} rootName 根名（local/roaming/locallow）
 * @param {string} absPath  一级子目录的绝对路径
 */
export async function scanDirectory(rootName, absPath, options) {
  const opts = options || {};
  const limits = opts.limits || LIMITS;
  const budgetDeadline = opts.deadline || 0;
  const startedAt = Date.now();
  const deadline = startedAt + limits.dirMs;
  const deepest = limits.deepestLevel || 4;

  const entry = {
    root: rootName,
    relPath: basename(absPath),
    absPath,
    kind: "dir",
    bytes: 0,
    files: 0,
    dirs: 0,
    newestMtime: null,
    oldestMtime: null,
    extTop: [],
    exts: [],
    logFiles: 0,
    levelDb: false,
    childNames: [],
    children: [],
    descendants: [],
    rootFiles: [],
    errors: 0,
    linksSkipped: 0,
    truncated: false,
    truncatedReason: null,
    scanMillis: 0,
  };

  const total = newAcc();
  const levelMaps = new Map();
  for (let depth = 1; depth <= deepest; depth += 1) levelMaps.set(depth, new Map());
  const stack = [{ dir: absPath, segments: [] }];
  let filesSeen = 0;
  let stopped = false;

  const markTruncated = (reason) => {
    entry.truncated = true;
    if (!entry.truncatedReason) entry.truncatedReason = reason;
  };

  // 取或建某一层的前缀累加器；同一层超过上限后不再收新路径（只继续累加已有路径）
  const levelAcc = (depth, key) => {
    const map = levelMaps.get(depth);
    if (!map) return null;
    let acc = map.get(key);
    if (acc) return acc;
    if (map.size >= limits.maxTrackedPerLevel) return null;
    acc = newAcc();
    map.set(key, acc);
    return acc;
  };

  while (stack.length > 0 && !stopped) {
    if (Date.now() > deadline) {
      markTruncated("timeout");
      break;
    }
    if (budgetDeadline && Date.now() > budgetDeadline) {
      markTruncated("budget");
      break;
    }
    if (filesSeen >= limits.maxFiles) {
      markTruncated("max-files");
      break;
    }
    const node = stack.pop();
    const depth = node.segments.length;
    let dirents;
    try {
      dirents = await readdir(node.dir, { withFileTypes: true });
    } catch (err) {
      entry.errors += 1;
      continue;
    }
    total.dirs += 1;
    const level1 = depth >= 1 ? levelMaps.get(1).get(node.segments[0]) : null;
    const files = [];
    const subdirs = [];
    for (const dirent of dirents) {
      if (dirent.isSymbolicLink()) {
        entry.linksSkipped += 1;
        continue;
      }
      if (dirent.isDirectory()) {
        subdirs.push(dirent.name);
        const childSegments = node.segments.concat(dirent.name);
        if (depth === 0 && entry.childNames.length < limits.maxChildNames) entry.childNames.push(dirent.name);
        if (depth === 1 && level1 && level1.childNames.length < limits.childNamesPerChild) level1.childNames.push(dirent.name);
        const isLevelDb = dirent.name.toLowerCase() === "leveldb";
        if (isLevelDb) total.levelDb = true;
        for (let k = 1; k <= Math.min(deepest, childSegments.length); k += 1) {
          const acc = levelAcc(k, childSegments.slice(0, k).join("\\"));
          if (acc && isLevelDb) acc.levelDb = true;
        }
        continue;
      }
      if (dirent.isFile()) {
        files.push(dirent.name);
        continue;
      }
      entry.errors += 1;
    }

    for (let i = 0; i < files.length && !stopped; i += limits.statConcurrency) {
      const chunk = files.slice(i, i + limits.statConcurrency);
      const stats = await Promise.all(chunk.map((name) => stat(join(node.dir, name)).catch(() => null)));
      for (let k = 0; k < chunk.length; k += 1) {
        const st = stats[k];
        if (!st || !st.isFile()) {
          entry.errors += 1;
          continue;
        }
        const name = chunk[k];
        const ext = extOf(name);
        const mtime = typeof st.mtimeMs === "number" ? st.mtimeMs : st.mtime.getTime();
        filesSeen += 1;
        addFile(total, st.size, mtime, ext);
        if (depth === 0) {
          if (entry.rootFiles.length < limits.maxRootFiles) entry.rootFiles.push({ name, bytes: st.size });
        } else {
          for (let level = 1; level <= Math.min(deepest, depth); level += 1) {
            const acc = levelMaps.get(level).get(node.segments.slice(0, level).join("\\"));
            if (acc) addFile(acc, st.size, mtime, ext);
          }
        }
        if (filesSeen >= limits.maxFiles) {
          markTruncated("max-files");
          stopped = true;
          break;
        }
      }
      if (Date.now() > deadline) {
        markTruncated("timeout");
        stopped = true;
        break;
      }
      if (budgetDeadline && Date.now() > budgetDeadline) {
        markTruncated("budget");
        stopped = true;
        break;
      }
    }
    if (stopped) break;
    for (const name of subdirs) {
      stack.push({ dir: join(node.dir, name), segments: node.segments.concat(name) });
    }
  }

  entry.bytes = total.bytes;
  entry.files = total.files;
  entry.dirs = total.dirs;
  entry.newestMtime = total.newest || null;
  entry.oldestMtime = total.oldest || null;
  entry.extTop = extTopList(total.extCount, limits.extTopN);
  entry.exts = extList(total.extCount, limits.extListMax);
  entry.logFiles = total.logFiles;
  entry.levelDb = total.levelDb;
  entry.children = [...levelMaps.get(1).entries()]
    .map(([name, acc]) => accRecord(name, acc, limits))
    .filter((child) => child.files > 0)
    .sort((a, b) => b.bytes - a.bytes || a.name.localeCompare(b.name))
    .slice(0, limits.maxChildren);

  const descendants = [];
  for (let level = 2; level <= deepest; level += 1) {
    const bucket = [...levelMaps.get(level).entries()]
      .filter(([, acc]) => acc.files > 0)
      .sort((a, b) => b[1].bytes - a[1].bytes || a[0].localeCompare(b[0]))
      .slice(0, limits.maxDescendantsPerLevel);
    for (const [relPath, acc] of bucket) {
      descendants.push({
        depth: level,
        relPath,
        bytes: acc.bytes,
        files: acc.files,
        newestMtime: acc.newest || null,
        oldestMtime: acc.oldest || null,
        extTop: extTopList(acc.extCount, 3),
        exts: extList(acc.extCount, 12),
        logFiles: acc.logFiles,
        levelDb: acc.levelDb,
      });
    }
  }
  entry.descendants = descendants;
  entry.scanMillis = Date.now() - startedAt;
  return entry;
}

/**
 * 扫描三个根的一级子目录。
 * @returns 扫描文档（也是 report/plan 的输入格式）
 */
export async function scan(options) {
  const opts = options || {};
  const limits = opts.limits || LIMITS;
  const roots = opts.roots || defaultRoots(opts.homeDir);
  const rootNames = (opts.rootNames || ROOT_NAMES).filter((name) => roots[name]);
  const minMb = Number(opts.minMb || 0);
  const minBytes = Math.max(0, minMb) * 1024 * 1024;
  const maxSeconds = Number(opts.maxSeconds || 0);
  const deadline = maxSeconds > 0 ? Date.now() + maxSeconds * 1000 : 0;

  const doc = {
    version: 1,
    generator: "appdata-scanner",
    phase: "scan-only",
    generatedAt: new Date().toISOString(),
    limits: { dirMs: limits.dirMs, maxFiles: limits.maxFiles, deepestLevel: limits.deepestLevel },
    options: { minMb, maxSeconds },
    budget: { maxSeconds, exhausted: false },
    roots: [],
    entries: [],
    stats: { scanned: 0, kept: 0, filtered: 0, errors: 0, linksSkipped: 0, millis: 0 },
  };

  const startedAt = Date.now();
  let done = false;
  for (const rootName of rootNames) {
    if (done) break;
    const absPath = roots[rootName];
    const info = {
      name: rootName,
      label: ROOT_LABELS[rootName] || rootName,
      absPath,
      exists: false,
      dirs: 0,
      linksSkipped: 0,
      error: null,
    };
    try {
      const st = await stat(absPath);
      info.exists = st.isDirectory();
      if (!info.exists) info.error = "不是目录";
    } catch (err) {
      info.error = err && err.code ? err.code : String(err && err.message);
    }
    doc.roots.push(info);
    if (!info.exists) continue;

    const listed = await listFirstLevel(absPath);
    info.dirs = listed.dirs.length;
    info.linksSkipped = listed.linksSkipped;
    doc.stats.linksSkipped += listed.linksSkipped;
    doc.stats.errors += listed.errors;

    for (let i = 0; i < listed.dirs.length; i += 1) {
      const name = listed.dirs[i];
      if (deadline && Date.now() > deadline) {
        doc.budget.exhausted = true;
        done = true;
        break;
      }
      if (typeof opts.onProgress === "function") {
        try {
          opts.onProgress({ root: rootName, name, index: i + 1, total: listed.dirs.length });
        } catch (err) {
          // 进度回调不应影响扫描
        }
      }
      const entry = await scanDirectory(rootName, join(absPath, name), { limits, deadline });
      doc.stats.scanned += 1;
      doc.stats.errors += entry.errors;
      if (entry.bytes >= minBytes) {
        doc.entries.push(entry);
        doc.stats.kept += 1;
      } else {
        doc.stats.filtered += 1;
      }
    }
  }
  doc.stats.millis = Date.now() - startedAt;
  return doc;
}
