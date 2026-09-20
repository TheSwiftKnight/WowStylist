import { NextResponse } from "next/server";
import { syncTagsFromGarments } from "@/lib/tags";
import { tagUntaggedGarments } from "@/lib/styleTagger";

export const dynamic = "force-dynamic";

// POST /api/tags/sync — 從收藏的單品長出 style 風向標的標籤
//
// 兩步：
//   1. 還沒標過的單品 → 把 text_description 丟給 Claude 要三個標籤
//      （風格 / 色系 / 形容詞），寫進 garment_style_tags
//   2. 把 garment_style_tags 依出現次數算成權重，寫進 style_tags
//
// 第一步沒有新單品時一次 Claude 都不會打，所以這支可以放心重複呼叫。
export async function POST() {
  let tagged = 0;

  try {
    const result = await tagUntaggedGarments();
    tagged = result.tagged;
  } catch (err) {
    // 標不動就算了，至少讓既有的標籤還能重算權重
    console.error("[tags] Claude 標籤失敗：", err);
  }

  try {
    const result = await syncTagsFromGarments();
    return NextResponse.json({ ...result, tagged });
  } catch (err) {
    console.error("[tags] 同步失敗：", err);
    return NextResponse.json({ error: "資料庫寫入失敗" }, { status: 503 });
  }
}
