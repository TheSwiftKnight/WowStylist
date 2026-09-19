import { NextResponse } from "next/server";
import { createTag, isTagKind, listTags } from "@/lib/tags";

export const dynamic = "force-dynamic";

// GET /api/tags — 列出 style 風向標的所有標籤（權重高到低）
export async function GET() {
  const tags = await listTags();
  return NextResponse.json({ tags });
}

// POST /api/tags — 新增一個標籤
export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as {
    label?: string;
    kind?: string;
    weight?: number;
  } | null;

  const label = body?.label?.trim();
  if (!label) {
    return NextResponse.json({ error: "標籤名稱不能是空的" }, { status: 400 });
  }
  if (label.length > 12) {
    return NextResponse.json({ error: "標籤最多 12 個字" }, { status: 422 });
  }
  const kind = isTagKind(body?.kind) ? body.kind : "style";

  const tag = await createTag({ label, kind, weight: body?.weight });
  return NextResponse.json({ tag }, { status: 201 });
}
