// 收藏夾的資料來源：fashion_items 表裡由 Python pipeline 寫進來的「單品」。
//
// 一條 IG 連結 → pipeline → 多列 garment（一件上衣、一件褲子…各一列）。
// schema 見 pipeline/migrations/001_fashion_items.sql。
//
// 圖片是 bytea 存在 DB 裡，所以列表查詢一律不撈 image_data，
// 由 /api/garments/:id/image 單獨出圖，不然一頁就是好幾 MB。

import { fashionTable, query } from "@/lib/rds";
import { MOCK_GARMENTS } from "@/lib/mock";

export type Garment = {
  id: number;
  source: string; // "instagram" | "product"
  sourceItemId: string;
  category: string; // "top" | "pants"
  description: string; // text_description
  displayTags: string[];
  outfitTags: string[];
  instagramUrl: string | null;
  instagramType: string | null; // "post" | "reel"
  shortcode: string | null;
  /** Reel 的第幾秒；Post / 商品是 null */
  timestamp: number | null;
  title: string | null; // 商品才有
  priceTwd: number | null; // 商品才有
  productUrl: string | null; // 商品才有
  hasImage: boolean;
  createdAt: string; // ISO
};

export type GarmentsResult = {
  garments: Garment[];
  /** true = 這批是示範資料，不是真的資料庫內容 */
  isMock: boolean;
};

type Row = {
  id: number;
  source: string;
  source_item_id: string;
  category: string;
  text_description: string;
  display_tags: string[] | null;
  outfit_tags: string[] | null;
  instagram_url: string | null;
  instagram_type: string | null;
  shortcode: string | null;
  timestamp: string | number | null;
  title: string | null;
  price_twd: string | number | null;
  product_url: string | null;
  has_image: boolean;
  created_at: Date | string;
};

// "timestamp" 在 Postgres 是保留字，一定要加雙引號
const SELECT_COLUMNS = `
  id,
  source,
  source_item_id,
  category,
  text_description,
  display_tags,
  outfit_tags,
  instagram_url,
  instagram_type,
  shortcode,
  "timestamp",
  title,
  price_twd,
  product_url,
  (image_data IS NOT NULL) AS has_image,
  created_at
`;

function num(value: string | number | null): number | null {
  return value === null || value === undefined ? null : Number(value);
}

function toGarment(row: Row): Garment {
  return {
    id: row.id,
    source: row.source,
    sourceItemId: row.source_item_id,
    category: row.category,
    description: row.text_description,
    displayTags: row.display_tags ?? [],
    outfitTags: row.outfit_tags ?? [],
    instagramUrl: row.instagram_url,
    instagramType: row.instagram_type,
    shortcode: row.shortcode,
    timestamp: num(row.timestamp),
    title: row.title,
    priceTwd: num(row.price_twd),
    productUrl: row.product_url,
    hasImage: row.has_image,
    createdAt: new Date(row.created_at).toISOString(),
  };
}

/**
 * 列出收藏的單品（新到舊）。
 *
 * 預設只看 Instagram 來的 —— 同一張表之後也會放商品。
 * 資料庫連不上、或還沒有任何資料時回 src/lib/mock.ts 的示範資料，
 * 這樣 pipeline 還沒跑過之前畫面也看得到完整版面。
 */
export async function listGarments(options?: {
  source?: string;
  category?: string;
  limit?: number;
}): Promise<GarmentsResult> {
  const source = options?.source ?? "instagram";
  const limit = options?.limit ?? 200;

  try {
    const params: unknown[] = [source];
    let where = `WHERE source = $1`;

    if (options?.category) {
      params.push(options.category);
      where += ` AND category = $${params.length}`;
    }

    params.push(limit);

    const rows = await query<Row>(
      `SELECT ${SELECT_COLUMNS}
         FROM ${fashionTable}
         ${where}
        ORDER BY created_at DESC, id DESC
        LIMIT $${params.length}`,
      params
    );

    if (rows.length === 0) {
      return { garments: MOCK_GARMENTS, isMock: true };
    }

    return { garments: rows.map(toGarment), isMock: false };
  } catch (err) {
    console.warn("[garments] 讀不到資料庫，改用示範資料：", err);
    return { garments: MOCK_GARMENTS, isMock: true };
  }
}

