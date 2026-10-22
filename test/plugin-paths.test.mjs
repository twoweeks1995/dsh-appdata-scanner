import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import { join, normalize } from "node:path";
import { resolveInsideRoot, treePathSegments } from "../plugin/index.js";
import { createFixture, removeFixture, tryJunction } from "./helpers.mjs";

async function rejectsPath(input, root, message) {
  await assert.rejects(resolveInsideRoot(input, root), (err) => {
    assert.equal(err.status, 400);
    assert.equal(err.message, message);
    return true;
  });
}

test("A 组：绝对路径的输入校验与报错顺序", async (t) => {
  const root = "C:\\Users\\fixture\\AppData";
  const cases = [
    ["非字符串", null, "path 必须是字符串"],
    ["空串", "", "path 不能为空"],
    ["纯空白", "   ", "path 不能为空"],
    ["NUL 优先于绝对路径检查", "..\u0000", "path 含非法字符"],
    ["相对路径", "Local", "path 必须是带盘符的绝对路径：Local"],
    ["盘符相对路径", "C:Local", "path 必须是带盘符的绝对路径：C:Local"],
    ["绝对路径检查优先于上跳检查", "..", "path 必须是带盘符的绝对路径：.."],
    ["上跳优先于根前缀检查", "D:\\outside\\..\\child", "path 不允许包含 ..：D:\\outside\\..\\child"],
    ["正斜线中的上跳", "C:/Users/fixture/AppData/Local/../Roaming", "path 不允许包含 ..：C:/Users/fixture/AppData/Local/../Roaming"],
    ["两侧带空格的上跳段", root + "\\Local\\ .. \\child", "path 不允许包含 ..：" + root + "\\Local\\ .. \\child"],
    ["相似前缀不是子目录", root + "2\\Local", "path 不在 AppData 之下：" + normalize(root + "2\\Local")],
    ["其他盘符在根外", "D:\\outside", "path 不在 AppData 之下：" + normalize("D:\\outside")],
    ["UNC 在当前根外", "\\\\server\\share\\Local", "path 不在 AppData 之下：" + normalize("\\\\server\\share\\Local")],
  ];
  for (const [name, input, message] of cases) {
    await t.test(name, () => rejectsPath(input, root, message));
  }
});

