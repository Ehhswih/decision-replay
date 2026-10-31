import { connection } from "next/server";
import { addItem, listItems, visitorId } from "@/lib/checklist";
import type { LessonTrigger } from "@/lib/ai/review";

const TRIGGERS: LessonTrigger[] = ["chase", "hot", "panic", "anchor", "plan", "overtrade", "disposition", "attention", "other"];

export async function GET() {
  await connection();
  const v = await visitorId(false);
  return Response.json({ items: v ? listItems(v) : [] });
}

export async function POST(req: Request) {
  await connection();
  const body = (await req.json().catch(() => null)) as { text?: string; trigger?: string; sourceEpisodeId?: string; sourceLessonId?: string } | null;
  const text = body?.text?.trim();
  if (!text) return Response.json({ error: "清单内容不能为空" }, { status: 400 });
  const v = (await visitorId(true)) as string;
  const trigger = TRIGGERS.includes(body?.trigger as LessonTrigger) ? (body?.trigger as LessonTrigger) : "other";
  const id = addItem(v, { text, trigger, sourceEpisodeId: body?.sourceEpisodeId, sourceLessonId: body?.sourceLessonId });
  return Response.json({ id, items: listItems(v) });
}
