// 第二階段排序：把風格查表拿到的候選商品，依「使用者長期偏好 + 當下這句話」重排。
//
// 這是 HachThon 的 rank_products.py 搬進來的版本。
//
//     風格（LLM 分類器給的 [風格:] 標籤）
//          ↓  data/style-kb/style_kb.jsonl（已經離線跑好相似度，含 matches）
//     每個 category 各 K 個候選商品
//          ↓
//     S_final = 0.67 × S_user + 0.33 × S_query
//          ↓
//     每個 category 取 Top-M
//
// 跟 Python 版的三個差異：
//
// 1. query embedding 走 Hugging Face Inference API，不在本機載
//    sentence-transformers（省掉 2GB 的模型下載，跟 pipeline 那邊
//    fashion_encoder.py 用的是同一條路、同一個模型）。
//
// 2. 使用者偏好改成真的讀得到。Python 版查的 `user_fashion_preferences`
//    表並不存在；這裡從 fashion_items（source='instagram'）取，
//    用 ingest_jobs.sender_id 對回 LINE 的 userId。
//
//    注意這裡跨了兩台 RDS：商品向量在商品那台（PRODUCTS_DB_*），
//    使用者偏好在 IG 那台（DB_*）。兩邊都是 BGE-M3 編的、都已經
//    L2 normalize，所以在同一個語意空間，可以直接算 cosine。
//
// 3. 同一個風格在 KB 裡有好幾筆（不同來源文章），Python 版只取第一筆，
//    這裡把所有筆的 matches 併起來、依 product_id 去重取最高分。

import { readFileSync } from "fs";
import { join } from "path";
import {
  fashionTable,
  productsTable,
  query,
  queryProducts,
  hasSeparateProductsDb,
} from "@/lib/rds";

// ── 參數 ──────────────────────────────────────────────────────────────────────

export const USER_WEIGHT = 0.67;
export const QUERY_WEIGHT = 0.33;

export const TOP_M = 3;

const EMBEDDING_MODEL = "BAAI/bge-m3";

const STYLE_KB_PATH = join(
  process.cwd(),
  "data",
  "style-kb",
  "style_kb.jsonl"
);

/** 使用者自己沒有收藏紀錄時，要不要退回「所有人的收藏」當偏好 */
const FALLBACK_TO_GLOBAL_PREFS =
  process.env.RANK_FALLBACK_GLOBAL_PREFS !== "false";

// ── 型別 ──────────────────────────────────────────────────────────────────────

/** style_kb.jsonl 裡 matches[] 的一筆 */
export type StyleMatch = { product_id: number; score: number };

export type StyleCandidates = {
  style: string;
  styleZh: string | null;
  /** 這個風格的穿搭描述，給 debug 跟 LLM 寫理由用 */
  outfitText: string | null;
  top: StyleMatch[];
  bottom: StyleMatch[];
};

export type Product = {
  productId: number;
  category: string;
  embedding: number[];
  title: string | null;
  priceTwd: number | null;
  productUrl: string | null;
};

export type RankedProduct = {
  productId: number;
  title: string | null;
  priceTwd: number | null;
  productUrl: string | null;
  /** 離線算好的風格相似度（style_kb.jsonl 裡的 score） */
  styleScore: number | null;
  /** 跟使用者收藏的 IG 單品的平均 cosine；沒有收藏紀錄時是 null */
  userScore: number | null;
  /** 跟這次查詢文字的 cosine */
  queryScore: number;
  finalScore: number;
};

export type RankResult = {
  style: string;
  styleZh: string | null;
  outfitText: string | null;
  query: string;
  weights: { user: number; query: number };
  /** 這次用到的使用者偏好向量數（0 = 純 S_query） */
  userPrefCount: { top: number; bottom: number };
  /** 偏好是這個人自己的，還是退回全體 */
  userPrefScope: "user" | "global" | "none";
  top: RankedProduct[];
  bottom: RankedProduct[];
};

// ══════════════════════════════════════════════════════════════════════════════
// 1. 風格查表
// ══════════════════════════════════════════════════════════════════════════════

