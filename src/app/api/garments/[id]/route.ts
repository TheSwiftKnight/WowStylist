import { NextResponse } from "next/server";
import { deleteGarment } from "@/lib/garments";

export const dynamic = "force-dynamic";

// DELETE /api/garments/:id — 把一件單品從資料庫取下
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
    const ok = await deleteGarment(numId);
    if (!ok) {
      return NextResponse.json({ error: "找不到這筆資料" }, { status: 404 });
    }
  } catch (err) {
    console.error("[garments] 刪除失敗：", err);
    return NextResponse.json({ error: "資料庫錯誤" }, { status: 503 });
  }

  return NextResponse.json({ ok: true });
}
