// 数据探测脚本：实测扶摇、iFinD、DeepSeek 三个外部服务能不能用、返回什么。
// 用法：node scripts/probe.mjs [fuyao|ifind|llm|ifind-call ...]，不带参数时跑前三项。
// Key 从 .env.local 读取，输出里不打印任何 Key；原始响应存到 data/probe-raw/（不进仓库）。

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const rootDir = join(here, "..");
const rawDir = join(rootDir, "data", "probe-raw");
mkdirSync(rawDir, { recursive: true });

function loadEnv(file) {
  const env = {};
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && m[2]) env[m[1]] = m[2];
  }
  return env;
}

const env = loadEnv(join(rootDir, ".env.local"));
const DAY = 86_400_000;
const now = Date.now();
const fmtDate = (ms) => new Date(ms + 8 * 3600_000).toISOString().slice(0, 10);
const fmtTime = (ms) => new Date(ms + 8 * 3600_000).toISOString().slice(0, 16).replace("T", " ");

function save(name, data) {
  writeFileSync(join(rawDir, `${name}.json`), JSON.stringify(data, null, 2));
}

function keysOf(obj) {
  return obj && typeof obj === "object" ? Object.keys(obj).join(", ") : String(obj);
}

// ---------------- 扶摇 ----------------

async function fuyao(name, path, params) {
  const url = `https://fuyao.aicubes.cn${path}?${new URLSearchParams(params)}`;
  const t0 = Date.now();
  try {
    const res = await fetch(url, {
      headers: { "X-api-key": env.FUYAO_API_KEY },
      signal: AbortSignal.timeout(20_000),
    });
    const ms = Date.now() - t0;
    const body = await res.json().catch(() => null);
    save(`fuyao_${name}`, body);
    const data = body?.data;
    const items = data?.item ?? data?.items ?? [];
    const count = Array.isArray(items) ? items.length : "-";
    console.log(
      `[${name}] HTTP ${res.status} code=${body?.code} ${body?.message ?? ""} 条数=${count} 耗时=${ms}ms`,
    );
    return { ok: res.ok && body?.code === 0, data, items: Array.isArray(items) ? items : [] };
  } catch (e) {
    console.log(`[${name}] 请求失败：${e.name} ${e.message}`);
    return { ok: false, data: null, items: [] };
  }
}

