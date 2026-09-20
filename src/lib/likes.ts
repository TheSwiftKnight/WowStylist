// 「按讚一件商品」＝ 把商品 RDS 的那一列複製到 IG RDS 當成使用者偏好。
//
// 為什麼要複製而不是只記一個 id：
//   排序時算的 S_user 是「使用者偏好向量」跟商品向量的 cosine
//   （見 rank.ts 的 loadUserPreferenceEmbeddings / userScore）。
//   偏好向量統一從 IG RDS 的 fashion_items 撈，所以按讚的商品得有一列在那裡，
//   而且要帶著 embedding。
//
// ⚠️ 這裡刻意寫成 source='instagram' 而不是 'product'：
//   rank.ts 的偏好查詢只認 source='instagram' 且 shortcode 對得到
//   ingest_jobs.sender_id 的列。寫成 'product' 的話排序根本吃不到，
//   按讚就完全沒有效果。為了不動排序邏輯，這裡「偽裝」成一則 IG 收藏：
//     - source_item_id / shortcode = like_<userId>_<productId>
//     - 另外補一列 ingest_jobs 帶 sender_id，偏好查詢才對得回這個人
//     - display_tags 塞 'liked_product' 當記號
//
//   代價是收藏夾 / 風向標會看到這些不是真的來自 IG 的列。
//   之後要拆乾淨的話，這兩個都抓得到：
//     DELETE FROM fashion_items WHERE shortcode LIKE 'like\_%';
//     DELETE FROM ingest_jobs   WHERE stage = 'like';

import {
  query,
  queryProducts,
  fashionTable,
  productsTable,
  hasSeparateProductsDb,
} from "@/lib/rds";
import { toVector } from "@/lib/rank";

export type LikeOutcome =
  | { ok: true; created: boolean; title: string | null }
  | { ok: false; reason: string };

/** style_kb / 商品表用 top|bottom，fashion_items 只收 top|pants。 */
function toFashionCategory(raw: string | null): "top" | "pants" {
  return String(raw ?? "").toLowerCase() === "bottom" ? "pants" : "top";
}

export function likeKey(userId: string, productId: number | string): string {
  return `like_${userId}_${productId}`;
}

let productColumnsCache: Set<string> | undefined;

async function productColumns(): Promise<Set<string>> {
  if (productColumnsCache) return productColumnsCache;
  const rows = await queryProducts<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = $1`,
    [productsTable]
  );
  productColumnsCache = new Set(rows.map((r) => r.column_name));
  return productColumnsCache;
}

/** 這個人是不是已經讚過這件了。 */
export async function isLiked(
  userId: string,
  productId: number | string
): Promise<boolean> {
  const rows = await query<{ id: string }>(
    `SELECT id FROM ${fashionTable}
      WHERE source = 'instagram' AND source_item_id = $1 LIMIT 1`,
    [likeKey(userId, productId)]
  );
  return rows.length > 0;
}

/**
 * 把一件商品複製進 IG RDS 當偏好。
 * 同一個人重複讚同一件是安全的（靠 (source, source_item_id) 的 unique index）。
 */
export async function likeProduct(
  userId: string,
  productId: number | string,
  opts?: { senderName?: string | null }
): Promise<LikeOutcome> {
  if (!userId) return { ok: false, reason: "沒有 userId" };
  if (!/^\d+$/.test(String(productId))) {
    return { ok: false, reason: `product_id 不合法：${productId}` };
  }

  const key = likeKey(userId, productId);

  try {
    // ── 1. 從商品 RDS 撈這一列 ──────────────────────────────────────────────
    const cols = await productColumns();
    if (!cols.has("embedding")) {
      return {
        ok: false,
        reason: `${productsTable} 沒有 embedding 欄位，複製過去也算不出 S_user`,
      };
    }

    const select = [
      "product_id",
      "category",
      "embedding",
      cols.has("title") ? "title" : "NULL AS title",
      cols.has("price_twd") ? "price_twd" : "NULL AS price_twd",
      cols.has("product_url") ? "product_url" : "NULL AS product_url",
      cols.has("image_data") ? "image_data" : "NULL AS image_data",
      cols.has("image_mime") ? "image_mime" : "NULL AS image_mime",
      // 商品表不一定有 Claude 寫的描述；沒有就退回 title
      cols.has("text_description")
        ? "text_description"
        : "NULL AS text_description",
    ].join(", ");

    const [product] = await queryProducts<{
      product_id: string | number;
      category: string | null;
      embedding: unknown;
      title: string | null;
      price_twd: string | number | null;
      product_url: string | null;
      image_data: Buffer | null;
      image_mime: string | null;
      text_description: string | null;
    }>(
      `SELECT ${select} FROM ${productsTable}
        WHERE product_id::text = $1 LIMIT 1`,
      [String(productId)]
    );

    if (!product) {
      return { ok: false, reason: `商品 ${productId} 不存在（${productsTable}）` };
    }

    // embedding 可能是 float8[] 也可能是 pgvector 的字串，統一轉成 number[]
    let embedding: number[];
    try {
      embedding = toVector(product.embedding);
    } catch (e) {
      return { ok: false, reason: `商品 ${productId} 的 embedding 解不開：${String(e)}` };
    }
    if (embedding.length === 0) {
      return { ok: false, reason: `商品 ${productId} 沒有 embedding` };
    }

    // fashion_items 的 image_data 是 NOT NULL
    if (!product.image_data) {
      return { ok: false, reason: `商品 ${productId} 沒有圖片，無法寫入 fashion_items` };
    }

    const description =
      product.text_description?.trim() ||
      product.title?.trim() ||
      `商品 ${productId}`;

    // ── 2. 寫進 IG RDS ────────────────────────────────────────────────────
    const inserted = await query<{ id: string }>(
      `INSERT INTO ${fashionTable} (
         source, source_item_id, category, text_description,
         embedding, image_data, image_mime,
         display_tags, title, price_twd, product_url, shortcode
       ) VALUES (
         'instagram', $1, $2, $3,
         $4::double precision[], $5, $6,
         $7::text[], $8, $9, $10, $1
       )
       ON CONFLICT (source, source_item_id) DO NOTHING
       RETURNING id`,
      [
        key,
        toFashionCategory(product.category),
        description,
        embedding,
        product.image_data,
        product.image_mime ?? "image/jpeg",
        ["liked_product"],
        product.title,
        product.price_twd,
        product.product_url,
      ]
    );

    const created = inserted.length > 0;

    // ── 3. 補一列 ingest_jobs，偏好查詢才對得回這個人 ──────────────────────
    // （fashion_items 沒有 user 欄位，分享人一律記在 ingest_jobs.sender_id）
    if (created) {
      await query(
        `INSERT INTO ingest_jobs
           (url, shortcode, status, stage, item_count, sender_id, sender_name)
         SELECT $1, $2, 'done', 'like', 1, $3, $4
          WHERE NOT EXISTS (
            SELECT 1 FROM ingest_jobs WHERE shortcode = $2 AND sender_id = $3
          )`,
        [
          product.product_url ?? `product:${productId}`,
          key,
          userId,
          opts?.senderName ?? null,
        ]
      );
    }

    console.log(
      `[like] userId=${userId.slice(0, 8)}… product=${productId} ` +
      `${created ? "已寫入" : "先前已讚過"}（商品庫${hasSeparateProductsDb ? "獨立" : "與 IG 共用"}）`
    );

    return { ok: true, created, title: product.title };
  } catch (err) {
    console.error("[like] 寫入失敗：", err);
    return { ok: false, reason: String(err) };
  }
}
