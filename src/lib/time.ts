// 北京时间工具。所有计算都用 UTC 毫秒加固定 8 小时偏移（中国不实行夏令时），
// 不依赖本机或服务器的时区设置。

export const SH_OFFSET_MS = 8 * 3600_000;
export const DAY_MS = 86_400_000;

function shParts(ms: number) {
  const d = new Date(ms + SH_OFFSET_MS);
  return {
    y: d.getUTCFullYear(),
    m: d.getUTCMonth() + 1,
    d: d.getUTCDate(),
    hh: d.getUTCHours(),
    mm: d.getUTCMinutes(),
  };
}

const pad = (n: number) => String(n).padStart(2, "0");

/** 北京时间日期 YYYY-MM-DD */
export function shDate(ms: number): string {
  const p = shParts(ms);
  return `${p.y}-${pad(p.m)}-${pad(p.d)}`;
}

/** 北京时间 YYYY-MM-DD HH:mm */
export function shDateTime(ms: number): string {
  const p = shParts(ms);
  return `${p.y}-${pad(p.m)}-${pad(p.d)} ${pad(p.hh)}:${pad(p.mm)}`;
}

/** 北京时间当天 0 点起的分钟数 */
export function shMinuteOfDay(ms: number): number {
  const p = shParts(ms);
  return p.hh * 60 + p.mm;
}

/** 某个北京日期的指定时刻 */
export function atShTime(date: string, hh = 0, mm = 0): number {
  const m = date.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) throw new Error(`日期格式不对：${date}`);
  return Date.UTC(+m[1], +m[2] - 1, +m[3], hh, mm) - SH_OFFSET_MS;
}

/** 把 2026-06-22 / 2026/6/22 / 20260622 统一成 YYYY-MM-DD，不合法返回 null */
export function normalizeDate(raw: string): string | null {
  const s = raw.trim();
  const m = s.match(/^(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})日?$/) ?? s.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (!m) return null;
  const [y, mo, d] = [+m[1], +m[2], +m[3]];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  return `${y}-${pad(mo)}-${pad(d)}`;
}

/**
 * 解析成交时间。只有日期时按 09:30 处理并标记 timeKnown=false：
 * 这样只会少算"当时可知"的信息，不会多算。
 */
export function parseShDateTime(raw: string): { ms: number; timeKnown: boolean } | null {
  const s = raw.trim().replace("T", " ");
  const [datePart, timePart] = s.split(/\s+/);
  const date = normalizeDate(datePart ?? "");
  if (!date) return null;
  if (!timePart) return { ms: atShTime(date, 9, 30), timeKnown: false };
  const t = timePart.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/) ?? timePart.match(/^(\d{2})(\d{2})(\d{2})?$/);
  if (!t) return null;
  const hh = +t[1], mm = +t[2];
  if (hh > 23 || mm > 59) return null;
  return { ms: atShTime(date, hh, mm), timeKnown: true };
}

/** YYYY-MM-DD 加减天数 */
export function addDays(date: string, n: number): string {
  return shDate(atShTime(date) + n * DAY_MS);
}

/** YYYY-MM-DD → YYYYMMDD */
export function compactDate(date: string): string {
  return date.replaceAll("-", "");
}

/** 当天收盘（15:00）的时刻，日 K 在这之后才算完整可知 */
export function marketCloseMs(date: string): number {
  return atShTime(date, 15, 0);
}
