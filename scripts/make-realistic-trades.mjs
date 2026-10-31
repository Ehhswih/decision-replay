// 生成一份接近真实的券商交割单，用来测试导入和复盘的健壮性。
//
// 真实的个人交割单涉及隐私，网上也没有公开样本，所以这里用真实行情 + 真实的券商导出格式来造：
// - 股票、交易日、价格都是真的：每笔成交价都落在当天真实的最低价和最高价之间，遵守 T+1；
// - 交易行为按一个散户的习惯模拟（追涨、补仓摊低、亏了扛着、频繁做波段），用固定种子，结果可复现；
// - 夹杂真实交割单里常见的“脏数据”：银证转账、股息入账、红利税补缴、新股申购和配号、逆回购、ETF、
//   同一委托的分笔成交、东方财富导出的 ="代码" 写法、标题行、GBK 编码、卖出数量为负数。
//
// 用法：node scripts/make-realistic-trades.mjs   （需要 .env.local 里的 FUYAO_API_KEY）
// 输出：tests/fixtures/realistic-ths.csv（同花顺格式，带备注）、tests/fixtures/realistic-eastmoney.csv（东方财富格式，无备注）

import { mkdirSync, writeFileSync } from "node:fs";
import iconv from "iconv-lite";

process.loadEnvFile(".env.local");
const KEY = process.env.FUYAO_API_KEY;
if (!KEY) throw new Error("缺少 FUYAO_API_KEY");

const START = "2026-03-02";
const END = "2026-09-30";
const SH = 8 * 3600_000;
const at = (d, hh = 0, mm = 0) => Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10), hh, mm) - SH;
const ymd = (ms) => new Date(ms + SH).toISOString().slice(0, 10);

// 股票池：不同板块、不同风格
const STOCKS = [
  ["300308.SZ", "中际旭创", "chaser"],
  ["002230.SZ", "科大讯飞", "chaser"],
  ["601138.SH", "工业富联", "chaser"],
  ["300124.SZ", "汇川技术", "dip"],
  ["002050.SZ", "三花智控", "trader"],
  ["688981.SH", "中芯国际", "chaser"],
  ["600519.SH", "贵州茅台", "dip"],
  ["600276.SH", "恒瑞医药", "dip"],
  ["601899.SH", "紫金矿业", "trader"],
  ["000333.SZ", "美的集团", "dip"],
  ["002475.SZ", "立讯精密", "chaser"],
  ["603019.SH", "中科曙光", "chaser"],
];