type StyleRecord = {
  style: string;
  style_zh?: string;
  aliases?: string[];
  occasion?: string[];
  season?: string[];
  outfit_text?: string;
  embed_text?: string;
  source_title?: string;
  source_url?: string;
  do?: string[];
  items?: {
    top?: { description?: string; matches?: StyleMatch[] };
    bottom?: { description?: string; matches?: StyleMatch[] };
  };
};

/**
 * 一筆「搭配建議」＝ style_kb.jsonl 的一行。
 *
 * loadStyleCandidates() 會把同一個風格的所有記錄合併成一個候選池再排序，
 * 所以推薦出來的三套其實是跨記錄配對的，do / embed_text / source_title
 * 在那一步就被丟掉了。要寫穿搭建議就得拿回這些欄位，並且知道每個
 * product_id 是從哪一筆建議來的（matches），才能把「這套」對回「那段建議」。
 */
export type StyleSuggestion = {
  style: string;
  styleZh: string | null;
  outfitText: string | null;
  embedText: string | null;
  sourceTitle: string | null;
  sourceUrl: string | null;
  dos: string[];
  topDescription: string | null;
  bottomDescription: string | null;
  /** product_id → 這筆建議裡的相似度分數 */
  topMatches: Map<number, number>;
  bottomMatches: Map<number, number>;
};

function toMatchMap(list: StyleMatch[] | undefined): Map<number, number> {
  const m = new Map<number, number>();
  for (const x of list ?? []) {
    const id = Number(x?.product_id);
    const score = Number(x?.score);
    if (Number.isFinite(id) && Number.isFinite(score)) m.set(id, score);
  }
  return m;
}

/** 拿一個風格底下「每一筆」搭配建議（不合併）。 */
export function loadStyleSuggestions(styleName: string): StyleSuggestion[] {
  const records = loadKb().get(styleName.trim().toLowerCase()) ?? [];
  return records.map((r) => ({
    style: r.style,
    styleZh: r.style_zh ?? null,
    outfitText: r.outfit_text ?? null,
    embedText: r.embed_text ?? null,
    sourceTitle: r.source_title ?? null,
    sourceUrl: r.source_url ?? null,
    dos: Array.isArray(r.do) ? r.do.filter((x) => typeof x === "string") : [],
    topDescription: r.items?.top?.description ?? null,
    bottomDescription: r.items?.bottom?.description ?? null,
    topMatches: toMatchMap(r.items?.top?.matches),
    bottomMatches: toMatchMap(r.items?.bottom?.matches),
  }));
}

let kbCache: Map<string, StyleRecord[]> | null = null;

/** 讀 style_kb.jsonl，用 style 跟 style_zh 兩個 key 都建索引。 */
function loadKb(): Map<string, StyleRecord[]> {
  if (kbCache) return kbCache;

  const index = new Map<string, StyleRecord[]>();

  let raw: string;
  try {
    raw = readFileSync(STYLE_KB_PATH, "utf-8");
  } catch (err) {
    console.warn("[rank] 讀不到 style_kb.jsonl：", err);
    kbCache = index;
    return index;
  }

  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let record: StyleRecord;
    try {
      record = JSON.parse(trimmed) as StyleRecord;
    } catch {
      continue;
    }

    for (const key of [record.style, record.style_zh]) {
      if (!key) continue;
      const k = key.trim().toLowerCase();
      const bucket = index.get(k);
      if (bucket) bucket.push(record);
      else index.set(k, [record]);
    }
  }

  kbCache = index;
  return index;
}

/** 測試或換檔之後叫一下。 */
export function resetStyleKbCache(): void {
  kbCache = null;
  profilesCache = null;
}

/** 同一個 product_id 出現在多筆記錄時，留分數最高的那個。 */
function mergeMatches(lists: (StyleMatch[] | undefined)[]): StyleMatch[] {
  const best = new Map<number, number>();

  for (const list of lists) {
    for (const match of list ?? []) {
      const id = Number(match?.product_id);
      const score = Number(match?.score);
      if (!Number.isFinite(id) || !Number.isFinite(score)) continue;
      const prev = best.get(id);
      if (prev === undefined || score > prev) best.set(id, score);
    }
  }

  return [...best.entries()]
    .map(([product_id, score]) => ({ product_id, score }))
    .sort((a, b) => b.score - a.score);
}

