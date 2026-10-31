// 用本机的中文声音工作室（D:\AI\local-audio，Breeze TTS 2）逐段生成旁白。
// 用法：node tts.mjs [段 id ...]，不带参数时生成全部；已存在的段跳过（删掉 wav 重新生成）
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const API = "http://127.0.0.1:7865";
const VOICE = "cc0-morning-female"; // 晨光 · 温和女声，CC0
const segments = JSON.parse(readFileSync(join(here, "segments.json"), "utf8"));
const only = process.argv.slice(2);
const out = join(here, "audio");
mkdirSync(out, { recursive: true });
const metaPath = join(out, "durations.json");
const meta = existsSync(metaPath) ? JSON.parse(readFileSync(metaPath, "utf8")) : {};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
for (const s of segments) {
  if (only.length && !only.includes(s.id)) continue;
  const file = join(out, `${s.id}.wav`);
  if (existsSync(file) && meta[s.id] && !only.includes(s.id)) continue;
  const text = s.lines.map((l) => l.say).join("");
  const t0 = Date.now();
  const r = await fetch(`${API}/api/generate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "breeze", voiceId: VOICE, text, emotion: "neutral", emotionStrength: "normal", seed: s.seed ?? 42, instruction: "", deliveryInstruction: "", referenceText: "" }),
  });
  let job = await r.json();
  if (!r.ok) throw new Error(`${s.id}: ${JSON.stringify(job)}`);
  while (job.status === "running") {
    await sleep(1500);
    job = await fetch(`${API}/api/jobs/${job.id}`).then((x) => x.json());
  }
  if (job.status !== "done") throw new Error(`${s.id}: ${job.error ?? job.status}`);
  const wav = Buffer.from(await fetch(API + job.audioUrl).then((x) => x.arrayBuffer()));
  writeFileSync(file, wav);
  meta[s.id] = { duration: job.duration, chars: text.length, warning: job.warning || "" };
  writeFileSync(metaPath, JSON.stringify(meta, null, 2));
  console.log(`${s.id}  ${job.duration.toFixed(2)}s  ${text.length} 字  ${(text.length / job.duration).toFixed(1)} 字/秒  生成 ${((Date.now() - t0) / 1000).toFixed(0)}s ${job.warning ? "⚠ " + job.warning : ""}`);
}
