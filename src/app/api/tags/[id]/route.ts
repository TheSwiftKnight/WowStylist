import { NextResponse } from "next/server";
import { deleteTag, isTagKind, updateTag } from "@/lib/tags";

export const dynamic = "force-dynamic";

// PATCH /api/tags/:id — 改標籤名稱 / 分類 / 權重
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const body = (await req.json().catch(() => null)) as {
    label?: string;
    kind?: string;
    weight?: number;
  } | null;

  if (body?.label !== undefined) {
    const label = body.label.trim();
    if (!label) {
      return NextResponse.json({ error: "標籤名稱不能是空的" }, { status: 400 });
    }
    if (label.length > 12) {
      return NextResponse.json({ error: "標籤最多 12 個字" }, { status: 422 });
    }
  }

  const tag = await updateTag(id, {
    label: body?.label,
    kind: isTagKind(body?.kind) ? body.kind : undefined,
    weight: body?.weight,
  });

  if (!tag) {
    return NextResponse.json({ error: "找不到這個標籤" }, { status: 404 });
  }
  return NextResponse.json({ tag });
}

// DELETE /api/tags/:id — 刪掉一個標籤
export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const ok = await deleteTag(id);
  if (!ok) {
    return NextResponse.json({ error: "找不到這個標籤" }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}
