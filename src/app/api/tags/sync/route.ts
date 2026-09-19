import { NextResponse } from "next/server";
import { syncTagsFromGarments } from "@/lib/tags";

export const dynamic = "force-dynamic";

// POST /api/tags/sync — 從收藏的單品長出 style 風向標的標籤
// （把 pipeline 產生的 outfit_tags / display_tags 依出現次數算權重）
export async function POST() {
  try {
    const result = await syncTagsFromGarments();
    return NextResponse.json(result);
  } catch (err) {
    console.error("[tags] 同步失敗：", err);
    return NextResponse.json({ error: "資料庫寫入失敗" }, { status: 503 });
  }
}
