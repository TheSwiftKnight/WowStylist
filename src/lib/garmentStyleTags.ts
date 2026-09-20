// 單品的三個風格標籤（風格 / 色系 / 形容詞）。
//
// 一件單品一列，三欄各對一個圖例；資料在 Vercel 那台 Prisma Postgres，
// schema 跟種子資料都在 pipeline/migrations/002_garment_style_tags.sql。
//
// 這份取代原本 src/lib/mock.ts 的 MOCK_TAGS —— 那批是寫死的示範標籤，
// 跟收藏夾裡實際有什麼衣服沒有關係。

import { styleQuery } from "@/lib/styleDb";
import type { StyleTag, StyleTagKind } from "@/lib/mock";

export type GarmentStyleTags = {
  sourceItemId: string;
  fashionItemId: number | null;
  category: "top" | "pants";
  style: string;
  palette: string;
  adjective: string;
};

type Row = {
  source_item_id: string;
  fashion_item_id: string | number | null;
  category: string;
  style: string;
  palette: string;
  adjective: string;
};

/** 全部單品的標籤，key 是 source_item_id（對得回 fashion_items）。 */
export async function listGarmentStyleTags(): Promise<
  Map<string, GarmentStyleTags>
> {
  const rows = await styleQuery<Row>(
    `SELECT source_item_id, fashion_item_id, category, style, palette, adjective
       FROM garment_style_tags`
  );

  return new Map(
    rows.map((row) => [
      row.source_item_id,
      {
        sourceItemId: row.source_item_id,
        fashionItemId:
          row.fashion_item_id === null ? null : Number(row.fashion_item_id),
        category: row.category === "pants" ? "pants" : "top",
        style: row.style,
        palette: row.palette,
        adjective: row.adjective,
      },
    ])
  );
}

type CountRow = { label: string; kind: string; count: string };

/** DB 的三個欄位 → 畫面上的三種圖例。 */
const KIND_OF_COLUMN: Record<string, StyleTagKind> = {
  style: "style",
  palette: "color",
  adjective: "mood",
};

/**
 * 風向標要的標籤雲：把三欄各自算出現次數，次數最多的那個當權重 1。
 *
 * 權重是「在同一個圖例裡」正規化的，不是全表一起比 ——
 * 色系天生就比風格分散（32 件衣服可能有 20 種顏色），
 * 混在一起算的話色系會整排縮到最小，看不出哪個顏色偏多。
 */
export async function aggregateGarmentStyleTags(): Promise<StyleTag[]> {
  const rows = await styleQuery<CountRow>(
    `SELECT label, kind, COUNT(*)::text AS count
       FROM (
         SELECT style     AS label, 'style'     AS kind FROM garment_style_tags
         UNION ALL
         SELECT palette   AS label, 'palette'   AS kind FROM garment_style_tags
         UNION ALL
         SELECT adjective AS label, 'adjective' AS kind FROM garment_style_tags
       ) t
      WHERE label <> ''
      GROUP BY label, kind
      ORDER BY COUNT(*) DESC, label ASC`
  );

  const maxPerKind = new Map<string, number>();
  for (const row of rows) {
    const n = Number(row.count);
    maxPerKind.set(row.kind, Math.max(maxPerKind.get(row.kind) ?? 0, n));
  }

  return rows.map((row) => {
    const max = maxPerKind.get(row.kind) ?? 0;
    return {
      id: `${row.kind}-${row.label}`,
      label: row.label,
      kind: KIND_OF_COLUMN[row.kind] ?? "style",
      weight: max > 0 ? Number((Number(row.count) / max).toFixed(3)) : 0.5,
    };
  });
}
