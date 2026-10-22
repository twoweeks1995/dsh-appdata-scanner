// test/cli.test.mjs —— scan -> report -> plan 全流程（使用夹具 home，不碰真实 AppData）
import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { writeFile } from "node:fs/promises";

import { run } from "../src/cli.mjs";
import { createFixture, removeFixture } from "./helpers.mjs";

async function call(argv) {
  const out = [];
  const err = [];
  const result = await run(argv, { write: (text) => out.push(text), writeError: (text) => err.push(text) });
  return { code: result.code, out: out.join(""), err: err.join("") };
}

test("scan -> report -> plan 全流程可用（无知识库时靠启发式）", async () => {
  const home = await createFixture("cli-home", {
    "AppData/Local/CacheFace/Cache/blob.bin": 2 * 1024 * 1024,
    "AppData/Local/CacheFace/index.json": "{}",
    "AppData/Local/PlainBits/data.txt": "hello",
    "AppData/Local/PlainBits/sub/notes.md": "notes",
    "AppData/Local/Store/settings.db": "db",
    "AppData/Roaming/LogOnly/app.log": "log line",
    "AppData/LocalLow/Vendor/UnityPlayer.log": "unity",
  });
  try {
    const scanned = await call(["scan", "--home", home, "--roots", "local,roaming,locallow", "--min-mb", "0"]);
    assert.equal(scanned.code, 0);
    assert.ok(scanned.err.includes("开始扫描"));
    const doc = JSON.parse(scanned.out);
    assert.equal(doc.roots.length, 3);
    assert.ok(doc.roots.every((root) => root.exists));
    const names = doc.entries.map((entry) => entry.relPath).sort();
    assert.deepEqual(names, ["CacheFace", "LogOnly", "PlainBits", "Store", "Vendor"]);
    assert.equal(doc.phase, "scan-only");

    const scanPath = join(home, "scan.json");
    await writeFile(scanPath, JSON.stringify(doc), "utf8");

    const reported = await call(["report", "--input", scanPath, "--no-knowledge", "--format", "table"]);
    assert.equal(reported.code, 0);
    assert.ok(reported.out.includes("可安全删除"));
    assert.ok(reported.out.includes("└ "), "混合目录必须输出 children 拆分");
    assert.ok(reported.out.includes("LOW") === false);

    const planned = await call(["plan", "--input", scanPath, "--no-knowledge"]);
    assert.equal(planned.code, 0);
    assert.ok(planned.out.includes("powershell -NoProfile -Command"));
    assert.ok(planned.out.includes("SendToRecycleBin"));
    assert.ok(planned.out.includes("绝不执行"));
    assert.ok(planned.out.includes("目标路径："));
    assert.ok(planned.out.includes(join(home, "AppData", "Local", "CacheFace")));

    const safeOnly = await call(["plan", "--input", scanPath, "--no-knowledge", "--safe-only", "--format", "table"]);
    assert.equal(safeOnly.code, 0);
    assert.ok(safeOnly.out.includes("目标路径"));

    const asJson = await call(["report", "--input", scanPath, "--no-knowledge", "--format", "json"]);
    const payload = JSON.parse(asJson.out);
    assert.equal(payload.entries.length, 5);
    assert.ok(payload.summary);
  } finally {
    await removeFixture(home);
  }
});

test("缺少 --input 时报错但进程不崩", async () => {
  const failed = await call(["report"]);
  assert.equal(failed.code, 1);
  assert.ok(failed.err.includes("--input"));
});

test("未知命令返回退出码 2 并打印用法", async () => {
  const unknown = await call(["nope"]);
  assert.equal(unknown.code, 2);
  assert.ok(unknown.err.includes("用法"));
  const noCommand = await call([]);
  assert.equal(noCommand.code, 2);
  assert.ok(noCommand.out.includes("用法"));
});

test("--roots 非法取值被拒绝", async () => {
  const bad = await call(["scan", "--roots", "local,nowhere"]);
  assert.equal(bad.code, 2);
  assert.ok(bad.err.includes("--roots"));
});