/**
 * 從 style_kb.jsonl 找一個風格的候選商品。
 * `styleName` 可以是 slug（old_money）或中文名（老錢風）。
 */
export function loadStyleCandidates(
  styleName: string
): StyleCandidates | null {
  const records = loadKb().get(styleName.trim().toLowerCase());
  if (!records || records.length === 0) return null;

  const top = mergeMatches(records.map((r) => r.items?.top?.matches));
  const bottom = mergeMatches(records.map((r) => r.items?.bottom?.matches));

  if (top.length === 0 && bottom.length === 0) {
    // KB 裡有這個風格，但還沒跑過 build_style_lookup
    return null;
  }

  return {
    style: records[0].style,
    styleZh: records[0].style_zh ?? null,
    outfitText: records.find((r) => r.outfit_text)?.outfit_text ?? null,
    top,
    bottom,
  };
}

/**
 * 一個風格的「可比對欄位」總表 —— 把該風格底下所有記錄的
 * aliases / occasion / season 聯集起來。
 *
 * 用途有兩個：
 *   1. 產生分類器 prompt 裡的風格資料庫（讓 LLM 能用場合、季節去語意匹配，
 *      而不是只認得風格名）
 *   2. 分類器沒給出可用的 [風格:] 時，程式端用這些欄位做關鍵字評分 fallback
 */
export type StyleProfile = {
  style: string;
  styleZh: string | null;
  aliases: string[];
  /** 依出現次數由多到少 */
  occasions: string[];
  seasons: string[];
};

let profilesCache: StyleProfile[] | null = null;

export function listStyleProfiles(): StyleProfile[] {
  if (profilesCache) return profilesCache;

  const byStyle = new Map<string, {
    styleZh: string | null;
    aliases: Set<string>;
    occasions: Map<string, number>;
    seasons: Map<string, number>;
  }>();

  const bump = (m: Map<string, number>, v: unknown) => {
    const t = String(v ?? "").trim();
    if (t) m.set(t, (m.get(t) ?? 0) + 1);
  };

  for (const records of loadKb().values()) {
    for (const r of records) {
      let entry = byStyle.get(r.style);
      if (!entry) {
        entry = { styleZh: r.style_zh ?? null, aliases: new Set(), occasions: new Map(), seasons: new Map() };
        byStyle.set(r.style, entry);
      }
      if (!entry.styleZh && r.style_zh) entry.styleZh = r.style_zh;
      for (const a of r.aliases ?? []) {
        const t = String(a).trim();
        if (t) entry.aliases.add(t);
      }
      for (const o of r.occasion ?? []) bump(entry.occasions, o);
      for (const s of r.season ?? []) bump(entry.seasons, s);
    }
  }

  const byCount = (m: Map<string, number>) =>
    [...m.entries()].sort((a, b) => b[1] - a[1]).map(([k]) => k);

  profilesCache = [...byStyle.entries()].map(([style, v]) => ({
    style,
    styleZh: v.styleZh,
    aliases: [...v.aliases],
    occasions: byCount(v.occasions),
    seasons: byCount(v.seasons),
  }));

  return profilesCache;
}

// ── 用 query 直接比對風格（分類器沒給出可用風格時的 fallback）──────────────
//
// 使用者打進來的不一定是風格名 ——「婚禮」「露營」「夏天」這些是場合和季節。
// KB 的每筆記錄都有 occasion / season，這裡把它們一起納入評分。
//
// 不用 embedding 做這件事的原因：embedQuery 要打 HF Inference API，
// 而這段是在分類器已經失手之後跑的補救，再多一次網路往返不划算；
// 而且 KB 的 occasion 本來就是中文短語，字面比對的命中率已經夠用。

const SEASON_ALIASES: Record<string, string[]> = {
  spring: ["春", "spring"],
  summer: ["夏", "summer"],
  fall: ["秋", "fall", "autumn"],
  autumn: ["秋", "fall", "autumn"],
  winter: ["冬", "winter"],
};

