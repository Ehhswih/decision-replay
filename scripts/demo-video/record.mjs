// 录制演示视频：无头 Edge + Chrome DevTools 协议，逐帧截取画面并记录每段旁白的开始时间。
// 用法：node record.mjs [--dry]   --dry 只在关键位置截图，不录帧
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const DRY = process.argv.includes("--dry");
const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const BASE = "http://49.234.35.196";
const W = 1440, H = 810, DPR = 4 / 3;
const TEMPO = 0.94; // 合成时旁白放慢到 94%
const PORT = 9333;

const segments = JSON.parse(readFileSync(join(here, "segments.json"), "utf8"));
const durations = JSON.parse(readFileSync(join(here, "audio", "durations.json"), "utf8"));
const outDir = join(here, DRY ? "dry" : "frames");
rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => performance.now();

// ---------------- 启动浏览器、连接 CDP ----------------
const profile = mkdtempSync(join(tmpdir(), "dr-rec-"));
const edge = spawn(EDGE, [
  "--headless=new", `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, "--window-size=1600,1000", "--force-device-scale-factor=1.3333333",
  "--hide-scrollbars", "--mute-audio", "--no-first-run", "--no-default-browser-check", "--disable-extensions",
  "--disable-features=Translate,msEdgeSidebarV2,EdgeCollections", "--lang=zh-CN", "about:blank",
], { stdio: "ignore" });

let target;
for (let i = 0; i < 50 && !target; i++) {
  await sleep(200);
  try {
    const list = await fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => r.json());
    target = list.find((t) => t.type === "page");
  } catch {}
}
if (!target) throw new Error("连不上无头 Edge");

const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
let seq = 0;
const pending = new Map();
const listeners = new Map();
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    const { resolve, reject } = pending.get(m.id);
    pending.delete(m.id);
    m.error ? reject(new Error(`${m.error.message}`)) : resolve(m.result);
  } else if (m.method) for (const fn of listeners.get(m.method) ?? []) fn(m.params);
};
const send = (method, params = {}) => new Promise((resolve, reject) => { const id = ++seq; pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params })); });
const on = (method, fn) => listeners.set(method, [...(listeners.get(method) ?? []), fn]);

async function js(expr) {
  const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(`页面脚本出错：${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}\n${expr.slice(0, 200)}`);
  return r.result.value;
}
async function waitFor(expr, timeout = 30000, label = expr) {
  const t0 = now();
  while (now() - t0 < timeout) {
    if (await js(`!!(${expr})`).catch(() => false)) return;
    await sleep(150);
  }
  throw new Error(`等待超时：${label}`);
}

// ---------------- 页面上的光标、字幕、高亮、片头片尾 ----------------
const OVERLAY = String.raw`(() => {
  if (window.__rec) return;
  const R = (window.__rec = {});
  const mount = () => {
    if (document.getElementById("__rec_root")) return;
    const root = document.createElement("div");
    root.id = "__rec_root";
    root.innerHTML = '<style>' +
      '#__rec_root{position:fixed;inset:0;pointer-events:none;z-index:2147483647;font-family:"PingFang SC","Microsoft YaHei UI","Microsoft YaHei",system-ui,sans-serif}' +
      '#__cur{position:fixed;left:0;top:0;width:26px;height:26px;transform:translate(-200px,-200px);transition:none;filter:drop-shadow(0 2px 3px rgba(0,0,0,.35))}' +
      '.__rip{position:fixed;width:16px;height:16px;margin:-8px 0 0 -8px;border-radius:50%;border:3px solid #2b4de0;opacity:.9;animation:__rip .55s ease-out forwards}' +
      '@keyframes __rip{to{transform:scale(3.4);opacity:0}}' +
      '#__sub{position:fixed;left:50%;bottom:30px;transform:translateX(-50%);max-width:1120px;width:max-content;padding:11px 26px;border-radius:14px;background:rgba(15,23,41,.86);color:#fff;font-size:23px;line-height:1.55;letter-spacing:.02em;text-align:center;opacity:0;transition:opacity .25s}' +
      '#__sub.on{opacity:1}' +
      '.__hl{position:fixed;border:3px solid #2b4de0;border-radius:12px;box-shadow:0 0 0 7px rgba(43,77,224,.16);opacity:0;transition:opacity .3s}' +
      '.__hl.on{opacity:1}' +
      '#__card{position:fixed;inset:0;background:#f3f5f8;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:18px;color:#0f1729;opacity:0;transition:opacity .5s}' +
      '#__card.on{opacity:1}' +
      '#__card .t{font-size:64px;font-weight:600;letter-spacing:.04em}' +
      '#__card .s{font-size:26px;color:#4b5567}' +
      '#__card .cut{width:2px;height:64px;background:#2b4de0;border-radius:2px}' +
      '#__card .u{font-size:22px;color:#2b4de0;font-family:Bahnschrift,"DIN Alternate",sans-serif}' +
      '#__card .n{position:absolute;bottom:40px;font-size:16px;color:#7a8394}' +
      '</style>' +
      '<svg id="__cur" viewBox="0 0 24 24"><path d="M4 2 L4 19 L8.6 14.6 L11.6 21.4 L14.4 20.2 L11.4 13.5 L18 13.5 Z" fill="#fff" stroke="#0f1729" stroke-width="1.6" stroke-linejoin="round"/></svg>' +
      '<div id="__sub"></div><div id="__card"></div>';
    document.documentElement.appendChild(root);
    const cur = root.querySelector("#__cur");
    addEventListener("mousemove", (e) => { cur.style.transform = "translate(" + (e.clientX - 4) + "px," + (e.clientY - 2) + "px)"; }, { capture: true, passive: true });
    addEventListener("mousedown", (e) => {
      const r = document.createElement("div");
      r.className = "__rip"; r.style.left = e.clientX + "px"; r.style.top = e.clientY + "px";
      root.appendChild(r); setTimeout(() => r.remove(), 700);
    }, { capture: true, passive: true });
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mount); else mount();
  const $ = (id) => document.getElementById(id);
  R.sub = (text) => { const el = $("__sub"); if (!el) return; if (!text) { el.classList.remove("on"); return; } el.textContent = text; el.classList.add("on"); };
  R.card = (html) => { const el = $("__card"); if (!el) return; if (!html) { el.classList.remove("on"); return; } el.innerHTML = html; el.classList.add("on"); };
  R.hl = (rects) => {
    document.querySelectorAll(".__hl").forEach((x) => { x.classList.remove("on"); setTimeout(() => x.remove(), 320); });
    for (const r of rects || []) {
      const d = document.createElement("div"); d.className = "__hl";
      const p = 6;
      Object.assign(d.style, { left: r.x - p + "px", top: r.y - p + "px", width: r.w + 2 * p + "px", height: r.h + 2 * p + "px" });
      $("__rec_root").appendChild(d); requestAnimationFrame(() => requestAnimationFrame(() => d.classList.add("on")));
    }
  };
  const visible = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== "hidden"; };
  // 按文字找元素：完全相同优先，取文字最短（最内层）的那个
  R.find = (text, sel = "*", exact = true) => {
    let best = null;
    for (const el of document.body.querySelectorAll(sel)) {
      const t = (el.textContent || "").replace(/\s+/g, " ").trim();
      if (!(exact ? t === text : t.includes(text)) || !visible(el)) continue;
      if (!best || t.length < (best.textContent || "").trim().length || best.contains(el)) best = el;
    }
    return best;
  };
  R.rect = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; };
  R.union = (els) => { const rs = els.filter(Boolean).map((e) => e.getBoundingClientRect()); if (!rs.length) return null; const x = Math.min(...rs.map((r) => r.left)), y = Math.min(...rs.map((r) => r.top)); return { x, y, w: Math.max(...rs.map((r) => r.right)) - x, h: Math.max(...rs.map((r) => r.bottom)) - y }; };
  // 平滑滚动：把元素顶部滚到视口的 at 比例处
  R.scrollTo = (y, ms = 900) => new Promise((res) => {
    const y0 = scrollY, y1 = Math.max(0, Math.min(y, document.documentElement.scrollHeight - innerHeight)), t0 = performance.now();
    if (Math.abs(y1 - y0) < 2) return res();
    const step = (t) => { const k = Math.min(1, (t - t0) / ms), e = k < .5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2; scrollTo(0, y0 + (y1 - y0) * e); k < 1 ? requestAnimationFrame(step) : res(); };
    requestAnimationFrame(step);
  });
  R.scrollToEl = (el, at = 0.18, ms = 900) => el ? R.scrollTo(scrollY + el.getBoundingClientRect().top - innerHeight * at, ms) : Promise.resolve();
  R.heading = (text) => [...document.querySelectorAll("h1,h2,h3")].find((h) => h.textContent.trim().startsWith(text) && visible(h));
  R.section = (text) => R.heading(text)?.closest("section") ?? null;
})();`;

// ---------------- 鼠标和键盘 ----------------
let mx = W * 0.62, my = H * 0.55;
async function moveTo(x, y, ms = 650) {
  const x0 = mx, y0 = my, steps = Math.max(8, Math.round(ms / 16));
  // 轻微弧线，像人手移动
  const cx = (x0 + x) / 2 + (y - y0) * 0.12, cy = (y0 + y) / 2 - (x - x0) * 0.08;
  for (let i = 1; i <= steps; i++) {
    const k = i / steps, e = k < .5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
    const px = (1 - e) * (1 - e) * x0 + 2 * (1 - e) * e * cx + e * e * x;
    const py = (1 - e) * (1 - e) * y0 + 2 * (1 - e) * e * cy + e * e * y;
    await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: px, y: py });
    await sleep(ms / steps);
  }
  mx = x; my = y;
}
async function click(x, y) {
  await moveTo(x, y);
  await sleep(120);
  await send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
  await sleep(70);
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
  await sleep(200);
}
async function typeText(text, cps = 9) {
  for (const ch of text) {
    await send("Input.insertText", { text: ch });
    await sleep(1000 / cps + Math.random() * 40);
  }
}
async function key(k, code = k) {
  await send("Input.dispatchKeyEvent", { type: "keyDown", key: k, code, windowsVirtualKeyCode: k === "Escape" ? 27 : 0 });
  await send("Input.dispatchKeyEvent", { type: "keyUp", key: k, code, windowsVirtualKeyCode: k === "Escape" ? 27 : 0 });
}
// el 是返回元素的页面表达式；不在视口里时先平滑滚动
async function rectOf(el) {
  return js(`__rec.rect(${el})`);
}
async function ensureVisible(el, at = 0.4) {
  const r = await rectOf(el);
  if (!r) throw new Error(`找不到元素：${el}`);
  if (r.y < 70 || r.y + r.h > H - 130) await js(`__rec.scrollToEl(${el}, ${at})`);
  return rectOf(el);
}
async function clickEl(el, opts = {}) {
  const r = await ensureVisible(el, opts.at);
  await click(r.x + r.w * (opts.fx ?? 0.5), r.y + r.h * (opts.fy ?? 0.5));
}
async function hoverEl(el, ms = 650) {
  const r = await ensureVisible(el);
  await moveTo(r.x + r.w / 2, r.y + r.h / 2, ms);
}
// 点击后把光标停到左侧留白处，不挡住内容
const rest = (y = H * 0.55) => moveTo(52, y, 700);
const hl = (els) => js(`__rec.hl([${els.join(",")}].map((e) => __rec.rect(e)).filter(Boolean))`);
const hlRects = (expr) => js(`__rec.hl(${expr})`);
const unhl = () => js("__rec.hl([])");

// ---------------- 录帧 ----------------
const frames = [];
let recording = false;
let firstFrameAt = 0;
on("Page.screencastFrame", async (p) => {
  send("Page.screencastFrameAck", { sessionId: p.sessionId }).catch(() => {});
  if (!recording) return;
  if (!frames.length) firstFrameAt = now();
  const name = `f${String(frames.length).padStart(5, "0")}.jpg`;
  writeFileSync(join(outDir, name), Buffer.from(p.data, "base64"));
  frames.push({ name, t: p.metadata.timestamp });
});
let shotNo = 0;
async function shot(label) {
  if (!DRY) return;
  const r = await send("Page.captureScreenshot", { format: "jpeg", quality: 80 });
  writeFileSync(join(outDir, `${String(++shotNo).padStart(2, "0")}-${label}.jpg`), Buffer.from(r.data, "base64"));
}

// ---------------- 初始化页面 ----------------
await send("Page.enable");
await send("Runtime.enable");
await send("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: DPR, mobile: false });
await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "light" }, { name: "prefers-reduced-motion", value: "no-preference" }] });
await send("Page.addScriptToEvaluateOnNewDocument", { source: OVERLAY });
await send("Page.navigate", { url: BASE + "/" });
await waitFor(`document.readyState === "complete" && window.__rec && __rec.find("看示例组合", "button")`, 30000, "首页");
await sleep(1500);
await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: mx, y: my });

// ---------------- 分段脚本 ----------------
const segById = Object.fromEntries(segments.map((s) => [s.id, s]));
const segStarts = {};
let recStart = 0;
const subTimers = [];
// 长句按逗号、冒号拆成不超过一行的字幕，句末的逗号、句号去掉
function chunks(text, max = 26) {
  const parts = text.length <= max + 3 ? [text] : text.split(/(?<=[，：；])/);
  const out = [];
  let cur = "";
  for (const p of parts) {
    if (cur && (cur + p).length > max) { out.push(cur); cur = p; } else cur += p;
  }
  if (cur) out.push(cur);
  return out.map((c) => c.replace(/[，；：。]$/, ""));
}
function scheduleSubs(id) {
  const s = segById[id];
  const total = (durations[id].duration / TEMPO) * 1000;
  const chars = s.lines.map((l) => l.say.length);
  const sum = chars.reduce((a, b) => a + b, 0);
  let acc = 0;
  s.lines.forEach((l, i) => {
    const lineAt = 150 + (acc / sum) * total, lineLen = (chars[i] / sum) * total;
    acc += chars[i];
    const cs = chunks(l.sub), clen = cs.reduce((a, c) => a + c.length, 0);
    let cacc = 0;
    for (const c of cs) {
      const at = lineAt + (cacc / clen) * lineLen;
      cacc += c.length;
      subTimers.push(setTimeout(() => js(`__rec.sub(${JSON.stringify(c)})`).catch(() => {}), at));
    }
  });
  subTimers.push(setTimeout(() => js(`__rec.sub("")`).catch(() => {}), 150 + total + 250));
}
async function segment(id, actions, tail = 500) {
  const t0 = now();
  segStarts[id] = (t0 - recStart) / 1000;
  scheduleSubs(id);
  await actions();
  const wait = t0 + 150 + (durations[id].duration / TEMPO) * 1000 + tail - now();
  if (wait > 0) await sleep(wait);
  console.log(`${id}  开始 ${segStarts[id].toFixed(2)}s  用时 ${((now() - t0) / 1000).toFixed(1)}s（旁白 ${(durations[id].duration / TEMPO).toFixed(1)}s）`);
}
// 段内按旁白进度等待：等到本段开始后第 sec 秒
const until = (id, sec) => sleep(Math.max(0, recStart + segStarts[id] * 1000 + sec * 1000 - now()));
// 第 line 句旁白（按字数比例估算，和字幕用同一套时间）开始的时刻；frac 是句内进度，lead 是提前量
function cueAt(id, line, frac = 0) {
  const s = segById[id], total = durations[id].duration / TEMPO;
  const chars = s.lines.map((l) => l.say.length), sum = chars.reduce((a, b) => a + b, 0);
  const acc = chars.slice(0, line).reduce((a, b) => a + b, 0);
  return 0.15 + ((acc + frac * chars[line]) / sum) * total;
}
const untilCue = (id, line, frac = 0, lead = 0) => until(id, cueAt(id, line, frac) - lead);

if (!DRY) await send("Page.startScreencast", { format: "jpeg", quality: 85, maxWidth: 2600, maxHeight: 1600, everyNthFrame: 1 });
// 片头：先显示再开始录，开头不会闪一下首页
await js(`__rec.card('<div class="t">决策回放</div><div class="cut"></div><div class="s">投资决策复盘与学习 · 产品演示</div>')`);
await sleep(700);
recording = !DRY;
recStart = now();
await shot("title");
await sleep(2600);
await js(`__rec.card(null)`);
await sleep(600);

await segment("s01-home", async () => {
  await moveTo(W * 0.3, H * 0.33, 1400);
  await shot("home");
  await until("s01-home", 5.5);
  await moveTo(W * 0.74, H * 0.45, 1300);
  await until("s01-home", 9);
  await moveTo(W * 0.42, H * 0.52, 1000);
});

await segment("s02-demo", async () => {
  await hl([`__rec.find("导入我的成交 CSV", "label")`]);
  await hoverEl(`__rec.find("导入我的成交 CSV", "label")`, 700);
  await shot("import-hl");
  await untilCue("s02-demo", 0, 0.6);
  await unhl();
  await clickEl(`__rec.find("看示例组合", "button")`);
  await waitFor(`location.pathname === "/decisions" && __rec.heading("持仓时间轴")`, 60000, "我的决策");
  await sleep(600);
  await hl([`__rec.find("示例组合（构造数据）", "a")`]);
  await shot("decisions");
  await sleep(2600);
  await unhl();
});

await segment("s03-list", async () => {
  // 指标带：页面标题下面的第一块 panel
  await hlRects(`[__rec.rect(document.querySelector("main .panel"))].filter(Boolean)`);
  await moveTo(W * 0.5, H * 0.42, 900);
  await shot("metrics");
  await untilCue("s03-list", 1, 0, 0.9);
  await unhl();
  await js(`__rec.scrollToEl(__rec.section("持仓时间轴"), 0.08, 1100)`);
  await sleep(300);
  await hoverEl(`[...__rec.section("持仓时间轴").querySelectorAll("a")].find((a) => a.textContent.includes("兆易创新"))`, 900);
  await shot("timeline-hover");
});

await segment("s04-then", async () => {
  await clickEl(`[...__rec.section("持仓时间轴").querySelectorAll("a")].find((a) => a.textContent.includes("兆易创新"))`);
  await waitFor(`location.pathname.startsWith("/decisions/") && __rec.find("收益已遮住") && document.querySelector("canvas")`, 60000, "兆易创新");
  await sleep(900);
  await hl([`__rec.find("收益已遮住")`, `__rec.find("决策之后的行情和事件已遮住", "*", false)`]);
  await shot("then");
  await untilCue("s04-then", 1, 0, 0.6);
  await unhl();
  await js(`__rec.scrollToEl(__rec.heading("2026-06-22 14:41 下单时"), 0.12, 1000)`);
  await sleep(200);
  await hl([`__rec.find("当时理由", "dt")?.nextElementSibling`]);
  await shot("reason");
  await untilCue("s04-then", 2, 0, 0.2);
  await unhl();
  await hl([`__rec.find("当时理由", "dt")?.closest("section")?.querySelector("ul")`]);
  await shot("signals");
  await untilCue("s04-then", 2, 0.55, 0.8);
  await unhl();
  await js(`__rec.scrollToEl(__rec.find("理由里没提到的负面信息（当时可知，且和买入逻辑相关）", "h3"), 0.3, 900)`);
  await sleep(200);
  await hl([`__rec.find("理由里没提到的负面信息（当时可知，且和买入逻辑相关）", "h3")?.parentElement`]);
  await shot("negatives");
}, 300);

await segment("s05-sell", async () => {
  await unhl();
  await js(`__rec.scrollTo(0, 900)`);
  await clickEl(`__rec.find("决策点 3", "button")`);
  await waitFor(`__rec.find("卖出前的计划", "dt")`, 15000, "卖出决策点");
  await rest(H * 0.4);
  await hl([`__rec.find("07-20 卖出", "button")`]);
  await shot("sell");
  await untilCue("s05-sell", 1, 0, 0.4);
  await unhl();
  await js(`__rec.scrollToEl(__rec.find("卖出前的计划", "dt")?.closest("section"), 0.1, 1000)`);
  await sleep(200);
  await hl([`__rec.find("卖出前的计划", "dt")?.closest("section")?.querySelector("ul")`]);
  await shot("sell-signals");
  await untilCue("s05-sell", 2, 0, 0.6);
  await unhl();
  await js(`__rec.scrollTo(0, 900)`);
  await hlRects(`[__rec.rect(document.querySelector("canvas")?.closest(".panel"))].filter(Boolean)`);
  await shot("sell-chart");
}, 300);

await segment("s06-judge", async () => {
  await unhl();
  await js(`__rec.scrollToEl(__rec.heading("揭晓之前，先写下你的判断"), 0.12, 1100)`);
  await sleep(300);
  await clickEl(`__rec.find("理由有缺口", "button")`);
  await clickEl(`__rec.section("揭晓之前，先写下你的判断").querySelector("textarea")`);
  await typeText("止损线早就跌破了，一直拖着没卖", 8);
  await shot("judge");
  await untilCue("s06-judge", 1, 0.6);
  await clickEl(`__rec.find("保存，然后揭晓", "button")`);
  await waitFor(`__rec.heading("揭晓前后对照")`, 20000, "揭晓");
  await rest();
});

await segment("s07-reveal", async () => {
  await js(`__rec.scrollToEl(__rec.heading("揭晓前后对照"), 0.1, 900)`);
  await sleep(200);
  await hl([`__rec.section("揭晓前后对照")`]);
  await shot("before-after");
  await untilCue("s07-reveal", 1, 0, 0.5);
  await unhl();
  // 规则命中和问题归类都在「过程和结果」里，整句旁白都停在这里
  await js(`__rec.scrollToEl(__rec.heading("过程和结果"), 0.08, 1000)`);
  await sleep(200);
  await hl([`__rec.section("过程和结果")`]);
  await shot("quadrant");
}, 300);

await segment("s08-evidence", async () => {
  await unhl();
  const chip = `document.querySelector('button[title^="止损线"]')`;
  await clickEl(chip, { at: 0.45 });
  await waitFor(`document.querySelector('[role="dialog"]')`, 8000, "证据抽屉");
  await sleep(700);
  await hlRects(`[__rec.rect(document.querySelector('[role="dialog"]'))].filter(Boolean)`);
  await moveTo(W - 260, H * 0.8, 900);
  await shot("evidence");
  await until("s08-evidence", 7.2);
  await unhl();
  await key("Escape");
  await sleep(500);
}, 200);

await segment("s09-lesson", async () => {
  await js(`__rec.scrollToEl(__rec.heading("下次可以做什么"), 0.12, 1000)`);
  await sleep(200);
  for (let i = 0; i < 3; i++) {
    const btn = `[...__rec.section("下次可以做什么").querySelectorAll("button")].filter((b) => b.textContent.trim() === "加入我的清单")[0]`;
    if (!(await js(`!!(${btn})`))) break;
    await clickEl(btn);
    await sleep(350);
  }
  await moveTo(W * 0.62, H * 0.93, 600);
  await shot("lessons");
  await sleep(500);
}, 300);

await segment("s10-precheck", async () => {
  await js(`__rec.scrollTo(0, 700)`);
  await clickEl(`[...document.querySelectorAll("header a")].find((a) => a.textContent.trim() === "决策前检查")`);
  await waitFor(`location.pathname === "/precheck" && document.querySelector("#q")`, 20000, "决策前检查");
  await sleep(400);
  await clickEl(`document.querySelector("#q")`);
  await typeText("宁德时代", 6);
  await clickEl(`document.querySelector("#reason")`);
  await typeText("储能订单放量，回调后想买入", 10);
  await clickEl(`document.querySelector("#stop")`);
  await typeText("8", 4);
  await sleep(300);
  await clickEl(`__rec.find("开始检查", "button")`);
  await moveTo(W * 0.2, H * 0.93, 700);
  await waitFor(`!__rec.find("正在取最新行情和公告……", "button") && __rec.heading("现在能看到的事实")`, 60000, "检查结果");
  await sleep(500);
  const res = `[...document.querySelectorAll("main section.panel")].find((s) => s.querySelector("h2")?.textContent.includes("宁德时代"))`;
  await js(`__rec.scrollToEl(${res}, 0.1, 900)`);
  await sleep(200);
  await hl([res]);
  await shot("precheck");
  await until("s10-precheck", 16.5);
  await unhl();
}, 300);

await segment("s11-end", async () => {
  await js(`__rec.card('<div class="t">决策回放</div><div class="cut"></div><div class="u">http://49.234.35.196</div><div class="u">github.com/Ehhswih/decision-replay</div><div class="n">示例组合为构造数据，股票和行情真实；旁白为 AI 合成语音</div>')`);
  await shot("end");
}, 1500);

recording = false;
await send("Page.stopScreencast").catch(() => {});
const recEnd = now();
subTimers.forEach(clearTimeout);
// 视频从第一帧开始；旁白的开始时间要减去第一帧相对录制开始的延迟
const videoOffset = DRY ? 0 : (firstFrameAt - recStart) / 1000;
const total = (recEnd - recStart) / 1000 - videoOffset;
writeFileSync(join(here, DRY ? "dry-timeline.json" : "timeline.json"), JSON.stringify({ segStarts, videoOffset, total, frames: frames.length }, null, 2));
if (!DRY) {
  // ffmpeg concat 清单：每帧显示到下一帧出现，最后一帧显示到录制结束
  const lines = [];
  frames.forEach((f, i) => {
    const next = i + 1 < frames.length ? frames[i + 1].t : frames[0].t + total;
    lines.push(`file '${f.name}'`, `duration ${Math.max(0.001, next - f.t).toFixed(4)}`);
  });
  lines.push(`file '${frames[frames.length - 1].name}'`);
  writeFileSync(join(outDir, "frames.txt"), lines.join("\n"));
}
console.log(`录制结束：${total.toFixed(1)}s，${frames.length} 帧`);
ws.close();
edge.kill();
await sleep(500);
rmSync(profile, { recursive: true, force: true });
process.exit(0);
