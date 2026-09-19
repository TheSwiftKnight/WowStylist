import { getGarmentImage } from "@/lib/garments";

// GET /api/garments/:id/image — 把 RDS 裡的 bytea 圖片吐出來
//
// 圖片存在資料庫（image_data bytea），不是檔案系統，
// 所以列表查詢不撈它，由這支單獨出圖。
// 圖片寫進去就不會變，可以放心長快取。
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const numId = Number(id);

  if (!Number.isInteger(numId)) {
    return new Response("invalid id", { status: 400 });
  }

  try {
    const image = await getGarmentImage(numId);

    if (!image) {
      return new Response("not found", { status: 404 });
    }

    return new Response(new Uint8Array(image.data), {
      headers: {
        "Content-Type": image.mime,
        "Content-Length": String(image.data.length),
        "Cache-Control": "public, max-age=31536000, immutable",
      },
    });
  } catch (err) {
    console.error("[garments] 讀圖失敗：", err);
    return new Response("database error", { status: 503 });
  }
}