/** 太泛用的兩字詞，不能拿來當場合的部分比對，否則「婚禮賓客穿搭」會誤中「新中式穿搭」。 */
const GENERIC_FRAGMENTS = new Set([
  "穿搭", "風格", "造型", "服裝", "衣服", "搭配", "時尚", "日常", "場合", "感覺", "一點", "什麼",
]);

function norm(x: string): string {
  return x.toLowerCase().replace(/[\s\-_]+/g, "");
}

/** 名稱／別名：要整個詞出現，不做部分比對。 */
function containsTerm(queryNorm: string, term: string): boolean {
  const t = norm(term);
  return t.length >= 2 && queryNorm.includes(t);
}

/** 場合：允許兩字的部分比對（KB 寫「日常通勤」，使用者只打「通勤」），但排除泛用詞。 */
function containsOccasion(queryNorm: string, term: string): boolean {
  const t = norm(term);
  if (t.length < 2) return false;
  if (queryNorm.includes(t)) return true;
  if (t.length >= 4) {
    for (let i = 0; i + 2 <= t.length; i++) {
      const piece = t.slice(i, i + 2);
      if (/^[\u4e00-\u9fff]{2}$/.test(piece) && !GENERIC_FRAGMENTS.has(piece) && queryNorm.includes(piece)) {
        return true;
      }
    }
  }
  return false;
}

/** 季節：春夏秋冬是單字，不能套兩字門檻。 */
function containsSeason(queryNorm: string, term: string): boolean {
  const t = norm(term);
  return t.length >= 1 && queryNorm.includes(t);
}

export type StyleQueryMatch = {
  profile: StyleProfile;
  score: number;
  /** 命中了哪些東西，寫進 debug 訊息用 */
  hits: string[];
};

/**
 * 拿 query 去比對所有風格的 名稱／別名／場合／季節。
 *
 * 權重：名稱或別名 4、場合每個 1（最多兩個）、季節 1。
 * 名稱權重刻意高於「場合+季節」的總和，直接講出風格名的人意圖最明確。
 *
 * 回傳分數由高到低，呼叫端自己決定門檻。
 */
export function matchStylesByQuery(query: string): StyleQueryMatch[] {
  const q = norm(query);
  if (!q) return [];

  const out: StyleQueryMatch[] = [];

  for (const profile of listStyleProfiles()) {
    const hits: string[] = [];
    let score = 0;

    const names = [profile.styleZh, profile.style.replace(/_/g, " "), ...profile.aliases]
      .filter((x): x is string => Boolean(x));
    const nameHit = names.find((n) => containsTerm(q, n));
    if (nameHit) {
      score += 4;
      hits.push(`名稱/別名「${nameHit}」`);
    }

    const occHits = profile.occasions.filter((o) => containsOccasion(q, o)).slice(0, 2);
    if (occHits.length) {
      score += occHits.length;
      hits.push(`場合「${occHits.join("、")}」`);
    }

    const seasonHit = profile.seasons.find((s) =>
      (SEASON_ALIASES[s.toLowerCase()] ?? [s]).some((alias) => containsSeason(q, alias))
    );
    if (seasonHit) {
      score += 1;
      hits.push(`季節「${seasonHit}」`);
    }

    if (score > 0) out.push({ profile, score, hits });
  }

  return out.sort((a, b) => b.score - a.score);
}

/** 目前 KB 裡有哪些風格（debug / health 用）。 */
export function listStyles(): { style: string; styleZh: string | null }[] {
  const seen = new Map<string, string | null>();
  for (const records of loadKb().values()) {
    for (const record of records) {
      if (!seen.has(record.style)) {
        seen.set(record.style, record.style_zh ?? null);
      }
    }
  }
  return [...seen.entries()].map(([style, styleZh]) => ({ style, styleZh }));
}

// ══════════════════════════════════════════════════════════════════════════════
// 2. Query embedding（Hugging Face Inference API）
// ══════════════════════════════════════════════════════════════════════════════

function l2normalize(vector: number[]): number[] {
  let sum = 0;
  for (const v of vector) sum += v * v;
  const norm = Math.sqrt(sum);
  if (norm === 0) throw new Error("embedding 的長度是 0");
  return vector.map((v) => v / norm);
}

