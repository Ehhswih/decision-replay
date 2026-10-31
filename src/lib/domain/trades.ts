// 成交记录导入：解码（UTF-8 / GBK）、识别常见券商导出的列名、逐行解析。
// 真实的交割单里夹着很多不是股票买卖的记录（银证转账、股息、新股申购、逆回购、ETF……），
// 这些按“跳过”处理并说明原因，不算错误；同一委托的分笔成交合并成一笔。

import Papa from "papaparse";
import iconv from "iconv-lite";
import { parseShDateTime, normalizeDate } from "@/lib/time";
import type { Issue, Side, Trade } from "./types";

export type ParsedTrade = Omit<Trade, "id">;

/** 券商导出的 CSV 常见是 GBK；先按 UTF-8 严格解码，失败再按 GBK */
export function decodeCsv(bytes: Uint8Array): { text: string; encoding: "utf-8" | "gbk" } {
  let buf = bytes;
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) buf = buf.subarray(3);
  try {
    return { text: new TextDecoder("utf-8", { fatal: true }).decode(buf), encoding: "utf-8" };
  } catch {
    return { text: iconv.decode(Buffer.from(buf), "gbk"), encoding: "gbk" };
  }
}

/** 600519 → 600519.SH；已带后缀的统一成大写 */
export function normalizeCode(raw: string): string | null {
  const s = raw.trim().toUpperCase().replace(/^(SH|SZ|BJ)(\d{6})$/, "$2.$1");
  const m = s.match(/^(\d{6})(?:\.(SH|SZ|BJ))?$/);
  if (!m) return null;
  if (m[2]) return `${m[1]}.${m[2]}`;
  const c = m[1];
  if (/^(60|68|90)/.test(c)) return `${c}.SH`;
  if (/^(00|30|20)/.test(c)) return `${c}.SZ`;
  if (/^(4|8|92)/.test(c)) return `${c}.BJ`;
  return null;
}

