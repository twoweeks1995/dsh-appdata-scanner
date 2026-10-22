// test/scanner.test.mjs —— 只读扫描与截断行为
import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";

import { scan, scanDirectory, extOf, LIMITS, defaultRoots } from "../src/scanner.mjs";
import { FIXTURE_ROOT, createFixture, removeFixture, tryJunction } from "./helpers.mjs";

test("扫描统计体积/文件数/子项/扩展名", async () => {
  const dir = await createFixture("scan", {
    "CacheFace/Cache/blob.bin": 1024 * 1024,
    "CacheFace/index.json": "{}",
  });
  try {
    const doc = await scan({ roots: { local: dir }, rootNames: ["local"], minMb: 0 });
    const entry = doc.entries.find((item) => item.relPath === "CacheFace");
    assert.ok(entry, "应当扫描到 CacheFace");
    assert.equal(entry.files, 2);
    assert.equal(entry.bytes, 1024 * 1024 + 2);
    assert.deepEqual(entry.childNames, ["Cache"]);
    assert.ok(entry.extTop.some((pair) => pair[0] === "bin"));
    assert.equal(entry.children.length, 1);
    assert.equal(entry.children[0].name, "Cache");
    assert.equal(entry.children[0].bytes, 1024 * 1024);
    assert.equal(entry.truncated, false);
    assert.ok(entry.newestMtime > 0);
    assert.ok(entry.oldestMtime > 0);
    assert.equal(doc.stats.scanned, 1);
    assert.equal(doc.roots[0].exists, true);
  } finally {
    await removeFixture(dir);
  }
});

test("跳过符号链接与目录联接", async (t) => {
  const dir = await createFixture("link", {
    "Target/file.txt": "abc",
    "Other/file.txt": "de",
  });
  try {
    const linked = await tryJunction(join(dir, "Target"), join(dir, "Linked"));
    const doc = await scan({ roots: { local: dir }, rootNames: ["local"], minMb: 0 });
    const names = doc.entries.map((item) => item.relPath).sort();
    assert.deepEqual(names, ["Other", "Target"]);
    if (linked) assert.equal(doc.roots[0].linksSkipped, 1);
    else t.diagnostic("无法创建目录联接，跳过 linksSkipped 断言");
  } finally {
    await removeFixture(dir);
  }
});

test("文件数超限即截断并标记 truncated", async () => {
  const dir = await createFixture("cut", {
    "Many/a.txt": "a",
    "Many/b.txt": "b",
    "Many/c.txt": "c",
    "Many/d.txt": "d",
    "Many/e.txt": "e",
  });
  try {
    const entry = await scanDirectory("local", join(dir, "Many"), {
      limits: Object.assign({}, LIMITS, { maxFiles: 3 }),
    });
    assert.equal(entry.truncated, true);
    assert.equal(entry.truncatedReason, "max-files");
    assert.equal(entry.files, 3);
  } finally {
    await removeFixture(dir);
  }
});

test("根目录不存在时记录 exists:false 且不抛错", async () => {
  const missing = join(FIXTURE_ROOT, "definitely-missing-" + Date.now());
  const doc = await scan({ roots: { local: missing }, rootNames: ["local"], minMb: 0 });
  assert.equal(doc.roots.length, 1);
  assert.equal(doc.roots[0].exists, false);
  assert.equal(doc.entries.length, 0);
});

test("--min-mb 过滤小于阈值的目录", async () => {
  const dir = await createFixture("mini", {
    "Big/blob.bin": 2 * 1024 * 1024,
    "Small/note.txt": "hi",
  });
  try {
    const doc = await scan({ roots: { local: dir }, rootNames: ["local"], minMb: 1 });
    assert.deepEqual(
      doc.entries.map((item) => item.relPath),
      ["Big"],
    );
    assert.equal(doc.stats.filtered, 1);
  } finally {
    await removeFixture(dir);
  }
});

test("extOf 与 defaultRoots", () => {
  assert.equal(extOf("a.bin"), "bin");
  assert.equal(extOf("A.BIN"), "bin");
  assert.equal(extOf("noext"), "");
  assert.equal(extOf(".gitignore"), "");
  const roots = defaultRoots("C:\\Users\\demo");
  assert.ok(roots.local.endsWith("AppData\\Local"));
  assert.ok(roots.roaming.endsWith("AppData\\Roaming"));
  assert.ok(roots.locallow.endsWith("AppData\\LocalLow"));
});