/** PostgreSQL 的 float8[] 有時候會以字串形式回來。 */
export function toVector(value: unknown): number[] {
  if (Array.isArray(value)) return value.map(Number);
  if (typeof value === "string") {
    const parsed = JSON.parse(value.replace(/^\{/, "[").replace(/\}$/, "]"));
    return (parsed as unknown[]).map(Number);
  }
  throw new Error(`看不懂的 embedding 型別：${typeof value}`);
}

/** 兩個都已經 L2 normalize 過，cosine 就是內積。 */
export function dot(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  let sum = 0;
  for (let i = 0; i < n; i++) sum += a[i] * b[i];
  return sum;
}

const HF_ENDPOINTS = [
  `https://router.huggingface.co/hf-inference/models/${EMBEDDING_MODEL}/pipeline/feature-extraction`,
  `https://api-inference.huggingface.co/models/${EMBEDDING_MODEL}`,
];

/** 把一句話編成 BGE-M3 向量（已 L2 normalize）。 */
export async function embedQuery(text: string): Promise<number[]> {
  const token = process.env.HF_TOKEN;
  if (!token) {
    throw new Error("HF_TOKEN 沒設，無法產生 query embedding");
  }

  const trimmed = text.trim();
  if (!trimmed) throw new Error("query 文字是空的");

  let lastError: unknown = null;

  // HF 換過網域，兩個都試一次
  for (const endpoint of HF_ENDPOINTS) {
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ inputs: trimmed }),
        signal: AbortSignal.timeout(20_000),
      });

      if (!res.ok) {
        lastError = new Error(
          `HF ${res.status}: ${(await res.text()).slice(0, 200)}`
        );
        continue;
      }

      const data = (await res.json()) as unknown;

      // 可能是 number[] 或 [number[]]
      let vector: unknown = data;
      while (Array.isArray(vector) && Array.isArray(vector[0])) {
        vector = vector[0];
      }

      if (!Array.isArray(vector) || typeof vector[0] !== "number") {
        lastError = new Error("HF 回傳的格式看不懂");
        continue;
      }

      return l2normalize((vector as number[]).map(Number));
    } catch (err) {
      lastError = err;
    }
  }

  throw new Error(`query embedding 失敗：${String(lastError)}`);
}

// ══════════════════════════════════════════════════════════════════════════════
// 3. 商品向量
// ══════════════════════════════════════════════════════════════════════════════

type ProductSource = {
  table: string;
  idColumn: string;
  /** 只取這個 source 的列（統一表才需要） */
  sourceFilter: string | null;
  hasTitle: boolean;
  hasPrice: boolean;
  hasUrl: boolean;
  /** 有沒有 Claude 寫的文字描述（寫穿搭建議時要用） */
  hasDescription: boolean;
  /** 這張表的 bottom 叫什麼：'bottom' 或 'pants' */
  bottomCategory: string;
  /** 商品是在自己那台 RDS，還是跟 IG 共用一台 */
  database: "products" | "ig";
};

let productSourceCache: ProductSource | null | undefined;

