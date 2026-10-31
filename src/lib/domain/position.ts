// 持仓计算和成交校验：按时间顺序处理成交和除权除息事件，切出持仓段。

import { atShTime, compactDate, shDate, shDateTime, shMinuteOfDay } from "@/lib/time";
import type { Bar, CorpAction, Episode, EpisodeCorpEvent, Issue, Trade } from "./types";

const PRICE_TOLERANCE = 0.005;

export function isStar(code: string) {
  return /^68[89]/.test(code);
}

function isBeijing(code: string) {
  return code.endsWith(".BJ");
}

function inSession(ms: number) {
  const m = shMinuteOfDay(ms);
  return (m >= 9 * 60 + 25 && m <= 11 * 60 + 30) || (m >= 13 * 60 && m <= 15 * 60);
}

export interface MarketContext {
  /** 交易日集合（YYYY-MM-DD）；拿不到日历时为 null，跳过交易日校验 */
  tradingDays: Set<string> | null;
  /** 代码 → 日期 → 不复权日 K；某只股票拿不到行情时没有这个键 */
  bars: Map<string, Map<string, Bar>>;
}

/** 单笔成交和行情、日历、交易规则的比对 */
export function validateTrades(trades: Trade[], ctx: MarketContext): Issue[] {
  const issues: Issue[] = [];
  for (const t of trades) {
    const date = shDate(t.ts);
    const base = { rowNo: t.rowNo, tradeId: t.id };

    if (ctx.tradingDays && !ctx.tradingDays.has(date)) {
      issues.push({ ...base, severity: "error", code: "not_trading_day", field: "成交时间", message: `${date} 不是 A 股交易日` });
      continue;
    }
    if (t.timeKnown && !inSession(t.ts)) {
      issues.push({
        ...base,
        severity: "warning",
        code: "outside_session",
        field: "成交时间",
        message: `${shDateTime(t.ts)} 不在交易时段（09:25–11:30、13:00–15:00）内`,
      });
    }

    const series = ctx.bars.get(t.code);
    const bar = series?.get(date);
    if (!series) {
      issues.push({ ...base, severity: "warning", code: "bars_unavailable", field: "成交价格", message: "没取到这只股票的行情，无法核对成交价" });
    } else if (!bar) {
      issues.push({ ...base, severity: "warning", code: "bar_missing", field: "成交价格", message: `缺少 ${date} 的行情（可能停牌或数据缺失），无法核对成交价` });
    } else if (t.price < bar.low - PRICE_TOLERANCE || t.price > bar.high + PRICE_TOLERANCE) {
      issues.push({
        ...base,
        severity: "error",
        code: "price_out_of_range",
        field: "成交价格",
        message: `成交价 ${t.price} 不在当日不复权最低价 ${+bar.low.toFixed(3)} ~ 最高价 ${+bar.high.toFixed(3)} 之间，可能是录入错误或用了复权价`,
      });
    }

    if (t.side === "buy") {
      const star = isStar(t.code);
      const ok = star ? t.qty >= 200 && Number.isInteger(t.qty) : isBeijing(t.code) ? t.qty >= 100 && Number.isInteger(t.qty) : t.qty % 100 === 0;
      if (!ok) {
        issues.push({
          ...base,
          severity: "warning",
          code: "lot_size",
          field: "成交数量",
          message: star ? "科创板买入至少 200 股" : "买入数量应为 100 股的整数倍",
        });
      }
    }
  }
  return issues;
}

function episodeId(code: string, openTs: number) {
  return `${code}-${compactDate(shDate(openTs))}${shDateTime(openTs).slice(11).replace(":", "")}`;
}

function emptyEpisode(t: Trade): Episode {
  return {
    id: episodeId(t.code, t.ts),
    code: t.code,
    name: t.name,
    openTs: t.ts,
    closeTs: null,
    trades: [],
    corpEvents: [],
    buyCost: 0,
    sellProceeds: 0,
    dividends: 0,
    fees: 0,
    realizedPnl: null,
    returnPct: null,
    maxPosition: 0,
  };
}

/**
 * 切持仓段。除权日 0 点之前持有的股票按每股送转增加股数、按每股分红记现金（税前）。
 * 卖出超过持仓时记错误，并截断到持仓数量，不让后续计算跑飞。
 */
export function buildEpisodes(
  trades: Trade[],
  actions: Map<string, CorpAction[]>,
): { episodes: Episode[]; issues: Issue[] } {
  const issues: Issue[] = [];
  const episodes: Episode[] = [];
  const byCode = new Map<string, Trade[]>();
  for (const t of trades) byCode.set(t.code, [...(byCode.get(t.code) ?? []), t]);

  for (const [code, list] of byCode) {
    const sorted = [...list].sort((a, b) => a.ts - b.ts || a.rowNo - b.rowNo);
    const acts = [...(actions.get(code) ?? [])].sort((a, b) => a.exDate.localeCompare(b.exDate));
    let position = 0;
    let current: Episode | null = null;
    let ai = 0;

    const applyActionsBefore = (ts: number) => {
      while (ai < acts.length && atShTime(acts[ai].exDate) <= ts) {
        const a = acts[ai++];
        if (position <= 0 || !current) continue;
        const bonusShares = Math.floor(position * a.bonusPerShare);
        const cashReceived = +(position * a.cashPerShare).toFixed(2);
        const ev: EpisodeCorpEvent = { ...a, sharesBefore: position, bonusShares, cashReceived };
        current.corpEvents.push(ev);
        current.dividends += cashReceived;
        position += bonusShares;
        current.maxPosition = Math.max(current.maxPosition, position);
      }
    };

    for (const t of sorted) {
      applyActionsBefore(t.ts);
      if (t.side === "buy") {
        if (position === 0) current = emptyEpisode(t);
        const ep = current as Episode;
        position += t.qty;
        ep.buyCost += t.price * t.qty + t.fee;
        ep.fees += t.fee;
        ep.maxPosition = Math.max(ep.maxPosition, position);
        ep.trades.push({ ...t, positionAfter: position });
        continue;
      }

      if (position === 0 || !current) {
        issues.push({ severity: "error", code: "sell_without_position", rowNo: t.rowNo, tradeId: t.id, field: "成交数量", message: "卖出时没有持仓（之前的买入记录可能不在这次导入的文件里）" });
        continue;
      }
      let qty = t.qty;
      if (qty > position) {
        const bonus = current.corpEvents.reduce((s, e) => s + e.bonusShares, 0);
        issues.push({
          severity: "error",
          code: "sell_exceeds_position",
          rowNo: t.rowNo,
          tradeId: t.id,
          field: "成交数量",
          message: `卖出 ${t.qty} 股，超过当时持仓 ${position} 股${bonus ? `（已计入期间送转的 ${bonus} 股）` : ""}，按持仓数量计算`,
        });
        qty = position;
      }
      position -= qty;
      current.sellProceeds += t.price * qty - t.fee;
      current.fees += t.fee;
      current.trades.push({ ...t, qty, positionAfter: position });
      if (position === 0) {
        current.closeTs = t.ts;
        current.realizedPnl = +(current.sellProceeds + current.dividends - current.buyCost).toFixed(2);
        current.returnPct = +((current.realizedPnl / current.buyCost) * 100).toFixed(2);
        episodes.push(current);
        current = null;
      }
    }
    if (current) {
      applyActionsBefore(Date.now());
      episodes.push(current);
    }
  }

  episodes.sort((a, b) => a.openTs - b.openTs);
  return { episodes, issues };
}
