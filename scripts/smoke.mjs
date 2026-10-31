// 接口冒烟测试：对运行中的服务（本地或线上）跑主链路、导入异常、合规边界。
// 用法：node scripts/smoke.mjs [base_url]，默认 http://localhost:3000
// 示例组合的复盘需要先生成（scripts/pregenerate.sh），否则复盘相关的检查会被跳过。

const BASE = (process.argv[2] ?? "http://localhost:3000").replace(/\/$/, "");
let cookie = "";
const results = [];

async function req(path, init = {}) {
  const res = await fetch(BASE + path, { ...init, headers: { ...(init.headers ?? {}), ...(cookie ? { cookie } : {}) }, redirect: "manual" });
  const set = res.headers.getSetCookie?.() ?? [];
  for (const c of set) {
    const [kv] = c.split(";");
    const [k, v] = kv.split("=");
    const jar = Object.fromEntries(cookie.split("; ").filter(Boolean).map((x) => x.split("=")));
    if (/expires=Thu, 01 Jan 1970|max-age=0/i.test(c) || v === "") delete jar[k];
    else jar[k] = v;
    cookie = Object.entries(jar).map(([a, b]) => `${a}=${b}`).join("; ");
  }
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: res.status, json, text };
}

async function check(name, fn) {
  const t0 = Date.now();
  try {
    const note = await fn();
    results.push({ name, ok: true, ms: Date.now() - t0, note: note ?? "" });
    console.log(`PASS  ${name}${note ? `（${note}）` : ""}  ${Date.now() - t0}ms`);
  } catch (e) {
    results.push({ name, ok: false, ms: Date.now() - t0, note: e.message });
    console.log(`FAIL  ${name}：${e.message}`);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const BANNED = /建议(?:买入|卖出|加仓|减仓|清仓|持有|抄底)|目标价\s*\d|必涨|必跌|稳赚|保本|满仓|梭哈|(?:将|会)(?:继续)?(?:上涨|下跌)/;

function csvFile(text, name = "trades.csv") {
  const form = new FormData();
  form.append("file", new Blob([text], { type: "text/csv" }), name);
  return form;
}

console.log(`冒烟测试：${BASE}\n`);

// ---------- 主链路 ----------
await check("首页可访问", async () => {
  const r = await req("/");
  assert(r.status === 200 && r.text.includes("决策回放"), `HTTP ${r.status}`);
});

await check("健康检查", async () => {
  const r = await req("/api/health");
  assert(r.json?.ok, JSON.stringify(r.json));
  return `SQLite ${r.json.sqlite}`;
});

let episodes = [];
await check("示例组合：切出持仓段并给出规则结果", async () => {
  await req("/api/workspace", { method: "DELETE" });
  const r = await req("/api/rules");
  assert(r.status === 200, `HTTP ${r.status}`);
  episodes = r.json.episodes;
  assert(episodes.length >= 10, `只有 ${episodes.length} 个持仓段`);
  assert(r.json.issues.filter((i) => i.severity === "error").length === 0, "示例组合不应有校验错误");
  assert(episodes.every((e) => e.attribution?.quadrant), "有持仓段缺少过程/结果评级");
  assert(episodes.every((e) => typeof e.holdDays === "number"), "有持仓段缺少持有天数");
  const b4 = r.json.portfolio.find((p) => p.ruleId === "B4");
  assert(b4?.outcome === "hit", "处置效应应命中");
  return `${episodes.length} 段，B4 ${b4.finding.slice(0, 30)}…`;
});

const zy = () => episodes.find((e) => e.episode.code === "603986.SH");
await check("证据：每条都带时点信息，关键数据源正常", async () => {
  const id = zy().episode.id;
  const r = await req(`/api/episodes/${encodeURIComponent(id)}/evidence?slim=1`);
  assert(r.status === 200, `HTTP ${r.status}`);
  const items = r.json.items;
  assert(items.length > 50, `证据只有 ${items.length} 条`);
  assert(items.every((e) => "availableAt" in e && (e.precision === "ms" || e.precision === "day")), "有证据缺少可知时间或精度");
  assert(items.every((e) => e.source && e.status), "有证据缺少来源或状态");
  const critical = r.json.sources.filter((s) => s.critical && s.status === "failed");
  assert(!critical.length, `关键数据源失败：${critical.map((s) => s.label).join("、")}`);
  return `${items.length} 条证据`;
});

await check("规则：兆易创新命中追涨和偏离计划，归类为没做好", async () => {
  const e = zy();
  const hits = new Set(e.biases.filter((b) => b.outcome === "hit").map((b) => b.ruleId));
  assert(hits.has("B1") && hits.has("B7"), `命中的规则：${[...hits].join(",")}`);
  assert(e.attribution.errorType === "execution", e.attribution.errorType);
});

await check("复盘：当时视角匿名生成、输出经过校验、不含建议和预测", async () => {
  const r = await req(`/api/episodes/${encodeURIComponent(zy().episode.id)}/review`);
  if (r.json?.status !== "done") return "示例复盘还没生成，跳过";
  const doc = r.json.review;
  assert(doc.exAnte.length === 2 && doc.exAnte.every((v) => v.anonymized), "当时视角应有 2 次且都匿名");
  assert(Array.isArray(doc.validationLog), "缺少校验日志");
  const text = JSON.stringify([doc.exAnte, doc.expost, doc.lessons]);
  assert(!BANNED.test(text), `出现违规表述：${text.match(BANNED)?.[0]}`);
  for (const v of doc.exAnte) for (const c of [...v.supporting, ...v.warnings]) assert(c.evidenceIds.length > 0, `当时视角有结论没有引用：${c.text}`);
  return `${doc.usage.calls} 次模型调用，校验日志 ${doc.validationLog.length} 条`;
});

await check("示例组合只读：访客不能重新生成已有的复盘", async () => {
  const id = encodeURIComponent(zy().episode.id);
  const before = await req(`/api/episodes/${id}/review`);
  if (before.json?.status !== "done") return "示例复盘还没生成，跳过";
  const r = await req(`/api/episodes/${id}/review?force=1`, { method: "POST" });
  assert(r.json.status === "done" && r.json.review.generatedAt === before.json.review.generatedAt, "示例复盘被访客重新生成了");
});

await check("全部示例复盘不含买卖建议、目标价和涨跌预测", async () => {
  let n = 0;
  for (const e of episodes) {
    const r = await req(`/api/episodes/${encodeURIComponent(e.episode.id)}/review`);
    if (r.json?.status !== "done") continue;
    n++;
    const t = JSON.stringify([r.json.review.exAnte, r.json.review.expost, r.json.review.lessons]);
    assert(!BANNED.test(t), `${e.episode.name}：${t.match(BANNED)?.[0]}`);
  }
  return `检查了 ${n} 份复盘`;
});

await check("清单：加入、停用、删除", async () => {
  const add = await req("/api/checklist", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: "冒烟测试条目", trigger: "chase" }) });
  assert(add.status === 200 && add.json.id, `加入失败 HTTP ${add.status}`);
  const id = add.json.id;
  const off = await req(`/api/checklist/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ enabled: false }) });
  assert(off.json.items.find((x) => x.id === id)?.enabled === false, "停用失败");
  const del = await req(`/api/checklist/${id}`, { method: "DELETE" });
  assert(!del.json.items.some((x) => x.id === id), "删除失败");
});

await check("决策前检查：按名称识别股票，返回检查结果和事实", async () => {
  const r = await req("/api/precheck", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ query: "宁德时代", side: "buy", reason: "钠电池放量", planStop: 8 }) });
  assert(r.status === 200 && r.json.code === "300750.SZ", JSON.stringify(r.json).slice(0, 200));
  assert(r.json.checks.length > 0 && r.json.facts.length > 0, "缺少检查结果或事实");
  assert(r.json.adviceNotice === null, "普通理由不应弹出合规提示");
  assert(r.json.checks.find((c) => c.trigger === "plan")?.status === "clear", "写了止损时计划检查应通过");
});

// ---------- 合规边界 ----------
await check("合规：问\"能不能买\"时只给固定说明，不给建议", async () => {
  const r = await req("/api/precheck", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ query: "300750", side: "buy", reason: "现在能不能买？会不会涨？" }) });
  assert(r.json.adviceNotice?.includes("不判断现在能不能买卖"), "没有合规说明");
  assert(!BANNED.test(JSON.stringify(r.json)), "返回内容出现违规表述");
  assert(r.json.checks.find((c) => c.trigger === "plan")?.status === "triggered", "没写止损时计划检查应触发");
});

await check("决策前检查：查不到的股票给出明确错误", async () => {
  const r = await req("/api/precheck", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ query: "不存在的股票ZZZ", side: "buy", reason: "" }) });
  assert(r.status === 404 && r.json.error?.includes("没有找到"), `HTTP ${r.status} ${JSON.stringify(r.json)}`);
});

// ---------- 导入异常 ----------
await check("导入：缺少必需列时拒绝并说明缺哪一列", async () => {
  const r = await req("/api/import", { method: "POST", body: csvFile("证券代码,成交价格\n600519,1400\n") });
  assert(r.status === 400 && r.json.issues.some((i) => i.code === "missing_column"), JSON.stringify(r.json));
  return r.json.issues.map((i) => i.message).join("；");
});

await check("导入：空文件拒绝", async () => {
  const r = await req("/api/import", { method: "POST", body: csvFile("") });
  assert(r.status === 400, `HTTP ${r.status}`);
});

await check("导入：非交易日、价格越界、卖出超过持仓、坏值、只有日期，逐条指出", async () => {
  const csv = [
    "成交时间,证券代码,证券名称,买卖方向,成交价格,成交数量,手续费,当时理由",
    "2026-06-19 10:00,688256,寒武纪,买入,1500,200,5,端午节当天", // 非交易日
    "2026-06-18 14:30,688256,寒武纪,买入,1700,200,5,价格高于当日最高价",
    "2026-06-22 10:00,688256,寒武纪,卖出,1465,500,5,卖得比持仓多",
    "2026-06-23,688256,寒武纪,买入,1450,200,5,只有日期",
    "2026-06-24 10:00,688256,寒武纪,买入,abc,200,5,价格坏值",
  ].join("\n");
  const r = await req("/api/import", { method: "POST", body: csvFile(csv) });
  assert(r.status === 200 && r.json.ok, `导入失败 ${JSON.stringify(r.json).slice(0, 200)}`);
  const parseCodes = r.json.issues.map((i) => i.code);
  assert(parseCodes.includes("bad_value") && parseCodes.includes("time_unknown"), `解析问题：${parseCodes}`);
  const rules = await req("/api/rules");
  const codes = rules.json.issues.map((i) => i.code);
  for (const c of ["not_trading_day", "price_out_of_range", "sell_exceeds_position"]) assert(codes.includes(c), `没有指出 ${c}，实际：${codes}`);
  return `解析 ${parseCodes.join("/")}；校验 ${[...new Set(codes)].join("/")}`;
});

await check("导入：GBK 编码的券商导出（列名不同）能识别", async () => {
  const text = "成交日期,成交时间,证券代码,证券名称,操作,成交均价,成交数量,佣金,印花税,过户费\n20260708,10:35:00,601127,赛力斯,证券买入,58.2,2000,29.1,0,0.58\n20260714,09:45:00,601127,赛力斯,证券卖出,53.3,2000,26.65,53.3,0.53\n";
  // 手工编码成 GBK（只含常用汉字，用 TextDecoder 无法编码，这里借助 iconv-lite）
  const iconv = (await import("iconv-lite")).default;
  const form = new FormData();
  form.append("file", new Blob([iconv.encode(text, "gbk")], { type: "text/csv" }), "broker.csv");
  const r = await req("/api/import", { method: "POST", body: form });
  assert(r.json.ok && r.json.encoding === "gbk" && r.json.imported === 2, JSON.stringify(r.json));
  const rules = await req("/api/rules");
  assert(rules.json.episodes.length === 1 && rules.json.issues.filter((i) => i.severity === "error").length === 0, "GBK 导入后应有 1 个持仓段且无错误");
});

await check("隐私：一键删除导入的数据并回到示例组合", async () => {
  const before = await req("/api/workspace");
  assert(!before.json.isDemo && before.json.retentionDays === 7, "导入后应在自己的工作区，保留 7 天");
  const d = await req("/api/workspace?purge=1", { method: "DELETE" });
  assert(d.json.purged === 2, `应删除 2 笔成交，实际 ${d.json.purged}`);
  const w = await req("/api/workspace");
  assert(w.json.isDemo, "没有回到示例组合");
  return `删除 ${d.json.purged} 笔`;
});

await check("数据状态：配置齐全、iFinD 额度未用完", async () => {
  const r = await req("/api/status");
  const c = r.json.config;
  assert(c.fuyao && c.deepseek && c.ifind, `配置缺失：${JSON.stringify(c)}`);
  assert(r.json.ifind.remaining > 0, "iFinD 额度用完");
  return `iFinD 已用 ${r.json.ifind.used}/${r.json.ifind.limit}`;
});

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
process.exit(failed.length ? 1 : 0);
