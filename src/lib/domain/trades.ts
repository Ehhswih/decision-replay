// 成交记录导入：解码（UTF-8 / GBK）、识别常见券商导出的列名、逐行解析。

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
  otherFee: ["其他费用", "其他杂费"],
  reason: ["当时理由", "理由", "备注", "决策理由"],
  planStop: ["计划止损(%)", "计划止损", "止损(%)", "止损"],
  planTarget: ["计划目标(%)", "计划目标", "目标(%)", "目标"],
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

export function parseTradesCsv(text: string): { trades: ParsedTrade[]; issues: Issue[] } {
  const parsed = Papa.parse<Record<string, string>>(text.trim(), { header: true, skipEmptyLines: true });
  const issues: Issue[] = [];
  const trades: ParsedTrade[] = [];
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
  if (issues.length) return { trades, issues };

  parsed.data.forEach((row, i) => {
    const rowNo = i + 2; // 第 1 行是表头
    const err = (field: string, message: string) =>
      issues.push({ severity: "error", code: "bad_value", rowNo, field, message });

    const get = (k: keyof typeof ALIASES) => (cols[k] ? (row[cols[k] as string] ?? "").trim() : "");

    let rawTime = get("datetime");
    const rawDate = get("date");
    if (rawDate && (!rawTime || !normalizeDate(rawTime.split(/\s+/)[0] ?? ""))) {
      rawTime = rawTime ? `${rawDate} ${rawTime}` : rawDate;
    }
    const time = parseShDateTime(rawTime);
    if (!time) return err("成交时间", `无法识别的时间「${rawTime}」`);

    const code = normalizeCode(get("code"));
    if (!code) return err("证券代码", `无法识别的证券代码「${get("code")}」`);

    const side = toSide(get("side"));
    if (!side) return err("买卖方向", `无法识别的买卖方向「${get("side")}」`);

    const price = toNumber(get("price"));
    if (price == null || price <= 0) return err("成交价格", `成交价格不合法「${get("price")}」`);

    const qtyRaw = toNumber(get("qty"));
    if (qtyRaw == null || qtyRaw === 0) return err("成交数量", `成交数量不合法「${get("qty")}」`);

    let fee = toNumber(get("fee"));
    if (fee == null) {
      const parts = (["commission", "stamp", "transfer", "otherFee"] as const).map((k) => toNumber(get(k)) ?? 0);
      fee = parts.reduce((a, b) => a + b, 0);
    }

    const stop = toNumber(get("planStop"));
    const target = toNumber(get("planTarget"));
    if (!time.timeKnown) {
      issues.push({
        severity: "warning",
        code: "time_unknown",
        rowNo,
        field: "成交时间",
        message: "只有日期没有时刻，按 09:30 处理：当天盘中发布的信息都算作事后",
      });
    }

    trades.push({
      rowNo,
      ts: time.ms,
      timeKnown: time.timeKnown,
      code,
      name: get("name") || null,
      side,
      price,
      qty: Math.abs(qtyRaw),
      fee: +Math.abs(fee).toFixed(2),
      reason: get("reason") || null,
      planStop: stop == null ? null : Math.abs(stop),
      planTarget: target == null ? null : Math.abs(target),
    });
  });

  trades.sort((a, b) => a.ts - b.ts || a.rowNo - b.rowNo);
  return { trades, issues };
}