/** 拿一列的圖片原始 bytes（/api/garments/:id/image 用）。 */
export async function getGarmentImage(
  id: number
): Promise<{ data: Buffer; mime: string } | null> {
  const rows = await query<{
    image_data: Buffer | null;
    image_mime: string | null;
  }>(
    `SELECT image_data, image_mime FROM ${fashionTable} WHERE id = $1 LIMIT 1`,
    [id]
  );

  const row = rows[0];
  if (!row?.image_data) return null;

  return {
    data: row.image_data,
    mime: row.image_mime ?? "image/jpeg",
  };
}

export async function deleteGarment(id: number): Promise<boolean> {
  const rows = await query<{ id: number }>(
    `DELETE FROM ${fashionTable} WHERE id = $1 RETURNING id`,
    [id]
  );
  return rows.length > 0;
}

/** 同一則貼文解析出來的所有單品（「同一套」用）。 */
export async function listGarmentsByShortcode(
  shortcode: string
): Promise<Garment[]> {
  const rows = await query<Row>(
    `SELECT ${SELECT_COLUMNS}
       FROM ${fashionTable}
      WHERE shortcode = $1
      ORDER BY category, id`,
    [shortcode]
  );
  return rows.map(toGarment);
}

/**
 * style 風向標的自動來源：把所有單品的 outfit_tags / display_tags
 * 依出現次數算成 0~1 的權重。
 *
 * outfit_tags（Minimal / Streetwear…）→ 風格
 * display_tags 裡的顏色字（Black / Cream…）→ 色系
 * 其餘 display_tags（Oversized / Ribbed…）→ 形容詞
 */
const COLOR_WORDS = [
  "black", "white", "cream", "beige", "ivory", "grey", "gray", "navy",
  "blue", "green", "olive", "brown", "tan", "camel", "red", "burgundy",
  "pink", "purple", "yellow", "orange", "khaki", "charcoal", "denim",
  "silver", "gold", "mint", "sage", "rust", "taupe", "oatmeal",
];

function tagKindOf(label: string, source: "outfit" | "display") {
  if (source === "outfit") return "style" as const;
  const lower = label.toLowerCase();
  return COLOR_WORDS.some((word) => lower.includes(word))
    ? ("color" as const)
    : ("mood" as const);
}

export async function aggregateTags(limit = 40): Promise<
  {
    label: string;
    count: number;
    weight: number;
    kind: "style" | "color" | "mood";
  }[]
> {
  try {
    const rows = await query<{
      label: string;
      count: string;
      source: string;
    }>(
      `SELECT label, COUNT(*)::text AS count, source
         FROM (
           SELECT unnest(outfit_tags) AS label, 'outfit' AS source
             FROM ${fashionTable} WHERE outfit_tags IS NOT NULL
           UNION ALL
           SELECT unnest(display_tags) AS label, 'display' AS source
             FROM ${fashionTable} WHERE display_tags IS NOT NULL
         ) t
        WHERE label <> ''
        GROUP BY label, source
        ORDER BY COUNT(*) DESC
        LIMIT $1`,
      [limit]
    );

    if (rows.length === 0) return [];

    const max = Math.max(...rows.map((r) => Number(r.count)));

    return rows.map((r) => ({
      label: r.label,
      count: Number(r.count),
      weight: max > 0 ? Number(r.count) / max : 0.5,
      kind: tagKindOf(r.label, r.source === "outfit" ? "outfit" : "display"),
    }));
  } catch (err) {
    console.warn("[garments] 標籤統計失敗：", err);
    return [];
  }
}
