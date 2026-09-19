import { MOCK_TAGS, type StyleTag, type StyleTagKind } from "@/lib/mock";

export type { StyleTag, StyleTagKind };

// ---------------------------------------------------------------------------
// style 風向標的資料存取層。
//
// 現況：tags table 還沒建，所以先放在 module 層的記憶體陣列裡（dev 熱重載時
//       會保留），資料在 server 重開後會回到 MOCK_TAGS。
//
// 要接 Amazon RDS 時：
//   1. 在 prisma/schema.prisma 加上
//        model StyleTag {
//          id        String   @id @default(cuid())
//          label     String
//          kind      String   // "style" | "color" | "mood"
//          weight    Float    @default(0.5)
//          ownerId   String?  // LINE userId，之後要分使用者時用
//          createdAt DateTime @default(now())
//          updatedAt DateTime @updatedAt
//        }
//   2. 把下面四個函式的實作換成標了 TODO(RDS) 的那幾行 prisma 呼叫。
//   3. 前端（src/app/compass）完全不用動 —— 它只認這四個函式的簽章。
// ---------------------------------------------------------------------------

const globalForTags = globalThis as unknown as { __styleTags?: StyleTag[] };

function store(): StyleTag[] {
  if (!globalForTags.__styleTags) {
    globalForTags.__styleTags = MOCK_TAGS.map((tag) => ({ ...tag }));
  }
  return globalForTags.__styleTags;
}

export const TAG_KINDS: StyleTagKind[] = ["style", "color", "mood"];

export const TAG_KIND_LABEL: Record<StyleTagKind, string> = {
  style: "風格",
  color: "色系",
  mood: "形容詞",
};

export function isTagKind(value: unknown): value is StyleTagKind {
  return typeof value === "string" && (TAG_KINDS as string[]).includes(value);
}

export async function listTags(): Promise<StyleTag[]> {
  // TODO(RDS): return prisma.styleTag.findMany({ orderBy: { weight: "desc" } });
  return store()
    .slice()
    .sort((a, b) => b.weight - a.weight);
}

export async function createTag(input: {
  label: string;
  kind: StyleTagKind;
  weight?: number;
}): Promise<StyleTag> {
  // TODO(RDS): return prisma.styleTag.create({ data: input });
  const tag: StyleTag = {
    id: `t-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    label: input.label.trim(),
    kind: input.kind,
    weight: input.weight ?? 0.5,
  };
  store().push(tag);
  return tag;
}

export async function updateTag(
  id: string,
  patch: { label?: string; kind?: StyleTagKind; weight?: number }
): Promise<StyleTag | null> {
  // TODO(RDS): return prisma.styleTag.update({ where: { id }, data: patch });
  const tag = store().find((t) => t.id === id);
  if (!tag) return null;
  if (patch.label !== undefined) tag.label = patch.label.trim();
  if (patch.kind !== undefined) tag.kind = patch.kind;
  if (patch.weight !== undefined) tag.weight = patch.weight;
  return tag;
}

export async function deleteTag(id: string): Promise<boolean> {
  // TODO(RDS): await prisma.styleTag.delete({ where: { id } }); return true;
  const list = store();
  const idx = list.findIndex((t) => t.id === id);
  if (idx === -1) return false;
  list.splice(idx, 1);
  return true;
}
