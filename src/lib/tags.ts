// style 風向標的標籤。
//
// 原本在 Prisma 的 StyleTag，搬成 IG RDS 上的 style_tags 表
// （建表 SQL 在 pipeline/migrations/001_fashion_items.sql）。
//
// 這份是「使用者手動編的」那一層；pipeline 產出的 outfit_tags / display_tags
// 可以用 syncTagsFromGarments() 一次灌進來當起手式。

import { randomUUID } from "node:crypto";
import { query } from "@/lib/rds";
import { aggregateTags } from "@/lib/garments";
import { MOCK_TAGS, type StyleTag, type StyleTagKind } from "@/lib/mock";

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
 * 連不上或一筆都沒有 → 退回 src/lib/mock.ts 的示範標籤（唯讀，編輯會失敗）。
 * 要有真的資料，先跑 POST /api/tags/sync 從收藏的單品長出來。
 */
export async function listTags(): Promise<TagsResult> {
  try {
    const rows = await query<Row>(
      `SELECT id, label, kind, weight
         FROM style_tags
        ORDER BY weight DESC, created_at ASC`
    );

    if (rows.length === 0) {
      return { tags: MOCK_TAGS, isMock: true };
    }

    return { tags: rows.map(toTag), isMock: false };
  } catch (err) {
    console.warn("[tags] 讀不到資料庫，改用示範標籤：", err);
    return { tags: MOCK_TAGS, isMock: true };
  }
}

export async function createTag(input: {
  label: string;
  kind: StyleTagKind;
  weight?: number;
}): Promise<StyleTag> {
  const rows = await query<Row>(
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
    const rows = await query<Row>(
      `SELECT id, label, kind, weight FROM style_tags WHERE id = $1`,
      [id]
    );
    return rows[0] ? toTag(rows[0]) : null;
  }

  params.push(id);

  try {
    const rows = await query<Row>(
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
    const rows = await query<{ id: string }>(
      `DELETE FROM style_tags WHERE id = $1 RETURNING id`,
      [id]
    );
    return rows.length > 0;
  } catch {
    return false;
  }
}

/**
 * 從收藏的單品長出標籤：把 pipeline 產生的 outfit_tags / display_tags
 * 依出現次數算權重，寫進 style_tags。
 *
 * 同名的標籤只更新權重，不會重複長。手動加的標籤不會被刪掉。
 */
export async function syncTagsFromGarments(): Promise<{
  created: number;
  updated: number;
}> {
  const aggregated = await aggregateTags(30);

  let created = 0;
  let updated = 0;

  for (const tag of aggregated) {
    const label = tag.label.slice(0, 12);

    const existing = await query<{ id: string }>(
      `SELECT id FROM style_tags WHERE label = $1 LIMIT 1`,
      [label]
    );

    if (existing[0]) {
      await query(`UPDATE style_tags SET weight = $1 WHERE id = $2`, [
        Number(tag.weight.toFixed(3)),
        existing[0].id,
      ]);
      updated += 1;
    } else {
      await query(
        `INSERT INTO style_tags (id, label, kind, weight)
         VALUES ($1, $2, $3, $4)`,
        [randomUUID(), label, tag.kind, Number(tag.weight.toFixed(3))]
      );
      created += 1;
    }
  }

  return { created, updated };
}