async function columnsOf(
  table: string,
  where: "products" | "ig"
): Promise<Set<string>> {
  const run = where === "products" ? queryProducts : query;
  const rows = await run<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = $1`,
    [table]
  );
  return new Set(rows.map((r) => r.column_name));
}

/**
 * 商品向量放在哪？
 *
 * 正常情況：商品是自己一台 RDS（PRODUCTS_DB_*），表名 products。
 *
 * 但兩批資料放同一台的情況也支援 —— 沒設 PRODUCTS_DB_HOST 時，
 * queryProducts 會退回 IG 那條連線，這裡就再多找一種擺法：
 * fashion_items 裡 source='product' 的列。
 *
 * 都找不到就回 null，呼叫端會給出清楚的錯誤。
 */
export async function resolveProductSource(): Promise<ProductSource | null> {
  if (productSourceCache !== undefined) return productSourceCache;

  const database = hasSeparateProductsDb ? "products" : "ig";

  try {
    // ── 1. 商品表 ──
    const products = await columnsOf(productsTable, "products");

    if (products.has("embedding") && products.has("product_id")) {
      productSourceCache = {
        table: productsTable,
        idColumn: "product_id",
        sourceFilter: null,
        hasTitle: products.has("title"),
        hasPrice: products.has("price_twd"),
        hasUrl: products.has("product_url"),
        hasDescription: products.has("text_description"),
        bottomCategory: "bottom",
        database,
      };
      return productSourceCache;
    }

    // ── 2. 跟 IG 共用一台時，商品也可能是寫進 fashion_items 的 ──
    if (!hasSeparateProductsDb) {
      const unified = await columnsOf(fashionTable, "ig");

      if (unified.has("embedding") && unified.has("source")) {
        const [row] = await query<{ n: string }>(
          `SELECT count(*)::text AS n FROM ${fashionTable} WHERE source = 'product'`
        );

        if (Number(row?.n ?? 0) > 0) {
          productSourceCache = {
            table: fashionTable,
            idColumn: "source_item_id",
            sourceFilter: "product",
            hasTitle: unified.has("title"),
            hasPrice: unified.has("price_twd"),
            hasUrl: unified.has("product_url"),
            hasDescription: unified.has("text_description"),
            bottomCategory: "pants",
            database: "ig",
          };
          return productSourceCache;
        }
      }
    }
  } catch (err) {
    console.warn("[rank] 找不到商品向量的來源：", err);
  }

  productSourceCache = null;
  return null;
}

export function resetProductSourceCache(): void {
  productSourceCache = undefined;
}

/** 只撈候選的那幾十筆，不要整表拉下來（embedding 一筆 1024 個 float）。 */
export async function loadCandidateProducts(
  productIds: number[]
): Promise<Map<number, Product>> {
  const result = new Map<number, Product>();
  if (productIds.length === 0) return result;

  const source = await resolveProductSource();
  if (!source) return result;

  const cols = [
    `${source.idColumn} AS product_id`,
    "category",
    "embedding",
    source.hasTitle ? "title" : "NULL AS title",
    source.hasPrice ? "price_twd" : "NULL AS price_twd",
    source.hasUrl ? "product_url" : "NULL AS product_url",
  ].join(", ");

  const params: unknown[] = [
    // source_item_id 是 text，product_id 是 bigint，都轉成字串比對最保險
    productIds.map(String),
  ];

  let where = `WHERE ${source.idColumn}::text = ANY($1) AND embedding IS NOT NULL`;

  if (source.sourceFilter) {
    params.push(source.sourceFilter);
    where += ` AND source = $${params.length}`;
  }

  // 商品在自己那台（沒設 PRODUCTS_DB_* 時 queryProducts 會退回 IG 那條）
  const run = source.database === "products" ? queryProducts : query;

  const rows = await run<{
    product_id: string | number;
    category: string;
    embedding: unknown;
    title: string | null;
    price_twd: string | number | null;
    product_url: string | null;
  }>(`SELECT ${cols} FROM ${source.table} ${where}`, params);

  for (const row of rows) {
    try {
      result.set(Number(row.product_id), {
        productId: Number(row.product_id),
        category: row.category,
        embedding: l2normalize(toVector(row.embedding)),
        title: row.title,
        priceTwd: row.price_twd === null ? null : Number(row.price_twd),
        productUrl: row.product_url,
      });
    } catch (err) {
      console.warn(`[rank] 商品 ${row.product_id} 的 embedding 有問題：`, err);
    }
  }

  return result;
}

/**
 * 撈這幾件商品的文字描述（寫穿搭建議時要餵給 LLM）。
 *
 * 跟 loadCandidateProducts 分開是因為那支會一起撈 embedding（一筆 1024 個 float），
 * 這裡只要文字，而且只查最後選中的那兩件。
 * 商品表沒有 text_description 欄位時退回 title，再沒有就跳過。
 */
export async function loadProductDescriptions(
  productIds: number[]
): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  if (productIds.length === 0) return out;

  const source = await resolveProductSource();
  if (!source) return out;

  const descCol = source.hasDescription
    ? "text_description"
    : source.hasTitle
      ? "title"
      : null;

  if (!descCol) {
    console.warn("[rank] 商品表既沒有 text_description 也沒有 title，寫不出穿搭建議");
    return out;
  }
  if (!source.hasDescription) {
    console.warn(`[rank] ${source.table} 沒有 text_description，改用 title 當商品描述`);
  }

  const params: unknown[] = [productIds.map(String)];
  let where = `WHERE ${source.idColumn}::text = ANY($1)`;
  if (source.sourceFilter) {
    params.push(source.sourceFilter);
    where += ` AND source = $${params.length}`;
  }

  const run = source.database === "products" ? queryProducts : query;

  try {
    const rows = await run<{ product_id: string | number; description: string | null }>(
      `SELECT ${source.idColumn} AS product_id, ${descCol} AS description
         FROM ${source.table} ${where}`,
      params
    );
    for (const row of rows) {
      const text = (row.description ?? "").trim();
      if (text) out.set(Number(row.product_id), text);
    }
  } catch (err) {
    console.warn("[rank] 撈商品描述失敗：", err);
  }

  return out;
}

// ══════════════════════════════════════════════════════════════════════════════
// 4. 使用者偏好
// ══════════════════════════════════════════════════════════════════════════════

/** style_kb 用 top/bottom，fashion_items 用 top/pants。 */
function igCategory(logical: "top" | "bottom"): string {
  return logical === "bottom" ? "pants" : "top";
}

/**
 * 使用者的長期偏好 = 他自己分享進 LINE bot、被 pipeline 拆出來的 IG 單品。
 *
 * fashion_items 沒有 user 欄位（那張表只描述衣服），分享人記在
 * ingest_jobs.sender_id，所以靠 shortcode 對回去。
 *
 * 這個人自己沒有收藏 → 退回「所有人的收藏」，demo 才不會變成純 S_query。
 * 不想要這個行為就把 RANK_FALLBACK_GLOBAL_PREFS 設成 "false"。
 */
export async function loadUserPreferenceEmbeddings(
  userId: string | null,
  logicalCategory: "top" | "bottom",
  limit = 200
): Promise<{ embeddings: number[][]; scope: "user" | "global" | "none" }> {
  const category = igCategory(logicalCategory);

  const parse = (rows: { embedding: unknown }[]) =>
    rows
      .map((row) => {
        try {
          return l2normalize(toVector(row.embedding));
        } catch {
          return null;
        }
      })
      .filter((v): v is number[] => v !== null);

  try {
    if (userId) {
      const rows = await query<{ embedding: unknown }>(
        // 子查詢而不是 JOIN —— 同一則貼文重送過的話 ingest_jobs 會有多列，
        // JOIN 會讓同一件衣服在平均裡被算好幾次。
        `SELECT f.embedding
           FROM ${fashionTable} f
          WHERE f.source = 'instagram'
            AND f.category = $1
            AND f.embedding IS NOT NULL
            AND f.shortcode IN (
              SELECT shortcode FROM ingest_jobs
               WHERE sender_id = $2 AND shortcode IS NOT NULL
            )
          ORDER BY f.id DESC
          LIMIT $3`,
        [category, userId, limit]
      );

      const embeddings = parse(rows);
      if (embeddings.length > 0) return { embeddings, scope: "user" };
    }

    if (!FALLBACK_TO_GLOBAL_PREFS) {
      return { embeddings: [], scope: "none" };
    }

    const rows = await query<{ embedding: unknown }>(
      `SELECT embedding FROM ${fashionTable}
        WHERE source = 'instagram'
          AND category = $1
          AND embedding IS NOT NULL
        ORDER BY id DESC
        LIMIT $2`,
      [category, limit]
    );

    const embeddings = parse(rows);
    return {
      embeddings,
      scope: embeddings.length > 0 ? "global" : "none",
    };
  } catch (err) {
    console.warn("[rank] 讀不到使用者偏好：", err);
    return { embeddings: [], scope: "none" };
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// 5. 評分
// ══════════════════════════════════════════════════════════════════════════════

/** S_user = 跟所有偏好向量的平均 cosine；沒有偏好就回 null。 */
export function userScore(
  productEmbedding: number[],
  userEmbeddings: number[][]
): number | null {
  if (userEmbeddings.length === 0) return null;
  let sum = 0;
  for (const e of userEmbeddings) sum += dot(productEmbedding, e);
  return sum / userEmbeddings.length;
}

/** 沒有偏好紀錄時就純看這次查詢。 */
export function finalScore(
  user: number | null,
  queryScore: number
): number {
  if (user === null) return queryScore;
  return USER_WEIGHT * user + QUERY_WEIGHT * queryScore;
}

function round(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

export function rankCategory(
  candidates: StyleMatch[],
  products: Map<number, Product>,
  userEmbeddings: number[][],
  queryEmbedding: number[],
  topM = TOP_M
): RankedProduct[] {
  const ranked: RankedProduct[] = [];

  for (const candidate of candidates) {
    const product = products.get(candidate.product_id);
    if (!product) continue; // 候選在 KB 裡但商品庫查不到

    const u = userScore(product.embedding, userEmbeddings);
    const q = dot(product.embedding, queryEmbedding);

    ranked.push({
      productId: product.productId,
      title: product.title,
      priceTwd: product.priceTwd,
      productUrl: product.productUrl,
      styleScore: candidate.score ?? null,
      userScore: u === null ? null : round(u),
      queryScore: round(q),
      finalScore: round(finalScore(u, q)),
    });
  }

  ranked.sort((a, b) => b.finalScore - a.finalScore);
  return ranked.slice(0, topM);
}

// ══════════════════════════════════════════════════════════════════════════════
// 6. 主流程
// ══════════════════════════════════════════════════════════════════════════════

export class RankError extends Error {}

/**
 * 完整的第二階段排序。
 *
 *     風格 → K 個候選 → S_user + S_query → 加權排序 → Top-M
 */
export async function rankProducts(options: {
  userId: string | null;
  styleName: string;
  queryText: string;
  topM?: number;
}): Promise<RankResult> {
  const { userId, styleName, queryText } = options;
  const topM = options.topM ?? TOP_M;

  // 1. 風格查表
  const candidates = loadStyleCandidates(styleName);
  if (!candidates) {
    throw new RankError(`style_kb.jsonl 裡找不到風格「${styleName}」`);
  }

  // 2. 候選商品向量
  const productIds = [
    ...candidates.top.map((c) => c.product_id),
    ...candidates.bottom.map((c) => c.product_id),
  ];

  const products = await loadCandidateProducts(productIds);

  if (products.size === 0) {
    const source = await resolveProductSource();
    throw new RankError(
      source
        ? `${source.table} 裡找不到這 ${productIds.length} 個候選商品的 embedding`
        : "找不到商品向量的來源（fashion_items 沒有 source='product' 的列，也沒有 products 表）"
    );
  }

  // 3. 這次查詢的向量 + 使用者偏好（三件事互不相干，一起跑）
  const [queryEmbedding, topPrefs, bottomPrefs] = await Promise.all([
    embedQuery(queryText),
    loadUserPreferenceEmbeddings(userId, "top"),
    loadUserPreferenceEmbeddings(userId, "bottom"),
  ]);

  const scope =
    topPrefs.scope === "user" || bottomPrefs.scope === "user"
      ? "user"
      : topPrefs.scope === "global" || bottomPrefs.scope === "global"
        ? "global"
        : "none";

  return {
    style: candidates.style,
    styleZh: candidates.styleZh,
    outfitText: candidates.outfitText,
    query: queryText,
    weights: { user: USER_WEIGHT, query: QUERY_WEIGHT },
    userPrefCount: {
      top: topPrefs.embeddings.length,
      bottom: bottomPrefs.embeddings.length,
    },
    userPrefScope: scope,
    top: rankCategory(
      candidates.top,
      products,
      topPrefs.embeddings,
      queryEmbedding,
      topM
    ),
    bottom: rankCategory(
      candidates.bottom,
      products,
      bottomPrefs.embeddings,
      queryEmbedding,
      topM
    ),
  };
}