async function probeFuyao() {
  console.log("\n===== 扶摇 =====");
  if (!env.FUYAO_API_KEY) return console.log("keys.env 里没有 FUYAO_API_KEY，跳过");

  const code = "600519.SH";
  const start = now - 120 * DAY;

  await fuyao("标的检索", "/api/meta/tickers/search", { q: "贵州茅台", limit: 5 });

  const none = await fuyao("个股日K_不复权", "/api/a-share/prices/historical", {
    thscode: code, interval: "1d", start, end: now, adjust: "none",
  });
  const fwd = await fuyao("个股日K_前复权", "/api/a-share/prices/historical", {
    thscode: code, interval: "1d", start, end: now, adjust: "forward",
  });
  if (none.items.length) {
    const a = none.items[0], b = none.items.at(-1);
    console.log(`  字段：${keysOf(a)}`);
    console.log(`  区间：${fmtDate(a.date_ms)} ~ ${fmtDate(b.date_ms)}，最新收盘(不复权)=${b.close_price}`);
    const f0 = fwd.items[0];
    if (f0) console.log(`  首日收盘：不复权=${a.close_price} 前复权=${f0.close_price}（不同说明期间有除权）`);
  }

  for (const idx of ["000300.SH", "000001.SH", "399006.SZ"]) {
    const r = await fuyao(`指数日K_${idx}`, "/api/a-share-index/prices/historical", {
      thscode: idx, interval: "1d", start, end: now,
    });
    if (r.items.length) console.log(`  ${idx} 最新=${fmtDate(r.items.at(-1).date_ms)} 收盘=${r.items.at(-1).close_price}`);
  }

  const cal = await fuyao("交易日历", "/api/a-share/calendar/trading-days", {});
  if (cal.items.length) console.log(`  ${cal.items[0].date} ~ ${cal.items.at(-1).date}，共 ${cal.items.length} 个交易日`);

  const fin = await fuyao("利润表_季度", "/api/a-share/financials/income-statements", {
    thscode: code, period: "quarterly", limit: 4,
  });
  for (const it of fin.items) {
    console.log(
      `  ${it.fiscal_year} ${it.fiscal_period}：报告期末=${fmtDate(it.period_end_ms)} 披露日=${it.report_date_ms ? fmtDate(it.report_date_ms) : "缺失"}`,
    );
  }

  const ind = await fuyao("行业归属", "/api/a-share-index/constituents/ths-index-list-by-stock", {
    thscode: code, type: "industry",
  });
  if (ind.data) console.log(`  返回结构：${JSON.stringify(ind.data).slice(0, 200)}`);

  // 新闻只能往前翻页，量一下最多能翻回多久以前
  let offset = "first";
  let pages = 0, total = 0, oldest = null;
  while (pages < 10) {
    const r = await fuyao(`个股新闻_第${pages + 1}页`, "/api/news/stock/timeline-list", {
      thscode: code, offset, size: 100,
    });
    if (!r.ok) break;
    pages++;
    total += r.items.length;
    const times = r.items.map((x) => x.publish_time_ms).filter(Boolean);
    if (times.length) oldest = Math.min(...times, oldest ?? Infinity);
    if (!r.data?.has_more || !r.data?.offset) break;
    offset = r.data.offset;
  }
  console.log(`  新闻：翻了 ${pages} 页共 ${total} 条，最早一条 ${oldest ? fmtTime(oldest) : "无"}`);

  const ano = await fuyao("日期范围异动解读", "/api/news/anomaly/analysis", {
    begin_date: fmtDate(now - 364 * DAY), end_date: fmtDate(now), thscode: code,
  });
  if (ano.data) console.log(`  返回结构：${keysOf(ano.data)}；was_truncated=${ano.data.was_truncated}`);
  if (ano.items[0]) console.log(`  样例字段：${keysOf(ano.items[0])}`);

  const hot = await fuyao("热股排名走势", "/api/a-share/special-data/hot-stock-rank-trend", {
    thscode: code, start_date: fmtDate(now - 30 * DAY), end_date: fmtDate(now),
  });
  if (hot.data) console.log(`  返回结构：${JSON.stringify(hot.data).slice(0, 200)}`);

  const lhb = await fuyao("龙虎榜_最近交易日", "/api/a-share/special-data/dragon-tiger-list", {});
  if (lhb.data) console.log(`  返回结构：${keysOf(lhb.data)}`);
}

// ---------------- iFinD（MCP over HTTP） ----------------

