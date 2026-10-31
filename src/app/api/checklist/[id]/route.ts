import { connection } from "next/server";
import { deleteItem, listItems, updateItem, visitorId } from "@/lib/checklist";

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  await connection();
  const { id } = await ctx.params;
  const v = await visitorId(false);
  if (!v) return Response.json({ error: "没有清单" }, { status: 404 });
  const body = (await req.json().catch(() => ({}))) as { text?: string; enabled?: boolean };
  updateItem(v, id, body);
  return Response.json({ items: listItems(v) });
}

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  await connection();
  const { id } = await ctx.params;
  const v = await visitorId(false);
  if (!v) return Response.json({ error: "没有清单" }, { status: 404 });
  deleteItem(v, id);
  return Response.json({ items: listItems(v) });
}
