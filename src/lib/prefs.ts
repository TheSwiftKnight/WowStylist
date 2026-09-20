// 使用者偏好「文字版」——給 LLM prompt 用的那一段。
//
// 跟 rank.ts 的差別：
//   rank.ts   取的是 embedding，算 S_user（數字）
//   這裡      取的是可讀的摘要，塞進 prompt 讓分類器知道這個人平常收藏什麼
//
// 兩邊資料來源同一個：IG RDS 的 fashion_items（source='instagram'），
// 也就是使用者分享給 LINE bot、被 pipeline 拆出來的單品。
// fashion_items 沒有 user 欄位（那張表只描述衣服），分享人記在
// ingest_jobs.sender_id，所以靠 shortcode 對回去。
//
// 原本這裡是讀 data/user-prefs/<userId>.md，那個檔案從來不存在，
// 所以 debug 訊息永遠是「無使用者偏好檔（冷啟動）」。
// 那條路徑保留成「手寫檔案覆寫」——有檔案就優先用。

import { readFileSync } from "fs";
import { join } from "path";
import { fashionTable, query } from "@/lib/rds";

export type UserPrefProfile = {
  /** 塞進 prompt 的那段文字；沒有任何收藏時是 null */
  text: string | null;
  scope: "file" | "user" | "global" | "none";
  garmentCount: number;
};

const FALLBACK_TO_GLOBAL =
  process.env.RANK_FALLBACK_GLOBAL_PREFS !== "false";

/** 手寫覆寫檔（選用）。 */
function loadPrefFile(userId: string): string | null {
  try {
    const content = readFileSync(
      join(process.cwd(), "data", "user-prefs", `${userId}.md`),
      "utf-8"
    ).trim();
    return content || null;
  } catch {
    return null;
  }
}

type Row = {
  category: string;
  text_description: string;
  display_tags: string[] | null;
  outfit_tags: string[] | null;
  shortcode: string | null;
  created_at: Date | string;
};

const CATEGORY_LABEL: Record<string, string> = {
  top: "上衣",
  pants: "褲子",
};

/** 出現次數由多到少，回傳 "Minimal ×6, Casual ×4" 這種字串。 */
function topTags(lists: (string[] | null)[], limit: number): string {
  const counts = new Map<string, number>();

  for (const list of lists) {
    for (const tag of list ?? []) {
      const t = String(tag).trim();
      if (!t) continue;
      counts.set(t, (counts.get(t) ?? 0) + 1);
    }
  }

  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([tag, n]) => (n > 1 ? `${tag} ×${n}` : tag))
    .join("、");
}

function buildProfile(rows: Row[], scope: "user" | "global"): string {
  const byCategory = new Map<string, number>();
  for (const row of rows) {
    byCategory.set(row.category, (byCategory.get(row.category) ?? 0) + 1);
  }

  const categoryText = [...byCategory.entries()]
    .map(([c, n]) => `${CATEGORY_LABEL[c] ?? c} ${n} 件`)
    .join("、");

  const posts = new Set(rows.map((r) => r.shortcode).filter(Boolean)).size;

  const styles = topTags(rows.map((r) => r.outfit_tags), 8);
  const features = topTags(rows.map((r) => r.display_tags), 10);

  // 最近幾件的描述，讓 LLM 看得到具體長什麼樣
  const recent = rows
    .slice(0, 4)
    .map((r) => `・${CATEGORY_LABEL[r.category] ?? r.category}：${r.text_description}`)
    .join("\n");

  const lines: string[] = [];

  if (scope === "global") {
    lines.push(
      "（這個人還沒有自己的收藏，以下是這個 bot 上所有收藏的整體傾向，僅供參考）"
    );
  }

  lines.push(
    `收藏了 ${rows.length} 件單品（${categoryText}），來自 ${posts} 則 Instagram 貼文。`
  );

  if (styles) lines.push(`常出現的風格：${styles}`);
  if (features) lines.push(`常出現的單品特徵：${features}`);
  if (recent) lines.push(`最近收藏的幾件：\n${recent}`);

  return lines.join("\n");
}

/**
 * 組出這個人的偏好摘要。
 *
 * 順序：手寫檔案 → 這個人自己的收藏 → 全體收藏（可關）→ 沒有。
 */
export async function loadUserPrefProfile(
  userId: string | null,
  limit = 60
): Promise<UserPrefProfile> {
  if (userId) {
    const fromFile = loadPrefFile(userId);
    if (fromFile) {
      return { text: fromFile, scope: "file", garmentCount: 0 };
    }
  }

  const select = `
    f.category,
    f.text_description,
    f.display_tags,
    f.outfit_tags,
    f.shortcode,
    f.created_at
  `;

  try {
    if (userId) {
      const rows = await query<Row>(
        // 子查詢而不是 JOIN —— 同一則貼文重送過的話 ingest_jobs 會有多列，
        // JOIN 會把同一件衣服乘出好幾份，統計就歪了。
        `SELECT ${select}
           FROM ${fashionTable} f
          WHERE f.source = 'instagram'
            AND f.shortcode IN (
              SELECT shortcode FROM ingest_jobs
               WHERE sender_id = $1 AND shortcode IS NOT NULL
            )
          ORDER BY f.created_at DESC, f.id DESC
          LIMIT $2`,
        [userId, limit]
      );

      if (rows.length > 0) {
        return {
          text: buildProfile(rows, "user"),
          scope: "user",
          garmentCount: rows.length,
        };
      }
    }

    if (!FALLBACK_TO_GLOBAL) {
      return { text: null, scope: "none", garmentCount: 0 };
    }

    const rows = await query<Row>(
      `SELECT ${select}
         FROM ${fashionTable} f
        WHERE f.source = 'instagram'
        ORDER BY f.created_at DESC, f.id DESC
        LIMIT $1`,
      [limit]
    );

    if (rows.length === 0) {
      return { text: null, scope: "none", garmentCount: 0 };
    }

    return {
      text: buildProfile(rows, "global"),
      scope: "global",
      garmentCount: rows.length,
    };
  } catch (err) {
    console.warn("[prefs] 讀不到使用者偏好：", err);
    return { text: null, scope: "none", garmentCount: 0 };
  }
}
