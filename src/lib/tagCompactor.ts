import { getStylePool } from "@/lib/styleDb";
import { callTagLlm } from "@/lib/tagLlm";
import type { StyleTagKind } from "@/lib/mock";
import type { PoolClient } from "pg";

const MAX_STYLE_TAGS = 15;

type TagRow = {
  id: string;
  label: string;
  kind: StyleTagKind;
  weight: number | string;
  created_at: Date | string;
};

type MergeGroup = {
  canonicalId: string;
  memberIds: string[];
};

type MergePlan = { groups: MergeGroup[] };

const COLUMN_BY_KIND: Record<StyleTagKind, "style" | "palette" | "adjective"> = {
  style: "style",
  color: "palette",
  mood: "adjective",
};

const MERGE_PROMPT = `你是服飾標籤整理員。請找出真正語意近似、可以合併的標籤。

規則：
- 只能合併 kind 完全相同的標籤。
- 同義詞、近義詞或只有常見寫法差異才合併，例如「極簡／簡約」。
- 只是相關但意思不同的不可合併，例如「法式／優雅」、「純黑／炭灰」。
- canonicalId 必須是該組 memberIds 中最自然、最適合作為顯示名稱的一個。
- 每個 id 最多出現在一組；不需要合併的標籤不要輸出。
- 只能使用輸入中存在的 id。
- 只輸出合法 JSON，不要說明或 Markdown：
  {"groups":[{"canonicalId":"id","memberIds":["id","id"]}]}`;

function parseMergePlan(text: string, tags: TagRow[]): MergePlan | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = (fenced ? fenced[1] : text).trim();
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start === -1 || end === -1) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(body.slice(start, end + 1));
  } catch {
    return null;
  }

  const rawGroups = (parsed as { groups?: unknown })?.groups;
  if (!Array.isArray(rawGroups)) return null;

  const byId = new Map(tags.map((tag) => [tag.id, tag]));
  const used = new Set<string>();
  const groups: MergeGroup[] = [];

  for (const value of rawGroups) {
    if (!value || typeof value !== "object") continue;
    const raw = value as { canonicalId?: unknown; memberIds?: unknown };
    if (typeof raw.canonicalId !== "string" || !Array.isArray(raw.memberIds)) {
      continue;
    }

    const memberIds = [...new Set(
      raw.memberIds.filter((id): id is string => typeof id === "string")
    )];
    const members = memberIds.map((id) => byId.get(id));
    const canonical = byId.get(raw.canonicalId);

    if (
      memberIds.length < 2 ||
      !canonical ||
      !memberIds.includes(raw.canonicalId) ||
      members.some((tag) => !tag || tag.kind !== canonical.kind) ||
      memberIds.some((id) => used.has(id))
    ) {
      continue;
    }

    memberIds.forEach((id) => used.add(id));
    groups.push({ canonicalId: raw.canonicalId, memberIds });
  }

  return { groups };
}

async function rewriteGarmentTags(
  client: PoolClient,
  kind: StyleTagKind,
  labels: string[],
  replacement: string
): Promise<void> {
  if (labels.length === 0) return;
  const column = COLUMN_BY_KIND[kind];
  await client.query(
    `UPDATE garment_style_tags
        SET ${column} = $1, updated_at = CURRENT_TIMESTAMP
      WHERE ${column} = ANY($2::text[])`,
    [replacement, labels]
  );
}

export type TagCompactionResult = {
  before: number;
  after: number;
  merged: number;
  deletedOldest: number;
  provider: "openrouter" | "openai" | null;
  model: string | null;
};

/**
 * 超過 15 顆時先讓 LLM 找同義標籤，再從 created_at 最舊的開始刪。
 * 被合併／刪掉的衍生標籤也同步回 garment_style_tags，避免下次 sync 復活。
 */
export async function compactStyleTags(
  maxTags = MAX_STYLE_TAGS
): Promise<TagCompactionResult> {
  const pool = getStylePool();
  const initialResult = await pool.query<TagRow>(
    `SELECT id, label, kind, weight, created_at
       FROM style_tags
      ORDER BY created_at ASC, id ASC`
  );
  const initial = initialResult.rows;

  if (initial.length <= maxTags) {
    return {
      before: initial.length,
      after: initial.length,
      merged: 0,
      deletedOldest: 0,
      provider: null,
      model: null,
    };
  }

  const llm = await callTagLlm({
    messages: [
      { role: "system", content: MERGE_PROMPT },
      {
        role: "user",
        content: JSON.stringify(
          initial.map((tag) => ({
            id: tag.id,
            label: tag.label,
            kind: tag.kind,
          }))
        ),
      },
    ],
    maxTokens: 1200,
    parse: (text) => parseMergePlan(text, initial),
  });
  const plan = llm.value ?? { groups: [] };

  const client = await pool.connect();
  let merged = 0;
  let deletedOldest = 0;

  try {
    await client.query("BEGIN");

    for (const group of plan.groups) {
      const currentResult = await client.query<TagRow>(
        `SELECT id, label, kind, weight, created_at
           FROM style_tags
          WHERE id = ANY($1::text[])
          FOR UPDATE`,
        [group.memberIds]
      );
      const current = currentResult.rows;
      const canonical = current.find((tag) => tag.id === group.canonicalId);
      if (
        !canonical ||
        current.length < 2 ||
        current.some((tag) => tag.kind !== canonical.kind)
      ) {
        continue;
      }

      const duplicates = current.filter((tag) => tag.id !== canonical.id);
      await rewriteGarmentTags(
        client,
        canonical.kind,
        duplicates.map((tag) => tag.label),
        canonical.label
      );
      await client.query(
        `UPDATE style_tags
            SET weight = $1
          WHERE id = $2`,
        [
          Math.max(...current.map((tag) => Number(tag.weight))),
          canonical.id,
        ]
      );
      await client.query(
        `DELETE FROM style_tags WHERE id = ANY($1::text[])`,
        [duplicates.map((tag) => tag.id)]
      );
      merged += duplicates.length;
    }

    const remainingResult = await client.query<TagRow>(
      `SELECT id, label, kind, weight, created_at
         FROM style_tags
        ORDER BY created_at ASC, id ASC
        FOR UPDATE`
    );
    const overflow = remainingResult.rows.slice(
      0,
      Math.max(0, remainingResult.rows.length - maxTags)
    );

    for (const kind of ["style", "color", "mood"] as StyleTagKind[]) {
      const labels = overflow
        .filter((tag) => tag.kind === kind)
        .map((tag) => tag.label);
      await rewriteGarmentTags(client, kind, labels, "");
    }

    if (overflow.length > 0) {
      await client.query(
        `DELETE FROM style_tags WHERE id = ANY($1::text[])`,
        [overflow.map((tag) => tag.id)]
      );
      deletedOldest = overflow.length;
    }

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }

  const countResult = await pool.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM style_tags`
  );
  return {
    before: initial.length,
    after: Number(countResult.rows[0]?.count ?? 0),
    merged,
    deletedOldest,
    provider: llm.provider,
    model: llm.model,
  };
}
