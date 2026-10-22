// test/lookup.test.mjs —— 阶段一.五：注入式联网查询（引擎零网络、隐私、缓存）
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { userInfo } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildQuery,
  cacheKey,
  contentSignature,
  lookup,
  normalizeResult,
  LABEL,
  REASON_EMPTY,
  REASON_NEEDS_CONFIRM,
  REASON_NO_RESEARCHER,
} from "../src/lookup.mjs";
import { run } from "../src/cli.mjs";
import { createFixture, removeFixture } from "./helpers.mjs";

const ABS = "C:\\Users\\fixture-home\\AppData\\Local\\Ansys";

function machineUser() {
  try {
    return String(userInfo().username || "");
  } catch (err) {
    return "";
  }
}

async function withCache(fn) {
  const dir = await createFixture("lookup-cache", {});
  try {
    return await fn(join(dir, "lookup.json"), dir);
  } finally {
    await removeFixture(dir);
  }
}

test("researcher 为 null：不抛错，只返回建议查询串与原因", async () => {
  await withCache(async (cacheFile) => {
    const outcome = await lookup({
      relPath: "Ansys",
      absPath: ABS,
      childNames: ["ScriptEditor", "Cache"],
      extTop: [["dat", 12], ["dll", 3]],
      researcher: null,
      cache: { file: cacheFile },
    });
    assert.equal(outcome.result, null);
    assert.equal(outcome.reason, REASON_NO_RESEARCHER);
    assert.equal(outcome.safety, "unknown");
    assert.equal(outcome.confidence, "low");
    assert.equal(outcome.label, LABEL);
    assert.equal(outcome.cached, false);
    assert.ok(outcome.query.includes("Ansys"));
    assert.ok(outcome.query.includes("AppData"));
    assert.equal(outcome.relPath, "Ansys");
  });
});

test("查询串不含用户名、盘符与绝对路径", async () => {
  await withCache(async (cacheFile) => {
    const username = machineUser();
    const childNames = ["ScriptEditor", username, "C:\\Windows\\System32"];
    const outcome = await lookup({
      relPath: "Ansys",
      absPath: ABS,
      childNames,
      extTop: [["dat", 7], ["dll", 2]],
      researcher: null,
      cache: { file: cacheFile },
    });
    const query = outcome.query;
    assert.ok(query.startsWith("Ansys"), query);
    assert.equal(/[A-Za-z]:[\\/]/.test(query), false, "不得出现盘符绝对路径：" + query);
    assert.equal(query.includes("\\"), false, query);
    assert.equal(query.includes("/"), false, query);
    assert.equal(/Users\b/i.test(query), false, query);
    assert.equal(query.toLowerCase().includes("fixture-home"), false, query);
    if (username.length > 2) {
      assert.equal(query.toLowerCase().includes(username.toLowerCase()), false, "不得出现用户名：" + query);
    }
    // 构造器本身也要扛得住：absPath 只用于推导目录名
    const direct = buildQuery({ relPath: "", absPath: ABS, childNames: ["zh-CN"], extTop: [["png", 1]] });
    assert.ok(direct.startsWith("Ansys"), direct);
    assert.equal(direct.includes("fixture-home"), false, direct);
  });
});

test("缓存命中时 researcher 不被调用；--force 与签名变化会重新请求", async () => {
  await withCache(async (cacheFile) => {
    let calls = 0;
    const researcher = async (query) => {
      calls += 1;
      return { summary: "归纳结果：" + query, sources: ["https://example.com/ansys"] };
    };
    const base = {
      relPath: "Ansys",
      absPath: ABS,
      childNames: ["ScriptEditor"],
      extTop: [["dat", 3]],
      researcher,
      confirm: true,
      cache: { file: cacheFile },
    };
    const first = await lookup(base);
    assert.equal(calls, 1);
    assert.equal(first.cached, false);
    assert.equal(first.cacheSaved, true);
    assert.deepEqual(first.result.sources, ["https://example.com/ansys"]);
    assert.equal(first.safety, "unknown");
    assert.equal(first.label, LABEL);

    const second = await lookup(base);
    assert.equal(calls, 1, "缓存命中不应再调用 researcher");
    assert.equal(second.cached, true);
    assert.equal(second.result.summary, first.result.summary);

    const forced = await lookup(Object.assign({}, base, { cache: { file: cacheFile, force: true } }));
    assert.equal(calls, 2, "--force 必须绕过缓存");

    const changed = await lookup(Object.assign({}, base, { extTop: [["dat", 4]] }));
    assert.equal(calls, 3, "内容签名变化应视为缓存未命中");

    const stored = JSON.parse(await readFile(cacheFile, "utf8"));
    const keys = Object.keys(stored.entries);
    assert.equal(keys.length, 2);
    assert.ok(keys.some((key) => key.startsWith("ansys::")));
    assert.equal(cacheKey({ relPath: "Ansys", childNames: ["ScriptEditor"], extTop: [["dat", 3]] }), keys.find((key) => key.includes(contentSignature({ relPath: "Ansys", childNames: ["ScriptEditor"], extTop: [["dat", 3]] }))));
  });
});