// 固定种子的随机数，保证每次生成一样
let seed = 20260302;
const rand = () => {
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const pick = (l) => l[Math.floor(rand() * l.length)];
const chance = (p) => rand() < p;

async function bars(code) {
  const qs = new URLSearchParams({ thscode: code, interval: "1d", start: String(at(START)), end: String(at(END, 23, 59)), adjust: "none" });
  const r = await fetch(`https://fuyao.aicubes.cn/api/a-share/prices/historical?${qs}`, { headers: { "X-api-key": KEY } });
  const j = await r.json();
  if (j.code !== 0) throw new Error(`${code} 行情获取失败：${j.message}`);
  return j.data.item.map((b) => ({ date: ymd(b.date_ms), open: b.open_price, high: b.high_price, low: b.low_price, close: b.close_price }));
}

const REASONS = {
  chaser: ["放量突破平台，跟一点", "板块龙头，连续放量", "群里都在聊，先上车", "AI 算力主线，回踩 5 日线进", "突破前高，追", "消息面利好，开盘就买了"],
  dip: ["跌多了，估值到历史低位，分批买", "回调到年线附近，低吸", "业绩稳，跌出来的机会", "超跌反弹，止损8%", "分红率高，拿着吃股息"],
  trader: ["做 T", "日内低吸", "波段低点，止损5%", "跟着板块轮动做一下"],
};
const ADD_REASONS = ["补仓摊低成本", "跌了再补一点", "加仓，趋势还在"];

const fee = (side, amount) => {
  const commission = Math.max(5, +(amount * 0.00025).toFixed(2));
  const stamp = side === "sell" ? +(amount * 0.0005).toFixed(2) : 0;
  const transfer = +(amount * 0.00001).toFixed(2);
  return { commission, stamp, transfer };
};

const priceIn = (b) => +(b.low + rand() * (b.high - b.low)).toFixed(2);
const timeOf = () => {
  const morning = chance(0.62);
  const m = morning ? 9 * 60 + 31 + Math.floor(rand() * 118) : 13 * 60 + 1 + Math.floor(rand() * 115);
  return [Math.floor(m / 60), m % 60, Math.floor(rand() * 60)];
};
const lotOf = (code, cash, px, share) => {
  const step = 100;
  const min = code.startsWith("688") ? 200 : 100;
  const n = Math.floor((cash * share) / px / step) * step;
  return n >= min ? n : 0;
};

const fills = [];
const events = []; // 非买卖记录
let order = 10001;
let cash = 0;

function trade(code, name, side, b, qty, reason) {
  const [hh, mm, ss] = timeOf();
  const id = String(order++);
  // 三成的委托分成 2–3 笔成交
  const parts = chance(0.3) ? (chance(0.5) ? 2 : 3) : 1;
  let left = qty;
  const first = priceIn(b);
  for (let i = 0; i < parts; i++) {
    const q = i === parts - 1 ? left : Math.max(100, Math.round((qty / parts) / 100) * 100);
    left -= q;
    if (q <= 0) break;
    // 同一委托的分笔成交价格只差一点点，仍然落在当天区间内
    const px = i === 0 ? first : +Math.min(b.high, Math.max(b.low, first * (1 + (rand() - 0.5) * 0.004))).toFixed(2);
    const amount = +(q * px).toFixed(2);
    const f = fee(side, amount);
    const total = f.commission + f.stamp + f.transfer;
    cash += side === "buy" ? -(amount + total) : amount - total;
    fills.push({ date: b.date, hh, mm, ss: Math.min(59, ss + i * 3), code, name, side, qty: q, px, amount, ...f, net: +(side === "buy" ? -(amount + total) : amount - total).toFixed(2), cash: +cash.toFixed(2), order: id, reason: i === 0 ? reason : "" });
  }
}

function cashEvent(date, hh, mm, kind, amount, code = "", name = "", qty = 0, px = 0) {
  cash += amount;
  events.push({ date, hh, mm, ss: 0, kind, amount: +amount.toFixed(2), code, name, qty, px, cash: +cash.toFixed(2) });
}

const series = new Map();
for (const [code] of STOCKS) series.set(code, await bars(code));
const days = [...new Set([...series.values()].flatMap((l) => l.map((b) => b.date)))].sort();

cashEvent(days[0], 9, 5, "银行转证券", 300000);
const pos = new Map(); // code -> { qty, cost, day, added, stop, wait }
let lastTrade = new Map();

for (const [di, day] of days.entries()) {
  // 月中再转入一笔、8 月转出一笔
  if (day.startsWith("2026-05") && !events.some((e) => e.kind === "银行转证券" && e.date.startsWith("2026-05"))) cashEvent(day, 9, 12, "银行转证券", 50000);
  if (day.startsWith("2026-08-1") && !events.some((e) => e.kind === "证券转银行")) cashEvent(day, 15, 20, "证券转银行", -80000);
  // 季末、月末闲钱做逆回购（同花顺里显示为“卖出”，代码 204001）
  const monthEnd = days[di + 1] && days[di + 1].slice(5, 7) !== day.slice(5, 7);
  if (monthEnd && cash > 30000) {
    const amt = Math.floor((cash * 0.6) / 1000) * 1000;
    events.push({ date: day, hh: 14, mm: 50, ss: 12, kind: "逆回购", code: "204001", name: "GC001", qty: amt / 100, px: +(1.6 + rand()).toFixed(3), amount: -amt, cash: +(cash - amt).toFixed(2) });
    const next = days[di + 1];
    events.push({ date: next, hh: 9, mm: 0, ss: 0, kind: "逆回购到期", code: "204001", name: "GC001", qty: amt / 100, px: 0, amount: +(amt * 1.00005).toFixed(2), cash: +(cash + amt * 0.00005).toFixed(2) });
    cash += amt * 0.00005;
  }
  // 新股申购和配号
  if (chance(0.025)) {
    events.push({ date: day, hh: 9, mm: 35, ss: 2, kind: "新股申购", code: "787" + String(100 + Math.floor(rand() * 800)), name: "N申购", qty: 5000, px: 0, amount: 0, cash: +cash.toFixed(2) });
    events.push({ date: days[di + 1] ?? day, hh: 9, mm: 0, ss: 0, kind: "申购配号", code: "", name: "", qty: 10, px: 0, amount: 0, cash: +cash.toFixed(2) });
  }

  for (const [code, name, style] of STOCKS) {
    const l = series.get(code);
    const i = l.findIndex((b) => b.date === day);
    if (i < 20) continue;
    const b = l[i];
    const r5 = b.close / l[i - 5].close - 1;
    const hi20 = Math.max(...l.slice(i - 20, i).map((x) => x.high));
    const dd = b.close / hi20 - 1;
    const p = pos.get(code);
    const equity = cash + [...pos.entries()].reduce((a, [c, x]) => a + x.qty * (series.get(c).find((y) => y.date === day)?.close ?? x.cost), 0);

    if (!p) {
      if (pos.size >= 5 || (lastTrade.get(code) ?? -99) > di - 3) continue;
      let go = false;
      if (style === "chaser") go = r5 > 0.12 && chance(0.55);
      if (style === "dip") go = dd < -0.16 && chance(0.4);
      if (style === "trader") go = chance(0.07);
      if (!go) continue;
      const qty = lotOf(code, Math.min(cash, equity), b.close, 0.18 + rand() * 0.1);
      if (!qty) continue;
      const reason = chance(0.45) ? pick(REASONS[style]) : "";
      trade(code, name, "buy", b, qty, reason);
      const stop = /止损(\d+)%/.exec(reason)?.[1];
      pos.set(code, { qty, cost: fills.at(-1).px, day: di, added: false, stop: stop ? +stop : null, wait: chance(0.4) ? 3 + Math.floor(rand() * 6) : 0 });
      lastTrade.set(code, di);
      continue;
    }

    if (p.day >= di) continue; // T+1
    const ret = b.close / p.cost - 1;
    const held = di - p.day;
    let sellQty = 0;
    let reason = "";
    if (style === "trader") {
      if (held >= 2 + Math.floor(rand() * 4) || ret < -0.05) {
        sellQty = p.qty;
        reason = chance(0.4) ? pick(["做 T 卖出", "波段结束", ""]) : "";
      }
    } else if (ret > 0.06 + rand() * 0.06) {
      // 赚一点就跑；一半时候先卖一半
      sellQty = p.qty >= 400 && chance(0.5) ? Math.floor(p.qty / 200) * 100 : p.qty;
      reason = chance(0.5) ? pick(["止盈一半", "到目标了，走", ""]) : "";
    } else if (p.stop && ret < -p.stop / 100) {
      // 写了止损，但有时会拖几天才执行
      if (p.wait > 0) p.wait--;
      else {
        sellQty = p.qty;
        reason = chance(0.6) ? pick(["扛不住了，止损", "止损"]) : "";
      }
    } else if (ret < -0.1 && !p.added && cash > b.close * 300 && chance(0.25)) {
      const qty = lotOf(code, cash, b.close, 0.12);
      if (qty) {
        trade(code, name, "buy", b, qty, chance(0.5) ? pick(ADD_REASONS) : "");
        const c = fills.at(-1).px;
        p.cost = (p.cost * p.qty + c * qty) / (p.qty + qty);
        p.qty += qty;
        p.added = true;
        p.day = di;
      }
      continue;
    } else if (ret < 0 && Math.abs(ret) < 0.02 && held > 15) {
      sellQty = p.qty;
      reason = chance(0.5) ? "回本就走" : "";
    } else if (ret < -0.2 && held > 25) {
      sellQty = p.qty;
      reason = chance(0.6) ? "割肉" : "";
    }
    if (sellQty) {
      trade(code, name, "sell", b, sellQty, reason);
      p.qty -= sellQty;
      if (!p.qty) pos.delete(code);
      lastTrade.set(code, di);
    }
  }
  // 每月 15 日后的第一个交易日定投沪深300ETF
  if (day.slice(8) >= "15" && ["04", "05", "06", "07"].includes(day.slice(5, 7)) && !events.some((e) => e.kind === "ETF买入" && e.date.slice(0, 7) === day.slice(0, 7))) {
    const px = +(3.8 + rand() * 0.4).toFixed(3);
    cash -= 2000 * px + 5;
    events.push({ date: day, hh: 10, mm: 2, ss: 41, kind: "ETF买入", code: "510300", name: "沪深300ETF", qty: 2000, px, amount: -(2000 * px + 5), cash: +cash.toFixed(2) });
  }
  // 持有茅台、美的过除息日时到账股息，之后卖出时补缴红利税（这里只按到账月份粗略模拟）
  if (day === "2026-06-25" && pos.has("600519.SH")) cashEvent(day, 9, 0, "股息入账", +(pos.get("600519.SH").qty * 27.67).toFixed(2), "600519", "贵州茅台");
  if (day === "2026-06-11" && pos.has("000333.SZ")) cashEvent(day, 9, 0, "股息入账", +(pos.get("000333.SZ").qty * 3.5).toFixed(2), "000333", "美的集团");
}

const key = (x) => `${x.date} ${String(x.hh).padStart(2, "0")}:${String(x.mm).padStart(2, "0")}:${String(x.ss).padStart(2, "0")}`;

// 同花顺格式：成交日期 YYYYMMDD、成交时间 HH:MM:SS，操作写“证券买入/证券卖出”，带备注列
const rows = [
  ...fills.map((f) => ({
    t: key(f),
    ths: [f.date.replaceAll("-", ""), `${String(f.hh).padStart(2, "0")}:${String(f.mm).padStart(2, "0")}:${String(f.ss).padStart(2, "0")}`, f.code.slice(0, 6), f.name, f.side === "buy" ? "证券买入" : "证券卖出", f.qty, f.px.toFixed(3), f.amount.toFixed(2), f.net.toFixed(2), f.cash.toFixed(2), f.commission.toFixed(2), f.stamp.toFixed(2), f.transfer.toFixed(2), "0.00", f.order, f.code.endsWith(".SH") ? "A1*****890" : "01*****456", f.reason],
    em: f,
  })),
  ...events.map((e) => {
    const op = e.kind === "逆回购" ? "卖出" : e.kind === "逆回购到期" ? "融券购回" : e.kind === "ETF买入" ? "证券买入" : e.kind;
    const amount = e.kind === "ETF买入" ? +(e.qty * e.px).toFixed(2) : Math.abs(e.amount);
    return {
      t: key(e),
      ths: [e.date.replaceAll("-", ""), `${String(e.hh).padStart(2, "0")}:${String(e.mm).padStart(2, "0")}:${String(e.ss).padStart(2, "0")}`, e.code, e.name, op, e.qty, e.px ? String(e.px) : "0.000", amount.toFixed(2), e.amount.toFixed(2), e.cash.toFixed(2), "0.00", "0.00", "0.00", "0.00", "", "", ""],
      ev: e,
    };
  }),
].sort((a, b) => (a.t < b.t ? -1 : 1));

const csv = (cells) => cells.map((c) => (/[",\n]/.test(String(c)) ? `"${String(c).replaceAll('"', '""')}"` : String(c))).join(",");
const thsHeader = ["成交日期", "成交时间", "证券代码", "证券名称", "操作", "成交数量", "成交均价", "成交金额", "发生金额", "剩余金额", "佣金", "印花税", "过户费", "其他费", "合同编号", "股东帐户", "备注"];
const ths = [csv(thsHeader), ...rows.map((r) => csv(r.ths))].join("\r\n");

// 东方财富格式：标题行、="代码"、成交时间 HHMMSS（9 点多会丢掉前导 0）、卖出数量为负，没有备注
const emHeader = ["成交日期", "成交时间", "证券代码", "证券名称", "买卖标志", "成交数量", "成交价格", "成交金额", "手续费", "印花税", "过户费", "发生金额", "资金余额", "合同编号"];
const em = [
  `查询日期：${START.replaceAll("-", "")}-${END.replaceAll("-", "")}`,
  csv(emHeader),
  ...rows.map((r) => {
    const x = r.em ?? r.ev;
    const time = `${x.hh}${String(x.mm).padStart(2, "0")}${String(x.ss).padStart(2, "0")}`;
    if (r.em) {
      const f = r.em;
      return csv([f.date.replaceAll("-", ""), time, `="${f.code.slice(0, 6)}"`, f.name, f.side === "buy" ? "证券买入" : "证券卖出", f.side === "buy" ? f.qty : -f.qty, f.px.toFixed(2), f.amount.toFixed(2), f.commission.toFixed(2), f.stamp.toFixed(2), f.transfer.toFixed(2), f.net.toFixed(2), f.cash.toFixed(2), f.order]);
    }
    const e = r.ev;
    const flag = e.kind === "逆回购" ? "融券回购" : e.kind === "逆回购到期" ? "融券购回" : e.kind === "ETF买入" ? "证券买入" : e.kind;
    return csv([e.date.replaceAll("-", ""), time, e.code ? `="${e.code}"` : "", e.name, flag, e.qty, e.px || "0.00", Math.abs(e.amount).toFixed(2), "0.00", "0.00", "0.00", e.amount.toFixed(2), e.cash.toFixed(2), ""]);
  }),
].join("\r\n");

mkdirSync("tests/fixtures", { recursive: true });
writeFileSync("tests/fixtures/realistic-ths.csv", iconv.encode(ths, "gbk"));
writeFileSync("tests/fixtures/realistic-eastmoney.csv", iconv.encode(em, "gbk"));
const orders = new Set(fills.map((f) => f.order)).size;
console.log(`成交 ${fills.length} 行（${orders} 笔委托），其他记录 ${events.length} 行，股票 ${new Set(fills.map((f) => f.code)).size} 只，期末持仓 ${pos.size} 只，期末资金 ${cash.toFixed(0)} 元`);
