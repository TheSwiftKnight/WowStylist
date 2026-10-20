import { NextResponse } from "next/server";
import { syncTagsFromGarments } from "@/lib/tags";
import { tagUntaggedGarments } from "@/lib/styleTagger";
import { compactStyleTags } from "@/lib/tagCompactor";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// POST /api/tags/sync — 從收藏的單品長出 style 風向標的標籤
//
// 三步：
//   1. 還沒標過的單品 → 把 text_description 丟給標籤模型要三個標籤
//      （風格 / 色系 / 形容詞），寫進 garment_style_tags
//   2. 把 garment_style_tags 依出現次數算成權重，寫進 style_tags
//   3. 超過 15 顆時先合併近義詞，再從最舊的開始刪到 15 顆
//
// 第一步沒有新單品、且標籤不超量時不會打 LLM，所以可以放心重複呼叫。
export async function POST() {
  let tagged = 0;

  try {
    const result = await tagUntaggedGarments();
    tagged = result.tagged;
  } catch (err) {
    // 標不動就算了，至少讓既有的標籤還能重算權重
    console.error("[tags] 標籤模型失敗：", err);
  }

  try {
    const result = await syncTagsFromGarments();
    const compaction = await compactStyleTags();
    return NextResponse.json({ ...result, tagged, compaction });
  } catch (err) {
    console.error("[tags] 同步失敗：", err);
    return NextResponse.json({ error: "資料庫寫入失敗" }, { status: 503 });
  }
}
