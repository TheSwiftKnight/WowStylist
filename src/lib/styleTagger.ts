// 用 Claude 把 text_description 讀成三個標籤（風格 / 色系 / 形容詞）。
//
// pipeline 寫進 RDS 的 fashion_items.text_description 是一段英文描述，
// 例如 "A cream oversized ribbed knit sweater with dropped shoulders…"。
// 這裡把那一行丟給 Claude，要它吐回風向標要的三格：
//
//     風格 style      極簡 / 學院風 / Y2K…（整體美學）
//     色系 palette     霧灰 / 中藍丹寧…（主色）
//     形容詞 adjective 低調 / 俐落…（氛圍）
//
// 寫進 Vercel 那台的 garment_style_tags（跟 002 的種子資料同一張表），
// 不碰 RDS —— RDS 是 pipeline 的地盤，重跑會被 ON CONFLICT 蓋掉。
// 之後 src/lib/tags.ts 的 aggregateGarmentStyleTags() 就會把它們
// 算成權重長到 style 風向標上。

import { fashionTable, query } from "@/lib/rds";
import { styleQuery } from "@/lib/styleDb";

/** 一次送進 Claude 的單品數。太大容易漏行，太小浪費 round trip。 */
const BATCH_SIZE = 12;

/** 一次 run 最多標幾件，免得一顆按鈕燒掉整包 token。 */
const DEFAULT_LIMIT = 60;

// 既有的風格字彙。給 Claude 當參考，讓標籤會重複、標籤雲才聚得起來；
// 真的都不像時允許它自己造一個新的。
const STYLE_VOCAB = [
  "極簡", "法式優雅", "美式復古", "Y2K", "學院風",
  "甜美芭蕾", "居家鬆弛", "街頭休閒", "波希米亞", "老錢風",
];

const ADJECTIVE_VOCAB = [
  "低調", "俐落", "溫柔", "復古", "慵懶", "乾淨俐落", "濃郁", "細緻",
  "鬆弛感", "搶眼", "中性帥氣", "暖調", "沉穩", "隨性", "有故事感",
  "端正", "秀氣",
];

const SYSTEM_PROMPT = `你是服飾標籤員。使用者給你一批單品的英文描述，
你要替每一件標三個繁體中文標籤：

  style     風格，整體美學。優先從這些選：${STYLE_VOCAB.join("、")}。
            都不像才自己給一個新的（2-5 字）。
  palette   色系，描述裡的主色。用具體的顏色名，例如 霧灰、純黑、奶茶棕、
            中藍丹寧、鼠尾草綠。丹寧要寫成「◯◯丹寧」。
  adjective 形容詞，穿起來的氛圍。優先從這些選：${ADJECTIVE_VOCAB.join("、")}。

規則：
- 每個標籤最多 5 個字，不要標點、不要英文（Y2K 除外）。
- 只根據描述裡寫的東西判斷，描述沒提到顏色就從材質質感推最接近的，不要亂編花樣。
- 只輸出 JSON 陣列，不要任何說明文字或程式碼框：
  [{"i":0,"style":"極簡","palette":"霧灰","adjective":"低調"}, ...]
- 陣列長度、順序、i 都要跟輸入的單品一一對應。`;

export type StyleTagTriple = {
  style: string;
  palette: string;
  adjective: string;
};

type Pending = {
  id: number;
  sourceItemId: string;
  category: "top" | "pants";
  description: string;
};

function model(): string {
  return process.env.TAG_MODEL || process.env.CHAT_MODEL || "claude-haiku-4-5";
}

/** 只留 5 個字以內的乾淨標籤；空字串代表這格失敗。 */
function clean(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.replace(/[\s。，、,.]/g, "").slice(0, 5);
}