/** 交割单里的代码可能写成 ="002594"、'002594、2594（Excel 吃掉了前导 0）或 600519.0 */
export function cleanCode(raw: string): string {
  let s = raw.trim().replace(/^="?|"$/g, "").replace(/^'/, "").trim();
  if (/^\d+\.0+$/.test(s)) s = s.replace(/\.0+$/, "");
  if (/^\d{1,5}$/.test(s)) s = s.padStart(6, "0");
  return s;
}

/**
 * 不是 A 股股票的品种：逆回购、ETF 和基金、债券和可转债、B 股、新股申购代码。
 * 只看 6 位代码；返回中文类别，股票返回 null。
 */
export function nonStockKind(code6: string, name = ""): string | null {
  if (/^(GC|R-|RC)\d/i.test(name) || /^(204|131)/.test(code6)) return "逆回购";
  if (/ETF|LOF|基金/i.test(name) || /^(5\d|15|16|18)/.test(code6)) return "ETF 或基金";
  if (/转债|国债|债/.test(name) || /^(01|02|10|11|12|13)/.test(code6)) return "债券或可转债";
  if (/^(900|200)/.test(code6)) return "B 股";
  if (/^7\d/.test(code6) || /申购|配号/.test(name)) return "新股申购";
  return null;
}

/** 操作列里这些业务不是股票买卖：转账、分红送转、申购配号、回购、质押、理财等 */
const NON_TRADE = /转账|银行转|转银行|银证|股息|红利|利息|配号|申购|中签|新股入账|红股|送股|转增|配股|托管|指定|撤销|冻结|解冻|质押|回购|购回|权证|余额|理财|赎回|分红|扣税|补缴|划入|划出|入账|出账|调整|撤单/;

const ALIASES: Record<string, string[]> = {
  datetime: ["成交时间", "交易时间", "时间"],
  date: ["成交日期", "交易日期", "日期", "发生日期"],
  code: ["证券代码", "股票代码", "代码"],
  name: ["证券名称", "股票名称", "名称"],
  side: ["买卖方向", "买卖标志", "操作", "方向", "业务名称", "委托类别"],
  price: ["成交价格", "成交均价", "成交价", "价格"],
  qty: ["成交数量", "成交股数", "数量"],
  fee: ["手续费", "交易费用", "费用合计"],
  commission: ["佣金"],
  stamp: ["印花税"],
  transfer: ["过户费"],
  otherFee: ["其他费用", "其他杂费", "其他费"],
  reason: ["当时理由", "理由", "备注", "决策理由"],
  planStop: ["计划止损(%)", "计划止损", "止损(%)", "止损"],
  planTarget: ["计划目标(%)", "计划目标", "目标(%)", "目标"],
  orderId: ["合同编号", "委托编号", "委托序号"],
};

function resolveColumns(headers: string[]) {
  const clean = headers.map((h) => h.replace(/^﻿/, "").trim());
  const map: Partial<Record<keyof typeof ALIASES, string>> = {};
  for (const [key, names] of Object.entries(ALIASES)) {
    const hit = names.find((n) => clean.includes(n));
    if (hit) map[key as keyof typeof ALIASES] = headers[clean.indexOf(hit)];
  }
  return map;
}

/** 有些导出在表头前面还有“查询日期：……”之类的标题行：找到第一行同时有代码列和买卖列的作为表头 */
function dropTitleRows(text: string): { text: string; skipped: number } {
  const lines = text.split(/\r?\n/);
  const isHeader = (l: string) => ALIASES.code.some((n) => l.includes(n)) && ALIASES.side.some((n) => l.includes(n));
  const at = lines.slice(0, 10).findIndex(isHeader);
  return at > 0 ? { text: lines.slice(at).join("\n"), skipped: at } : { text, skipped: 0 };
}

function toNumber(v: unknown): number | null {
  if (v == null) return null;
  const s = String(v).replace(/[,，%\s元股]/g, "");
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function toSide(v: string): Side | null {
  const s = v.trim().toUpperCase();
  if (/买|^B$|BUY/.test(s)) return "buy";
  if (/卖|^S$|SELL/.test(s)) return "sell";
  return null;
}

/** 没有计划列时，从备注里读“止损8%”“目标+15%”“止盈 20%” */
function planFromText(text: string): { stop: number | null; target: number | null } {
  const stop = text.match(/止损\s*[:：]?\s*[-－]?\s*(\d+(?:\.\d+)?)\s*[%％]/)?.[1];
  const target = text.match(/(?:目标|止盈)\s*[:：]?\s*[+＋]?\s*(\d+(?:\.\d+)?)\s*[%％]/)?.[1];
  return { stop: stop ? +stop : null, target: target ? +target : null };
}

type Row = ParsedTrade & { orderId: string | null };

/** 同一委托的分笔成交合并成一笔：数量相加、价格按成交量加权、费用相加 */
function mergeFills(rows: Row[], issues: Issue[]): ParsedTrade[] {
  const groups = new Map<string, Row[]>();
  for (const r of rows) {
    // 有合同编号按编号；没有的按“同一只、同方向、同一分钟”
    const day = new Date(r.ts).toISOString().slice(0, 10);
    const key = r.orderId ? `o:${day}:${r.orderId}:${r.code}:${r.side}` : `t:${r.ts}:${r.code}:${r.side}`;
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  const out: ParsedTrade[] = [];
  for (const g of groups.values()) {
    const first: ParsedTrade = { ...g[0] };
    delete (first as Partial<Row>).orderId;
    if (g.length === 1) {
      out.push(first);
      continue;
    }
    const qty = g.reduce((a, r) => a + r.qty, 0);
    const price = +(g.reduce((a, r) => a + r.price * r.qty, 0) / qty).toFixed(4);
    out.push({
      ...first,
      ts: Math.min(...g.map((r) => r.ts)),
      timeKnown: g.every((r) => r.timeKnown),
      qty,
      price,
      fee: +g.reduce((a, r) => a + r.fee, 0).toFixed(2),
      reason: g.map((r) => r.reason).find(Boolean) ?? null,
      planStop: g.map((r) => r.planStop).find((x) => x != null) ?? null,
      planTarget: g.map((r) => r.planTarget).find((x) => x != null) ?? null,
    });
    issues.push({
      severity: "info",
      code: "fills_merged",
      message: `第 ${g.map((r) => r.rowNo).join("、")} 行是同一笔委托的 ${g.length} 笔成交，合并为一笔（${qty} 股，均价 ${+price.toFixed(3)}）`,
    });
  }
  return out;
}

export function parseTradesCsv(input: string): { trades: ParsedTrade[]; issues: Issue[] } {
  const { text, skipped: titleRows } = dropTitleRows(input.trim());
  const parsed = Papa.parse<Record<string, string>>(text, { header: true, skipEmptyLines: true });
  const issues: Issue[] = [];
  const rows: Row[] = [];
  const cols = resolveColumns(parsed.meta.fields ?? []);

  const required: [keyof typeof ALIASES, string][] = [
    ["code", "证券代码"],
    ["side", "买卖方向"],
    ["price", "成交价格"],
    ["qty", "成交数量"],
  ];
  for (const [k, label] of required) {
    if (!cols[k]) issues.push({ severity: "error", code: "missing_column", message: `缺少「${label}」列` });
  }
  if (!cols.datetime && !cols.date) {
    issues.push({ severity: "error", code: "missing_column", message: "缺少「成交时间」或「成交日期」列" });
  }
  if (issues.length) return { trades: [], issues };

  const skippedKinds = new Map<string, number[]>();
  const skip = (kind: string, rowNo: number) => skippedKinds.set(kind, [...(skippedKinds.get(kind) ?? []), rowNo]);

  parsed.data.forEach((row, i) => {
    const rowNo = i + 2 + titleRows; // 第 1 行是表头
    const err = (field: string, message: string) => issues.push({ severity: "error", code: "bad_value", rowNo, field, message });
    const get = (k: keyof typeof ALIASES) => (cols[k] ? (row[cols[k] as string] ?? "").trim() : "");

    const sideText = get("side");
    const name = get("name");
    const code6 = cleanCode(get("code"));
    // 先排除不是股票买卖的记录：这些不算错误
    if (NON_TRADE.test(sideText) && !/证券买入|证券卖出|^买入$|^卖出$/.test(sideText)) return skip(sideText, rowNo);
    if (/^\d{6}$/.test(code6)) {
      const kind = nonStockKind(code6, name);
      if (kind) return skip(kind, rowNo);
    } else if (!code6 && !toSide(sideText)) {
      return skip(sideText || "空白行", rowNo);
    }

    let rawTime = get("datetime");
    const rawDate = get("date");
    if (rawDate && (!rawTime || !normalizeDate(rawTime.split(/\s+/)[0] ?? ""))) {
      rawTime = rawTime ? `${rawDate} ${rawTime}` : rawDate;
    }
    const time = parseShDateTime(rawTime);
    if (!time) return err("成交时间", `无法识别的时间「${rawTime}」`);

    const code = normalizeCode(code6);
    if (!code) return err("证券代码", `无法识别的证券代码「${get("code")}」`);

    const side = toSide(sideText);
    if (!side) return err("买卖方向", `无法识别的买卖方向「${sideText}」`);

    const price = toNumber(get("price"));
    const qtyRaw = toNumber(get("qty"));
    if (qtyRaw === 0) return skip("成交数量为 0", rowNo);
    if (price == null || price <= 0) return err("成交价格", `成交价格不合法「${get("price")}」`);
    if (qtyRaw == null) return err("成交数量", `成交数量不合法「${get("qty")}」`);

    let fee = toNumber(get("fee"));
    if (fee == null) {
      const parts = (["commission", "stamp", "transfer", "otherFee"] as const).map((k) => toNumber(get(k)) ?? 0);
      fee = parts.reduce((a, b) => a + b, 0);
    }

    const reason = get("reason") || null;
    let stop = toNumber(get("planStop"));
    let target = toNumber(get("planTarget"));
    if (reason && stop == null && target == null) {
      const p = planFromText(reason);
      if (p.stop != null || p.target != null) {
        stop = p.stop;
        target = p.target;
        issues.push({
          severity: "info",
          code: "plan_from_note",
          rowNo,
          message: `从备注「${reason}」里读出${[p.stop != null ? `止损 ${p.stop}%` : "", p.target != null ? `目标 +${p.target}%` : ""].filter(Boolean).join("、")}`,
        });
      }
    }
    if (!time.timeKnown) {
      issues.push({
        severity: "warning",
        code: "time_unknown",
        rowNo,
        field: "成交时间",
        message: "只有日期没有时刻，按 09:30 处理：当天盘中发布的信息都算作事后",
      });
    }

    rows.push({
      rowNo,
      ts: time.ms,
      timeKnown: time.timeKnown,
      code,
      name: name || null,
      side,
      price,
      qty: Math.abs(qtyRaw),
      fee: +Math.abs(fee).toFixed(2),
      reason,
      planStop: stop == null ? null : Math.abs(stop),
      planTarget: target == null ? null : Math.abs(target),
      orderId: get("orderId") || null,
    });
  });

  for (const [kind, rowNos] of skippedKinds) {
    const list = rowNos.length > 6 ? `${rowNos.slice(0, 6).join("、")} 等 ${rowNos.length} 行` : `${rowNos.join("、")} 行`;
    issues.push({ severity: "info", code: "skipped", message: `跳过「${kind}」：第 ${list}，不是 A 股股票的买卖，不参与复盘` });
  }

  const trades = mergeFills(rows, issues);
  trades.sort((a, b) => a.ts - b.ts || a.rowNo - b.rowNo);
  return { trades, issues };
}
