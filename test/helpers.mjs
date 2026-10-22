// test/helpers.mjs —— 自测夹具：临时目录、稀疏大文件、目录联接、合成扫描条目
import { mkdir, mkdtemp, open, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const FIXTURE_ROOT = resolve(fileURLToPath(new URL("./fixtures/", import.meta.url)));

/** 在 test/fixtures 下建一个唯一临时目录，并按 files 描述创建内容。
 *  值为 number 时创建该字节数的稀疏文件；为 string 时写文本。
 */
export async function createFixture(prefix, files) {
  await mkdir(FIXTURE_ROOT, { recursive: true });
  const dir = await mkdtemp(join(FIXTURE_ROOT, prefix + "-"));
  if (files) await applyFiles(dir, files);
  return dir;
}

export async function applyFiles(root, files) {
  for (const rel of Object.keys(files)) {
    const value = files[rel];
    const full = join(root, rel);
    await mkdir(dirname(full), { recursive: true });
    if (typeof value === "number") {
      const handle = await open(full, "w");
      await handle.truncate(value);
      await handle.close();
      continue;
    }
    await writeFile(full, value === undefined ? "" : String(value), "utf8");
  }
}

/** 清理临时目录；Windows 上偶发占用，重试几次。 */
export async function removeFixture(dir) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      await rm(dir, { recursive: true, force: true });
      return true;
    } catch (err) {
      await new Promise((done) => setTimeout(done, 60));
    }
  }
  return false;
}

/** 尝试创建目录联接（Windows 上 junctions 不需要管理员权限）；失败返回 false。 */
export async function tryJunction(target, linkPath) {
  try {
    await symlink(target, linkPath, "junction");
    return true;
  } catch (err) {
    return false;
  }
}

const ENTRY_DEFAULTS = {
  root: "local",
  kind: "dir",
  bytes: 1024,
  files: 1,
  dirs: 1,
  newestMtime: 1700000000000,
  oldestMtime: 1600000000000,
  extTop: [["txt", 1]],
  exts: ["txt"],
  logFiles: 0,
  levelDb: false,
  childNames: [],
  children: [],
  rootFiles: [],
  errors: 0,
  linksSkipped: 0,
  truncated: false,
  truncatedReason: null,
  scanMillis: 1,
};

const ROOT_PATHS = {
  local: "C:\\Users\\fixture\\AppData\\Local",
  roaming: "C:\\Users\\fixture\\AppData\\Roaming",
  locallow: "C:\\Users\\fixture\\AppData\\LocalLow",
};

/** 合成一条扫描条目（不碰磁盘），用于 report/plan 的确定性测试。 */
export function makeEntry(relPath, overrides) {
  const over = overrides || {};
  const root = over.root || "local";
  return Object.assign({}, ENTRY_DEFAULTS, over, {
    root,
    relPath,
    absPath: join(ROOT_PATHS[root] || ROOT_PATHS.local, relPath),
  });
}

/** 合成一个子项统计（scanner 的 children 元素形状）。 */
export function makeChild(name, overrides) {
  const over = overrides || {};
  return Object.assign(
    {
      name,
      bytes: 1024,
      files: 1,
      newestMtime: 1700000000000,
      oldestMtime: 1600000000000,
      extTop: [["txt", 1]],
      exts: ["txt"],
      logFiles: 0,
      levelDb: false,
      childNames: [],
    },
    over,
  );
}
