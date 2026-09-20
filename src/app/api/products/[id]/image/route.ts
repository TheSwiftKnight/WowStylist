import { queryProducts, productsTable } from "@/lib/rds";

// GET /api/products/:id/image — 把商品 RDS 裡的 bytea 圖片吐出來。
//
// 為什麼需要這支：LINE Flex Message 的 image 只吃「公開的 HTTPS 網址」，
// LINE 的伺服器會自己去抓圖。商品圖是 bytea 存在 RDS 裡（跟 IG 單品一樣，
// 見 /api/garments/:id/image），所以得有一個出圖端點給 LINE 抓。
//
// 圖片寫進去就不會變，放心長快取。
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  // product_id 在商品表是 bigint，但這裡只當字串比對，避免超出 JS 安全整數
  if (!/^\d+$/.test(id)) {
    return new Response("invalid id", { status: 400 });
  }

  try {
    const rows = await queryProducts<{
      image_data: Buffer | null;
      image_mime: string | null;
    }>(
      `SELECT image_data, image_mime
         FROM ${productsTable}
        WHERE product_id::text = $1
        LIMIT 1`,
      [id]
    );

    const row = rows[0];
    if (!row?.image_data) {
      return new Response("not found", { status: 404 });
    }

    return new Response(new Uint8Array(row.image_data), {
      headers: {
        "Content-Type": row.image_mime ?? "image/jpeg",
        "Content-Length": String(row.image_data.length),
        "Cache-Control": "public, max-age=31536000, immutable",
      },
    });
  } catch (err) {
    console.error("[products] 讀圖失敗：", err);
    return new Response("database error", { status: 503 });
  }
}
