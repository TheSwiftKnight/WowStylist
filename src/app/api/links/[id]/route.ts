import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";

// DELETE /api/links/:id — 刪除一筆收藏
export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const numId = Number(id);
  if (!Number.isInteger(numId)) {
    return NextResponse.json({ error: "無效的 id" }, { status: 400 });
  }
  try {
    await prisma.sharedLink.delete({ where: { id: numId } });
  } catch {
    return NextResponse.json({ error: "找不到這筆資料" }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}