test("A 组：Windows 真实目录边界", { skip: process.platform !== "win32" && "真实路径校验采用 Windows 路径语义" }, async (t) => {
  const fixture = await createFixture("plugin-paths");
  t.after(async () => {
    assert.equal(await removeFixture(fixture), true, "临时目录应完整清理");
  });
  const root = join(fixture, "AppData");
  const local = join(root, "Local");
  const deep = join(local, "应用目录", "多级缓存");
  const outside = join(fixture, "outside");
  const sibling = join(fixture, "AppData2", "Local");
  await mkdir(deep, { recursive: true });
  await mkdir(outside);
  await mkdir(sibling, { recursive: true });
  const file = join(local, "普通文件.txt");
  await writeFile(file, "测试文件", "utf8");

  await t.test("带盘符的合法子路径返回真实路径", async () => {
    assert.match(local, /^[a-zA-Z]:[\\/]/);
    assert.equal(await resolveInsideRoot(local, root), await realpath(local));
  });
  await t.test("多级中文目录返回真实路径", async () => {
    assert.equal(await resolveInsideRoot(deep, root), await realpath(deep));
  });
  await t.test("允许 AppData 根目录本身", async () => {
    // 允许根目录本身，因为顶层要列出 AppData 下的目录。
    assert.equal(await resolveInsideRoot(root, root), await realpath(root));
  });
  await t.test("根目录的尾部分隔符与输入空白被归一化", async () => {
    assert.equal(await resolveInsideRoot("  " + root + "\\  ", root + "\\"), await realpath(root));
  });
  await t.test("路径与根的大小写差异在 Windows 下接受", async () => {
    assert.equal(await resolveInsideRoot(deep.toUpperCase(), root.toLowerCase()), await realpath(deep));
  });
  await t.test("正斜线归一化后接受", async () => {
    assert.equal(await resolveInsideRoot(deep.replaceAll("\\", "/"), root), await realpath(deep));
  });
  await t.test("AppData2 不属于 AppData，即使它真实存在", async () => {
    await rejectsPath(sibling, root, "path 不在 AppData 之下：" + normalize(sibling));
  });
  await t.test("含上跳的现存目录仍拒绝", async () => {
    const input = local + "\\..";
    await rejectsPath(input, root, "path 不允许包含 ..：" + input);
  });
  await t.test("不存在的路径拒绝", async () => {
    const missing = join(root, "不存在");
    await rejectsPath(missing, root, "目录不存在：" + missing);
  });
  await t.test("已存在的普通文件拒绝", async () => {
    await rejectsPath(file, root, "path 不是目录：" + file);
  });
  await t.test("可信的真实根缓存参数不改变结果", async () => {
    assert.equal(await resolveInsideRoot(deep, root, { rootReal: await realpath(root) }), await realpath(deep));
  });
  await t.test("目录联接或符号链接指向根外时拒绝", async (linkTest) => {
    const link = join(root, "逃逸联接");
    if (!(await tryJunction(outside, link))) {
      linkTest.skip("当前环境无法创建目录联接或符号链接");
      return;
    }
    await rejectsPath(link, root, "path 解析后指向 AppData 之外（符号链接/目录联接）：" + await realpath(outside));
  });
  await t.test("指向根内的目录联接返回目标真实路径", async (linkTest) => {
    const link = join(root, "根内联接");
    if (!(await tryJunction(deep, link))) {
      linkTest.skip("当前环境无法创建目录联接或符号链接");
      return;
    }
    assert.equal(await resolveInsideRoot(link, root), await realpath(deep));
  });
});

test("B 组：相对路径拒绝危险前缀和段，保留顶层空路径", async (t) => {
  const valid = [
    ["空串代表顶层", "", []],
    ["纯空白代表顶层", "   ", []],
    ["多级中文路径", "Local\\应用目录/多级缓存", ["Local", "应用目录", "多级缓存"]],
    ["跳过当前目录段与重复分隔符", "Local//./缓存", ["Local", "缓存"]],
  ];
  for (const [name, input, segments] of valid) {
    await t.test(name, () => assert.deepEqual(treePathSegments(input), { segments }));
  }
  const invalid = [
    ["NUL", "Local\u0000", "path 含非法字符"],
    ["盘符绝对路径", "C:\\Local", "path 不能带盘符：C:\\Local"],
    ["盘符相对路径", "C:Local", "path 不能带盘符：C:Local"],
    ["反斜线 UNC", "\\\\server\\share", "path 不能是 UNC 路径：\\\\server\\share"],
    ["正斜线 UNC", "//server/share", "path 不能是 UNC 路径：//server/share"],
    ["前导反斜线", "\\Local", "path 必须是相对 AppData 的路径：\\Local"],
    ["前导正斜线", "/Local", "path 必须是相对 AppData 的路径：/Local"],
    ["上跳", "Local\\..\\Roaming", "path 不允许包含 ..：Local\\..\\Roaming"],
    ["空白包围的上跳", "Local/ .. /Roaming", "path 不允许包含 ..：Local/ .. /Roaming"],
    ["段内冒号与数据流", "Local/file.txt:stream", "path 段不能包含冒号（盘符/数据流）：file.txt:stream"],
  ];
  for (const symbol of ['<', '>', '"', '|', '?', '*']) {
    invalid.push(["非法字符 " + symbol, "Local/目录" + symbol, "path 段含 Windows 非法字符：目录" + symbol]);
  }
  for (const [name, input, error] of invalid) {
    await t.test(name, () => assert.deepEqual(treePathSegments(input), { error }));
  }
});
