import { NextResponse } from "next/server";
import { listGarments } from "@/lib/garments";

export const dynamic = "force-dynamic";

// GET /api/garments?category=top&limit=50 — 列出收藏的單品（新到舊）
export async function GET(req: Request) {
  const url = new URL(req.url);
  const category = url.searchParams.get("category") ?? undefined;
  const limitParam = Number(url.searchParams.get("limit"));
  const limit =
    Number.isInteger(limitParam) && limitParam > 0
      ? Math.min(limitParam, 500)
      : undefined;

  const { garments, isMock } = await listGarments({ category, limit });
  return NextResponse.json({ garments, isMock });
}
