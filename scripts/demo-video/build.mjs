// 把录下的帧和旁白合成 1080p 视频：裁出左上角的 1920×1080 视口，尺寸异常的过渡帧用前一帧代替，旁白按录制时记下的时间放
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const fr = join(here, "frames");
const sizeOf = (f) => {
  const b = readFileSync(join(fr, f));
  const i = b.indexOf(Buffer.from([0xff, 0xc0]));
  return `${b.readUInt16BE(i + 7)}x${b.readUInt16BE(i + 5)}`;
};
const ff = (args) => execFileSync("ffmpeg", ["-y", "-v", "error", ...args], { cwd: fr, stdio: "inherit" });

// 1. 帧尺寸：1920x1080 直接用；更大的裁左上角；其他尺寸是窗口调整时的过渡帧
const files = readdirSync(fr).filter((f) => /^f\d{5}\.jpg$/.test(f)).sort();
const sizes = files.map(sizeOf);
const count = {};
sizes.forEach((s) => (count[s] = (count[s] ?? 0) + 1));
console.log("帧尺寸", count);
const ranges = [];
sizes.forEach((s, i) => {
  if (s !== "2095x1163") return;
  const last = ranges.at(-1);
  if (last && last.end === i - 1) last.end = i;
  else ranges.push({ start: i, end: i });
});
for (const r of ranges) ff(["-start_number", String(r.start), "-i", "f%05d.jpg", "-frames:v", String(r.end - r.start + 1), "-vf", "crop=1920:1080:0:0", "-q:v", "2", "-start_number", String(r.start), "c%05d.jpg"]);

const name = (i) => (sizes[i] === "2095x1163" ? `c${files[i].slice(1)}` : files[i]);
let lastGood = null;
const lines = readFileSync(join(fr, "frames.txt"), "utf8").split("\n");
let replaced = 0;
const out = lines.map((l) => {
  const m = l.match(/^file 'f(\d{5})\.jpg'$/);
  if (!m) return l;
  const i = +m[1];
  if (sizes[i] === "1920x1080" || sizes[i] === "2095x1163") {
    lastGood = name(i);
    return `file '${lastGood}'`;
  }
  replaced++;
  return `file '${lastGood ?? name(i)}'`;
});
writeFileSync(join(fr, "final.txt"), out.join("\n"));
console.log(`裁剪 ${ranges.reduce((a, r) => a + r.end - r.start + 1, 0)} 帧，替换过渡帧 ${replaced} 帧`);

// 2. 视频
ff(["-f", "concat", "-safe", "0", "-i", "final.txt", "-fps_mode", "cfr", "-r", "30", "-vf", "format=yuv420p", "-c:v", "libx264", "-preset", "veryslow", "-crf", "24", "-tune", "animation", "-movflags", "+faststart", join(here, "video-only.mp4")]);

// 3. 旁白：每段放慢到 94%，放在该段开始后 0.15 秒
const t = JSON.parse(readFileSync(join(here, "timeline.json"), "utf8"));
const ids = Object.keys(t.segStarts);
const inputs = ids.flatMap((id) => ["-i", join(here, "audio", `${id}.wav`)]);
const parts = ids.map((id, i) => `[${i}:a]aresample=48000,atempo=0.94,adelay=${Math.round((t.segStarts[id] - t.videoOffset + 0.15) * 1000)}:all=1[a${i}]`);
const mix = `${ids.map((_, i) => `[a${i}]`).join("")}amix=inputs=${ids.length}:normalize=0:dropout_transition=0,apad=whole_dur=${t.total.toFixed(3)},loudnorm=I=-16:TP=-1.5:LRA=11,aresample=48000[out]`;
execFileSync("ffmpeg", ["-y", "-v", "error", ...inputs, "-filter_complex", `${parts.join(";")};${mix}`, "-map", "[out]", "-ac", "1", "-c:a", "aac", "-b:a", "128k", join(here, "narration.m4a")], { stdio: "inherit" });

// 4. 合成
execFileSync("ffmpeg", ["-y", "-v", "error", "-i", join(here, "video-only.mp4"), "-i", join(here, "narration.m4a"), "-map", "0:v", "-map", "1:a", "-c", "copy", "-movflags", "+faststart", join(here, "demo.mp4")], { stdio: "inherit" });
console.log("完成：", execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration,size", "-of", "compact", join(here, "demo.mp4")]).toString().trim());
