import { prisma } from "@/lib/db";
import { MOCK_TAGS, type StyleTag, type StyleTagKind } from "@/lib/mock";

export type { StyleTag, StyleTagKind };

export type TagsResult = {
  tags: StyleTag[];
  /** true = 資料庫連不上，畫面上這批是唯讀的示範資料 */
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

/** DB 的 kind 是自由字串，讀回來時收斂成我們認得的三種。 */
function toTag(row: {
  id: string;
  label: string;
  kind: string;
  weight: number;
}): StyleTag {
  return {
    id: row.id,
    label: row.label,
    kind: isTagKind(row.kind) ? row.kind : "style",
    weight: row.weight,
  };
}

/**
 * 列出所有標籤（權重高到低）。
 * 資料庫連不上時退回 src/lib/mock.ts 的示範標籤，這樣本機還沒 db push
 * 之前畫面也看得到東西 —— 但那批是唯讀的，編輯會失敗。
 * 第一次部署完跑 `npm run db:seed` 就會把這 20 個標籤寫進資料庫。
 */
export async function listTags(): Promise<TagsResult> {
  try {
    const rows = await prisma.styleTag.findMany({
      orderBy: [{ weight: "desc" }, { createdAt: "asc" }],
    });
    return { tags: rows.map(toTag), isMock: false };
  } catch (err) {
    console.warn("[tags] 讀不到資料庫，改用 mock 標籤：", err);
    return { tags: MOCK_TAGS, isMock: true };
  }
}

export async function createTag(input: {
  label: string;
  kind: StyleTagKind;
  weight?: number;
}): Promise<StyleTag> {
  const row = await prisma.styleTag.create({
    data: {
      label: input.label.trim(),
      kind: input.kind,
      weight: input.weight ?? 0.5,
    },
  });
  return toTag(row);
}

export async function updateTag(
  id: string,
  patch: { label?: string; kind?: StyleTagKind; weight?: number }
): Promise<StyleTag | null> {
  try {
    const row = await prisma.styleTag.update({
      where: { id },
      data: {
        ...(patch.label !== undefined ? { label: patch.label.trim() } : {}),
        ...(patch.kind !== undefined ? { kind: patch.kind } : {}),
        ...(patch.weight !== undefined ? { weight: patch.weight } : {}),
      },
    });
    return toTag(row);
  } catch {
    return null; // 找不到這筆
  }
}

export async function deleteTag(id: string): Promise<boolean> {
  try {
    await prisma.styleTag.delete({ where: { id } });
    return true;
  } catch {
    return false;
  }
}
