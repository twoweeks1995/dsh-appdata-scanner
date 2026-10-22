// src/scanner.mjs —— 只读扫描 AppData 三个根的一级子目录
// 硬性约束：只读；跳过符号链接与目录联接；单目录 15 秒或 20 万文件即截断。
//
// 每个一级目录除了自身统计外，还聚合两套“子路径视图”，供知识库 children 规则命中：
//   children    —— 相对一级目录的第 1 层（带扩展名、是否含 leveldb）
//   descendants —— 相对一级目录的第 2~4 层（按体积排序、带深度）
// 这样 "Edge\User Data\*\Cache" 这种多层规则才能在真实目录树里匹配到。
import { statSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { homedir, userInfo } from "node:os";
import { basename, dirname, join } from "node:path";

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

/** 目录是否存在（解析根路径时同步判定一次；任何异常一律按“不存在”处理）。 */
function isDirectorySync(target) {
  if (!target) return false;
  try {
    return statSync(target).isDirectory();
  } catch (err) {
    return false;
  }
}

/** 两个路径是否指向同一处（Windows 语义：忽略大小写与尾部分隔符）。 */
function samePath(a, b) {
  const norm = (value) => String(value || "").replace(/[\\/]+$/, "").toLowerCase();
  const left = norm(a);
  return left !== "" && left === norm(b);
}

/**
 * 解析「当前用户」的 AppData 三个根，并给出诊断信息。
 *
 * 为什么不再用 USERPROFILE/LOCALAPPDATA 优先：多用户机器上，进程环境可能属于别的账户
 * （提权、被别的账户拉起、环境继承污染），旧写法会安静地扫错人。os.homedir() 走 libuv，
 * 在 Windows 上会回落到 SHGetKnownFolderPath，**不依赖用户文件夹名**，所以它是主来源。
 *
 * 注意：绝不用 os.userInfo().username 去拼 C:\Users\<username>——文件夹名与账户名不一定对应。
 *
 * 顺序：显式传入的 homeDir（夹具/测试，直接采用，不校验存在性）
 *      -> os.homedir() -> %LOCALAPPDATA% -> %USERPROFILE% ，只采用真实存在的目录；
 *      全都不存在则抛错，错误信息里列出所有候选路径。
 *
 * @param {string} [homeDir] 显式指定的用户目录（可用时优先，且不做存在性校验）
 * @param {(path:string)=>boolean} [probe] 仅供自测注入的存在性判定（默认 statSync().isDirectory()）
 * @returns {{home:string, appDataRoot:string, local:string, roaming:string, locallow:string,
 *   source:string, user:string, osHome:string, envLocalAppData:?string, envUserProfile:?string,
 *   conflict:boolean, candidates:{source:string,path:string,exists:boolean}[]}}
 */
export function resolveHome(homeDir, probe) {
  const env = process.env;
  const isDirectory = typeof probe === "function" ? probe : isDirectorySync;
  const explicitHome = typeof homeDir === "string" && homeDir.trim().length > 0 ? homeDir.trim() : "";
  let osHome = "";
  try {
    osHome = homedir() || "";
  } catch (err) {
    osHome = "";
  }
  let user = "";
  try {
    user = (userInfo() && userInfo().username) || "";
  } catch (err) {
    user = "";
  }
  const envLocalAppData = typeof env.LOCALAPPDATA === "string" && env.LOCALAPPDATA ? env.LOCALAPPDATA : undefined;
  const envUserProfile = typeof env.USERPROFILE === "string" && env.USERPROFILE ? env.USERPROFILE : undefined;
  const homedirLocal = osHome ? join(osHome, "AppData", "Local") : "";

  const ordered = [];
  if (explicitHome) {
    ordered.push({ source: "config", path: join(explicitHome, "AppData", "Local") });
  } else {
    if (homedirLocal) ordered.push({ source: "homedir", path: homedirLocal });
    if (envLocalAppData) ordered.push({ source: "LOCALAPPDATA", path: envLocalAppData });
    if (envUserProfile) ordered.push({ source: "USERPROFILE", path: join(envUserProfile, "AppData", "Local") });
  }
  const candidates = ordered.map((item) => ({
    source: item.source,
    path: item.path,
    exists: explicitHome ? true : isDirectory(item.path),
  }));
  const chosen = candidates.find((item) => item.exists);
  if (!chosen) {
    const listed = candidates.length > 0
      ? candidates.map((item) => item.path + "（" + item.source + "）").join("；")
      : "没有可用候选：os.homedir()、LOCALAPPDATA、USERPROFILE 都为空";
    throw new Error("无法确定 AppData 目录，所有候选都不存在或不是目录：" + listed);
  }
  // 三个根必须来自同一个用户：全部由被选中的 Local 的父目录（...\AppData）推导
  const local = chosen.path;
  const appDataRoot = dirname(local);
  return {
    home: dirname(appDataRoot),
    appDataRoot,
    local,
    roaming: join(appDataRoot, "Roaming"),
    locallow: join(appDataRoot, "LocalLow"),
    source: chosen.source,
    user,
    osHome,
    envLocalAppData,
    envUserProfile,
    // env 与 homedir 指向不同用户：记进诊断字段，但**仍然优先 homedir**（系统 API 更权威）
    conflict: Boolean(envLocalAppData && homedirLocal && !samePath(envLocalAppData, homedirLocal)),
    candidates,
  };
}

/**
 * 三个根的实际路径（扫描/CLI 的入口，行为与 resolveHome 一致）。
 * 显式传入 homeDir 时以它为准；否则按 resolveHome 的顺序只采用真实存在的目录，全都不存在则抛错。
 */
export function defaultRoots(homeDir) {
  const resolved = resolveHome(homeDir);
  return { local: resolved.local, roaming: resolved.roaming, locallow: resolved.locallow };
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