async function mcpPost(server, session, payload) {
  const res = await fetch(server.url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...(server.headers ?? {}),
      ...(session ? { "Mcp-Session-Id": session } : {}),
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  let body = null;
  if ((res.headers.get("content-type") ?? "").includes("text/event-stream")) {
    const dataLines = text.split(/\r?\n/).filter((l) => l.startsWith("data:"));
    for (const l of dataLines) {
      try { body = JSON.parse(l.slice(5)); } catch {}
    }
  } else if (text) {
    try { body = JSON.parse(text); } catch { body = text; }
  }
  return { status: res.status, session: res.headers.get("mcp-session-id") ?? session, body };
}

async function probeIfind() {
  console.log("\n===== iFinD MCP =====");
  if (!env.IFIND_MCP_URL || !env.IFIND_MCP_AUTH) return console.log(".env.local 里没有 IFIND_MCP_URL / IFIND_MCP_AUTH，跳过");
  const server = { url: env.IFIND_MCP_URL, headers: { Authorization: env.IFIND_MCP_AUTH } };
  console.log(`  端点主机：${new URL(server.url).host}`);

  try {
    const init = await mcpPost(server, null, {
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "probe", version: "0.1" } },
    });
    console.log(`  initialize：HTTP ${init.status}，服务端=${JSON.stringify(init.body?.result?.serverInfo ?? init.body).slice(0, 150)}`);
    await mcpPost(server, init.session, { jsonrpc: "2.0", method: "notifications/initialized" });
    const list = await mcpPost(server, init.session, { jsonrpc: "2.0", id: 2, method: "tools/list" });
    const tools = list.body?.result?.tools ?? [];
    save("ifind_tools", tools);
    console.log(`  tools/list：HTTP ${list.status}，共 ${tools.length} 个工具`);
    console.log(`  ${tools.map((t) => t.name).join(", ")}`);
    for (const name of ["search_news", "search_notice", "get_stock_events", "get_stock_performance"]) {
      const t = tools.find((x) => x.name === name);
      if (t) console.log(`  [${name}] 参数：${JSON.stringify(t.inputSchema?.properties ?? {}).slice(0, 400)}`);
    }
    // 实际调用会扣免费额度（总共 2000 次），只在显式传 ifind-call 时才调
    if (targets.includes("ifind-call")) {
      const calls = [
        ["search_news", { query: "贵州茅台 一季度业绩", time_start: "2026-04-20", time_end: "2026-04-30", size: 5 }],
        ["search_notice", { query: "贵州茅台 2026年第一季度报告", time_start: "2026-04-20", time_end: "2026-04-30", size: 3 }],
      ];
      let id = 10;
      for (const [name, args] of calls) {
        const r = await mcpPost(server, init.session, {
          jsonrpc: "2.0", id: id++, method: "tools/call", params: { name, arguments: args },
        });
        save(`ifind_call_${name}`, r.body);
        const content = r.body?.result?.content ?? [];
        const text = content.map((c) => c.text ?? "").join("\n");
        console.log(`  [调用 ${name}] HTTP ${r.status}，isError=${r.body?.result?.isError ?? "-"}，返回 ${text.length} 字`);
        console.log(`  ${text.slice(0, 900).replace(/\n/g, "\n  ")}`);
      }
    }
  } catch (e) {
    console.log(`  请求失败：${e.name} ${e.message}`);
  }
}

// ---------------- DeepSeek ----------------

async function probeLlm() {
  console.log("\n===== DeepSeek =====");
  if (!env.DEEPSEEK_API_KEY) return console.log("keys.env 里没有 DEEPSEEK_API_KEY，跳过");
  const headers = { Authorization: `Bearer ${env.DEEPSEEK_API_KEY}`, "Content-Type": "application/json" };
  try {
    const models = await fetch("https://api.deepseek.com/models", { headers, signal: AbortSignal.timeout(20_000) });
    const mb = await models.json().catch(() => null);
    const ids = (mb?.data ?? []).map((m) => m.id);
    console.log(`  /models：HTTP ${models.status}，可用模型=${ids.join(", ") || JSON.stringify(mb).slice(0, 200)}`);
    if (!ids.length) return;
    const t0 = Date.now();
    const chat = await fetch("https://api.deepseek.com/chat/completions", {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: ids.includes("deepseek-chat") ? "deepseek-chat" : ids[0],
        messages: [{ role: "user", content: '只回复 JSON：{"ok": true}' }],
        response_format: { type: "json_object" },
        max_tokens: 800,
      }),
      signal: AbortSignal.timeout(60_000),
    });
    const cb = await chat.json().catch(() => null);
    console.log(`  对话：HTTP ${chat.status}，耗时=${Date.now() - t0}ms，回复=${cb?.choices?.[0]?.message?.content ?? JSON.stringify(cb).slice(0, 200)}`);
  } catch (e) {
    console.log(`  请求失败：${e.name} ${e.message}`);
  }
}

const targets = process.argv.slice(2);
const want = (k) => !targets.length || targets.includes(k);
if (want("fuyao")) await probeFuyao();
if (want("ifind")) await probeIfind();
if (want("llm")) await probeLlm();