/** Claude 偶爾會包一層 ```json，把框拆掉再 parse。 */
function parseJsonArray(text: string): unknown[] {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = (fenced ? fenced[1] : text).trim();
  const start = body.indexOf("[");
  const end = body.lastIndexOf("]");
  if (start === -1 || end === -1) return [];
  try {
    const parsed = JSON.parse(body.slice(start, end + 1));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * 一批描述 → 一批標籤。回傳的 Map key 是輸入陣列的 index，
 * Claude 漏標或格式壞掉的那幾件就不會在裡面（呼叫端跳過即可）。
 */
export async function generateStyleTags(
  items: { category: string; description: string }[]
): Promise<Map<number, StyleTagTriple>> {
  const out = new Map<number, StyleTagTriple>();
  if (items.length === 0) return out;

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error("[styleTagger] 沒設 ANTHROPIC_API_KEY，標不了");
    return out;
  }

  const listing = items
    .map(
      (item, i) =>
        `${i}. [${item.category}] ${item.description.replace(/\s+/g, " ").slice(0, 400)}`
    )
    .join("\n");

  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: model(),
        max_tokens: 100 * items.length + 200,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: listing }],
      }),
    });

    if (!res.ok) {
      console.error(
        `[styleTagger] Anthropic API 失敗 HTTP ${res.status}:`,
        await res.text()
      );
      return out;
    }

    const data = (await res.json()) as {
      content?: { type: string; text?: string }[];
    };
    const text = data.content?.find((c) => c.type === "text")?.text ?? "";

    for (const row of parseJsonArray(text)) {
      const r = row as Record<string, unknown>;
      const i = Number(r.i);
      if (!Number.isInteger(i) || i < 0 || i >= items.length) continue;

      const triple = {
        style: clean(r.style),
        palette: clean(r.palette),
        adjective: clean(r.adjective),
      };

      // 三格都要有東西，缺一格就整件跳過 —— 空字串會在標籤雲上變成幽靈標籤
      if (!triple.style || !triple.palette || !triple.adjective) continue;
      out.set(i, triple);
    }
  } catch (e) {
    console.error("[styleTagger] Anthropic API 錯誤:", e);
  }

  return out;
}

/** RDS 上有、但 garment_style_tags 還沒標過的單品。 */
async function listUntagged(limit: number): Promise<Pending[]> {
  const rows = await query<{
    id: number;
    source_item_id: string;
    category: string;
    text_description: string;
  }>(
    `SELECT id, source_item_id, category, text_description
       FROM ${fashionTable}
      WHERE source = 'instagram'
        AND text_description IS NOT NULL
        AND text_description <> ''
      ORDER BY created_at DESC, id DESC
      LIMIT $1`,
    [Math.max(limit * 4, 200)]
  );

  const tagged = new Set(
    (
      await styleQuery<{ source_item_id: string }>(
        `SELECT source_item_id FROM garment_style_tags`
      )
    ).map((r) => r.source_item_id)
  );

  return rows
    .filter((row) => !tagged.has(row.source_item_id))
    .slice(0, limit)
    .map((row) => ({
      id: row.id,
      sourceItemId: row.source_item_id,
      category: row.category === "pants" ? ("pants" as const) : ("top" as const),
      description: row.text_description,
    }));
}

async function upsert(item: Pending, tags: StyleTagTriple): Promise<void> {
  await styleQuery(
    `INSERT INTO garment_style_tags
       (source_item_id, fashion_item_id, category, style, palette, adjective)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (source_item_id) DO UPDATE SET
       fashion_item_id = EXCLUDED.fashion_item_id,
       category        = EXCLUDED.category,
       style           = EXCLUDED.style,
       palette         = EXCLUDED.palette,
       adjective       = EXCLUDED.adjective,
       updated_at      = CURRENT_TIMESTAMP`,
    [
      item.sourceItemId,
      item.id,
      item.category,
      tags.style,
      tags.palette,
      tags.adjective,
    ]
  );
}

/**
 * 把還沒標過的單品補上標籤。
 *
 * 已經標過的（包含 002 的種子資料、使用者自己改過的）一律不動，
 * 所以重跑很便宜：沒有新單品的時候一次 Claude 都不會打。
 */
export async function tagUntaggedGarments(
  limit = DEFAULT_LIMIT
): Promise<{ tagged: number; pending: number; failed: number }> {
  const pending = await listUntagged(limit);
  if (pending.length === 0) return { tagged: 0, pending: 0, failed: 0 };

  console.log(`[styleTagger] ${pending.length} 件還沒標，開始打 Claude`);

  let tagged = 0;

  // 一批一批來，不要一次全開 —— 同時打太多會被 rate limit 擋掉
  for (let i = 0; i < pending.length; i += BATCH_SIZE) {
    const batch = pending.slice(i, i + BATCH_SIZE);
    const result = await generateStyleTags(batch);

    for (const [index, tags] of result) {
      const item = batch[index];
      if (!item) continue;
      try {
        await upsert(item, tags);
        tagged += 1;
      } catch (e) {
        console.error(`[styleTagger] ${item.sourceItemId} 寫入失敗:`, e);
      }
    }
  }

  const failed = pending.length - tagged;
  console.log(`[styleTagger] 標好 ${tagged} 件${failed ? `，失敗 ${failed} 件` : ""}`);

  return { tagged, pending: pending.length, failed };
}

/** 還沒標的件數（畫面上要顯示「有幾件等著標」用）。 */
export async function countUntagged(): Promise<number> {
  try {
    return (await listUntagged(9999)).length;
  } catch {
    return 0;
  }
}