test("未确认不发送；确认函数返回 true 才调用 researcher", async () => {
  await withCache(async (cacheFile) => {
    let calls = 0;
    const researcher = async () => {
      calls += 1;
      return { summary: "ok", sources: [] };
    };
    const pending = await lookup({ relPath: "X", childNames: [], extTop: [], researcher, cache: { file: cacheFile } });
    assert.equal(calls, 0);
    assert.equal(pending.reason, REASON_NEEDS_CONFIRM);
    assert.equal(pending.needsConfirm, true);
    assert.ok(pending.query.length > 0);

    const seen = [];
    const confirmed = await lookup({
      relPath: "X",
      childNames: [],
      extTop: [],
      researcher,
      cache: { file: cacheFile },
      confirm: (query) => {
        seen.push(query);
        return true;
      },
    });
    assert.deepEqual(seen, [confirmed.query]);
    assert.equal(calls, 1);
    assert.equal(confirmed.reason, null);
  });
});

test("researcher 抛错或返回空都不崩，只记原因且不写缓存", async () => {
  await withCache(async (cacheFile) => {
    const boom = async () => {
      throw new Error("网络不可用");
    };
    const failed = await lookup({ relPath: "Boom", childNames: [], extTop: [], researcher: boom, confirm: true, cache: { file: cacheFile } });
    assert.equal(failed.result, null);
    assert.ok(failed.reason.includes("researcher 调用失败"), failed.reason);
    assert.ok(failed.reason.includes("网络不可用"), failed.reason);

    const empty = await lookup({ relPath: "Empty", childNames: [], extTop: [], researcher: async () => null, confirm: true, cache: { file: cacheFile } });
    assert.equal(empty.result, null);
    assert.equal(empty.reason, REASON_EMPTY);

    const nothing = await readFile(cacheFile, "utf8").catch(() => null);
    assert.equal(nothing, null, "失败不应写入缓存文件");
  });
});

test("normalizeResult 保留来源、区分事实与归纳", () => {
  const result = normalizeResult({
    summary: "模型归纳",
    sources: ["https://a.example", " "],
    facts: [{ text: "检索到的事实", source: "https://a.example" }, { text: "" }],
  });
  assert.equal(result.kind, "模型归纳");
  assert.equal(result.verified, false);
  assert.equal(result.summary, "模型归纳");
  assert.deepEqual(result.sources, ["https://a.example"]);
  assert.equal(result.facts.length, 1);
  assert.equal(result.facts[0].source, "https://a.example");
  assert.ok(result.disclaimer.includes("未经本机验证"));
  assert.equal(normalizeResult(null), null);
  assert.equal(normalizeResult({}), null);
});

test("lookup.mjs 自身不含任何网络代码", async () => {
  const text = await readFile(fileURLToPath(new URL("../src/lookup.mjs", import.meta.url)), "utf8");
  for (const needle of ["fetch(", "node:http", "node:https", "node:net", "node:dgram", "XMLHttpRequest", "axios", "undici", "require("]) {
    assert.equal(text.includes(needle), false, "lookup.mjs 不应出现：" + needle);
  }
});

test("CLI: lookup 只打印查询串，不联网也不崩", async () => {
  const out = [];
  const err = [];
  const target = fileURLToPath(new URL("../src", import.meta.url));
  const ok = await run(["lookup", "--path", target], { write: (text) => out.push(text), writeError: (text) => err.push(text) });
  assert.equal(ok.code, 0);
  const text = out.join("");
  assert.ok(text.includes("将要发送的查询串"), text);
  assert.ok(text.includes("未配置联网能力"), text);
  assert.ok(text.includes(LABEL), text);
  assert.ok(text.includes("隐私"), text);
  assert.equal(/[A-Za-z]:[\\/]/.test(text.split("将要发送的查询串：")[1].split("\n")[0]), false, "查询串里不得出现盘符路径");
  const username = machineUser();
  if (username.length > 2) {
    const queryLine = text.split("将要发送的查询串：")[1].split("\n")[0];
    assert.equal(queryLine.toLowerCase().includes(username.toLowerCase()), false, queryLine);
  }

  const missing = await run(["lookup"], { write: () => {}, writeError: () => {} });
  assert.equal(missing.code, 2);
});
