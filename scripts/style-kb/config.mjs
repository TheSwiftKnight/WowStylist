// 爬取設定。改這裡就好，其他檔案不用動。
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(here, "../..");

export const PATHS = {
  styles: path.join(here, "styles.json"),
  outDir: path.join(ROOT, "data/style-kb"),
  kb: path.join(ROOT, "data/style-kb/style_kb.jsonl"),
  misses: path.join(ROOT, "data/style-kb/misses.jsonl"),
  cache: path.join(ROOT, "data/style-kb/cache"),
};

// 搜尋層只找這些站。Exa 的 includeDomains 上限 1200，這裡遠低於上限。
export const DOMAINS = {
  en: [
    "whowhatwear.com", "gq.com", "mrporter.com", "vogue.com", "harpersbazaar.com",
    "elle.com", "refinery29.com", "instyle.com", "marieclaire.com",
    "highsnobiety.com", "esquire.com", "thezoereport.com",
  ],
  zh: [
    "dappei.com", "popbee.com", "marieclaire.com.tw", "vogue.com.tw", "elle.com.tw",
    "bella.tw", "harpersbazaar.com.tw", "gq.com.tw", "beauty321.com", "styletc.com",
  ],
};

export const QUERY = {
  en: (s) => `${s.key.replace(/_/g, " ")} outfit ideas how to style`,
  zh: (s) => `${s.zh} 穿搭 怎麼穿 單品 教學`,
};

export const CRAWL = {
  // ── 產出目標 ──
  outfitsPerStyle: Number(process.env.KB_OUTFITS_PER_STYLE || 5), // 每個風格湊滿 5 套就收工
  maxArticlesPerStyle: 4,   // 湊不滿也最多讀這麼多篇，避免無底洞
  resultsPerStyle: 6,       // 搜尋層拿幾筆備用

  // ── 速度 ──
  styleConcurrency: Number(process.env.KB_CONCURRENCY || 3),
  // 一篇文章通常就能給好幾套，所以同一個風格的文章是「依序」讀的（才停得準），
  // 平行化發生在風格之間。

  sinceMonths: 24,
  perHostDelayMs: 1200,
  fetchTimeoutMs: 20000,
  maxRetries: 2,
  respectRobots: true,
  userAgent:
    "WowStylistBot/0.1 (+https://github.com/; contact: yang@wescb.com) Mozilla/5.0 (compatible)",

  // Exa 已經把內文一起回來了 → 預設不再重抓原頁（省掉每篇一次 HTTP 往返）。
  // 只有 Exa 沒給 text，或 --refetch 時才真的去抓。
  preferSearchText: true,
};

// 抽取層
export const EXTRACT = {
  defaultProvider: process.env.KB_LLM_PROVIDER || "openrouter",
  model: {
    openrouter: process.env.KB_EXTRACT_MODEL || "nvidia/nemotron-3-ultra-550b-a55b:free",
    openai: process.env.KB_EXTRACT_MODEL || "gpt-4o-mini",
    anthropic: process.env.KB_EXTRACT_MODEL || "claude-haiku-4-5",
  },
  maxTokens: 8000,
  // 填欄位不需要長考。"low" 省配額也大幅降延遲；設成 "" 就不帶這個參數。
  reasoningEffort: process.env.KB_REASONING_EFFORT ?? "low",
  // 送進 LLM 的內文上限。這是延遲的主要來源之一，砍短比什麼都有效。
  maxArticleChars: Number(process.env.KB_ARTICLE_CHARS || 9000),
};

// 收錄門檻（lib/extract.mjs 的 validateOutfit()）
export const ACCEPT = {
  requireTopAndBottom: true, // items 一定要有 top 和 bottom，否則組不成一套
  minDescriptionChars: 15,   // description 太短代表模型在敷衍
  minConfidence: 0.5,
  requireDo: true,
  maxOovRatio: 0.5,
};
