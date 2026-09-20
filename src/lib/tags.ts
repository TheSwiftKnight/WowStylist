// style 風向標的標籤。
//
// 這份是「使用者手動編的」那一層，住在 Vercel 那台 Prisma Postgres，
// 跟單品標籤（garment_style_tags）同一台，建表 SQL 在
// pipeline/migrations/003_style_tags_on_vercel.sql。
//
// RDS 上也有一張同名同欄位的 style_tags（001 建的），但一直是空的，
// 而且 RDS 從外面連不穩；標籤是使用者會即時增刪改的東西，
// 所以整個風向標都收在 Vercel 這台，不跨庫。
//
// 起手式是 syncTagsFromGarments()：把 garment_style_tags 收攏進來。

import { randomUUID } from "node:crypto";
import { MOCK_TAGS, type StyleTag, type StyleTagKind } from "@/lib/mock";
import { styleQuery } from "@/lib/styleDb";
import { aggregateGarmentStyleTags } from "@/lib/garmentStyleTags";

export type { StyleTag, StyleTagKind };

export type TagsResult = {
  tags: StyleTag[];
  /** true = 資料庫連不上或還沒有標籤，畫面上這批是唯讀的示範資料 */
  isMock: boolean;
};

export const TAG_KINDS: StyleTagKind[] = ["style", "color", "mood"];

export const TAG_KIND_LABEL: Record<StyleTagKind, string> = {
  style: "風格",
  color: "色系",
  mood: "形容詞",
};

export function isTagKind(value: unknown): value is StyleTagKind {
  return typeof value === "string" && (TAG_KINDS as string[]).includes(value);
}

type Row = {
  id: string;
  label: string;
  kind: string;
  weight: string | number;
};

/** DB 的 kind 是自由字串，讀回來時收斂成我們認得的三種。 */
function toTag(row: Row): StyleTag {
  return {
    id: row.id,
    label: row.label,
    kind: isTagKind(row.kind) ? row.kind : "style",
    weight: Number(row.weight),
  };
}

/**
 * 列出所有標籤（權重高到低）。
 *
 * 三層，由上往下退：
 *   1. style_tags（RDS）—— 使用者手動編過的，有就以這層為準
 *   2. garment_style_tags（Vercel 那台）—— 從 text_description 讀出來的
 *      風格 / 色系 / 形容詞，是實際收藏的衣服長出來的，可讀不可編
 *   3. MOCK_TAGS —— 兩邊都連不上時的寫死示範標籤
 */
export async function listTags(): Promise<TagsResult> {
  try {
    const rows = await styleQuery<Row>(
      `SELECT id, label, kind, weight
         FROM style_tags
        ORDER BY weight DESC, created_at ASC`
    );

    if (rows.length > 0) {
      return { tags: rows.map(toTag), isMock: false };
    }
  } catch (err) {
    console.warn("[tags] 讀不到 style_tags：", err);
  }

  // 手編那層還是空的 → 用單品自己的標籤把風向標撐起來。
  // isMock=true 是因為這層沒有 style_tags.id，改不了，編輯一樣會失敗。
  try {
    const derived = await aggregateGarmentStyleTags();

    if (derived.length > 0) {
      return {
        tags: [...derived].sort((a, b) => b.weight - a.weight),
        isMock: true,
      };
    }
  } catch (err) {
    console.warn("[tags] 讀不到 garment_style_tags：", err);
  }

  return { tags: MOCK_TAGS, isMock: true };
}

export async function createTag(input: {
  label: string;
  kind: StyleTagKind;
  weight?: number;
}): Promise<StyleTag> {
  const rows = await styleQuery<Row>(
    `INSERT INTO style_tags (id, label, kind, weight)
     VALUES ($1, $2, $3, $4)
     RETURNING id, label, kind, weight`,
    [randomUUID(), input.label.trim(), input.kind, input.weight ?? 0.5]
  );
  return toTag(rows[0]);
}

export async function updateTag(
  id: string,
  patch: { label?: string; kind?: StyleTagKind; weight?: number }
): Promise<StyleTag | null> {
  const sets: string[] = [];
  const params: unknown[] = [];

  if (patch.label !== undefined) {
    params.push(patch.label.trim());
    sets.push(`label = $${params.length}`);
  }
  if (patch.kind !== undefined) {
    params.push(patch.kind);
    sets.push(`kind = $${params.length}`);
  }
  if (patch.weight !== undefined) {
    params.push(patch.weight);
    sets.push(`weight = $${params.length}`);
  }

  if (sets.length === 0) {
    const rows = await styleQuery<Row>(
      `SELECT id, label, kind, weight FROM style_tags WHERE id = $1`,
      [id]
    );
    return rows[0] ? toTag(rows[0]) : null;
  }

  params.push(id);

  try {
    const rows = await styleQuery<Row>(
      `UPDATE style_tags SET ${sets.join(", ")}
        WHERE id = $${params.length}
        RETURNING id, label, kind, weight`,
      params
    );
    return rows[0] ? toTag(rows[0]) : null;
  } catch {
    return null;
  }
}

export async function deleteTag(id: string): Promise<boolean> {
  try {
    const rows = await styleQuery<{ id: string }>(
      `DELETE FROM style_tags WHERE id = $1 RETURNING id`,
      [id]
    );
    return rows.length > 0;
  } catch {
    return false;
  }
}

/**
 * 從收藏的單品長出標籤：把 garment_style_tags 的三個欄位
 * （風格 / 色系 / 形容詞）依出現次數算權重，寫進 style_tags。
 *
 * 同名的標籤只更新權重，不會重複長。手動加的標籤不會被刪掉。
 */
export async function syncTagsFromGarments(): Promise<{
  created: number;
  updated: number;
}> {
  const aggregated = await aggregateGarmentStyleTags();

  let created = 0;
  let updated = 0;

  for (const tag of aggregated) {
    const label = tag.label.slice(0, 12);

    // label 上有 unique index，靠 ON CONFLICT 一句解決，
    // 不用先 SELECT 再決定 INSERT / UPDATE（那樣同時有兩個人按會打架）。
    const rows = await styleQuery<{ inserted: boolean }>(
      `INSERT INTO style_tags (id, label, kind, weight)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (label) DO UPDATE SET weight = EXCLUDED.weight
       RETURNING (xmax = 0) AS inserted`,
      [randomUUID(), label, tag.kind, tag.weight]
    );

    if (rows[0]?.inserted) created += 1;
    else updated += 1;
  }

  return { created, updated };
}
