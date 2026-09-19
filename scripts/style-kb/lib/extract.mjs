// 抽取層：一篇文章 -> N 套穿搭（每套 = 一筆 KB 紀錄）。
//
// 為什麼一次抽多套：時尚媒體大量是「15 個 XX 風穿搭」的 listicle，一篇裡本來就有好幾套。
// 一次要 5 套跟一次要 1 套，LLM 的延遲差不多，但產出是 5 倍 —— 這是最有效的加速手段。
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { postJson } from "./http.mjs";
import { parseLooseJson } from "./json.mjs";
import { EXTRACT, ACCEPT, CRAWL, PATHS } from "../config.mjs";
import { normalizeCategory, vocabPrompt } from "./vocab.mjs";

const ITEM = {
  type: "object",
  properties: {
    category: { type: "string", description: "品類，必須從受控詞彙表挑一個 snake_case 值" },
    description: { type: "string", description: "一句英文自然語言，把顏色、材質、版型、氛圍全寫進去。這句會被 embed 拿去做向量檢索。" },
  },
  required: ["category", "description"],
};

const OUTFIT = {
  type: "object",
  properties: {
    items: {
      type: "object",
      description: "這套的上下身。兩個都要有。",
      properties: { top: ITEM, bottom: ITEM },
      required: ["top", "bottom"],
    },
    outfit_text: { type: "string", description: "整套的英文短語，用 + 串起來，可以包含鞋子包包配件，例如 'cream long sleeve tee + cream cropped trousers + sandals + brown tote bag'" },
    palette: { type: "array", items: { type: "string" }, maxItems: 5, description: "hex 色碼" },
    palette_names: { type: "array", items: { type: "string" }, maxItems: 5 },
    fabrics: { type: "array", items: { type: "string" }, maxItems: 6 },
    do: { type: "array", items: { type: "string" }, maxItems: 4, description: "這套的搭配要訣，繁體中文，每條 <= 20 字" },
    occasion: { type: "array", items: { type: "string" }, maxItems: 5, description: "適合場合，繁體中文" },
    season: { type: "array", items: { type: "string" }, maxItems: 4, description: "spring / summer / fall / winter" },
  },
  required: ["items", "outfit_text", "do"],
};

const SCHEMA = {
  type: "object",
  properties: {
    style_present: { type: "boolean", description: "這篇文章是否真的在講這個風格" },
    confidence: { type: "number", description: "整篇都在講這風格 0.9；只有一段 0.7；順帶提到 0.5；幾乎沒提 0.2" },
    outfits: { type: "array", items: OUTFIT, description: "從文章抽出的搭配，最多 5 套。文章有幾套就給幾套，不要湊數。" },
  },
  required: ["style_present", "confidence", "outfits"],
};

const TOOL_NAME = "emit_outfits";

function buildPrompt(style, article, want) {
  return `你是穿搭知識庫的結構化抽取器。輸出會餵給向量檢索與商品庫查詢。

風格：「${style.zh}」（${style.key}，別名：${(style.aliases || []).join("、")}）
文章標題：${article.title || "(無)"}

任務：從下面這篇文章抽出**最多 ${want} 套**這個風格的穿搭。文章有幾套就給幾套，不要湊數、不要重複。

每一套要有：
- items.top 和 items.bottom（兩個都必填，缺一套就不算一套）
  - category：從下面詞彙表挑，snake_case，不帶顏色材質品牌
${vocabPrompt(["top", "bottom"])}
  - description：一句英文自然語言，把顏色、材質、版型、氛圍寫進去。
    例："A cream long-sleeve crochet top with a soft romantic cottagecore appearance."
    這句會被 embed，所以要具體、可檢索，不要只寫 "a nice top"。
- outfit_text：整套的英文短語用 + 串起來，可以含鞋包配件
- do：這套的搭配要訣，繁體中文，每條 20 字內
- palette / palette_names / fabrics / occasion / season：文章有提到才填

規則：文章沒描述的不要編造。description 必須反映文章實際寫的內容，不是你的時尚常識。

---- 內文開始 ----
${(article.text || "").slice(0, EXTRACT.maxArticleChars)}
---- 內文結束 ----`;
}

async function dumpDebug(tag, payload) {
  try {
    const dir = path.join(PATHS.outDir, "debug");
    await fs.mkdir(dir, { recursive: true });
    const f = path.join(dir, `${tag}-${crypto.randomBytes(4).toString("hex")}.json`);
    await fs.writeFile(f, JSON.stringify(payload, null, 2));
    return f;
  } catch { return null; }
}

/**
 * Nemotron 不支援 response_format / structured_outputs（只有 tools / tool_choice /
 * reasoning），tool_call 的 arguments 常是寬鬆 JSON，所以一律走 parseLooseJson。
 */
export async function parseOpenAICompatible(res, tag) {
  const choice = res.choices?.[0];
  const msg = choice?.message;
  if (!msg) { await dumpDebug(tag, res); throw new Error("回應沒有 message"); }

  if (choice.finish_reason === "length") {
    const f = await dumpDebug(`${tag}-truncated`, res);
    throw new Error(`output_truncated（finish_reason=length，調高 EXTRACT.maxTokens 或調低 outfitsPerStyle）${f ? ` → ${f}` : ""}`);
  }

  const raw =
    msg.tool_calls?.[0]?.function?.arguments ??
    (Array.isArray(msg.content) ? msg.content.map((c) => c.text || "").join("") : msg.content);

  try {
    return parseLooseJson(raw).value;
  } catch (e) {
    const f = await dumpDebug(tag, { error: e.message, finish_reason: choice.finish_reason, message: msg, usage: res.usage });
    throw new Error(`${e.message}${f ? ` → ${f}` : ""}`);
  }
}

async function viaOpenRouter(style, article, want) {
  const base = {
    model: EXTRACT.model.openrouter,
    max_tokens: EXTRACT.maxTokens,
    temperature: 0,
    tools: [{ type: "function", function: { name: TOOL_NAME, description: "輸出結構化穿搭", parameters: SCHEMA } }],
    tool_choice: { type: "function", function: { name: TOOL_NAME } },
    messages: [{ role: "user", content: buildPrompt(style, article, want) }],
  };
  const body = EXTRACT.reasoningEffort ? { ...base, reasoning: { effort: EXTRACT.reasoningEffort } } : base;
  const headers = {
    authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
    "HTTP-Referer": process.env.SITE_URL || "http://localhost:3000",
    "X-Title": "WowStylist Style KB",
  };
  let res;
  try {
    res = await postJson("https://openrouter.ai/api/v1/chat/completions", body, headers);
  } catch (e) {
    if (/reasoning/i.test(e.message)) res = await postJson("https://openrouter.ai/api/v1/chat/completions", base, headers);
    else throw e;
  }
  return { data: await parseOpenAICompatible(res, `openrouter-${style.key}`), usage: res.usage };
}

async function viaOpenAI(style, article, want) {
  const res = await postJson(
    "https://api.openai.com/v1/chat/completions",
    {
      model: EXTRACT.model.openai, max_tokens: EXTRACT.maxTokens, temperature: 0,
      tools: [{ type: "function", function: { name: TOOL_NAME, parameters: SCHEMA } }],
      tool_choice: { type: "function", function: { name: TOOL_NAME } },
      messages: [{ role: "user", content: buildPrompt(style, article, want) }],
    },
    { authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
  );
  return { data: await parseOpenAICompatible(res, `openai-${style.key}`), usage: res.usage };
}

async function viaAnthropic(style, article, want) {
  const res = await postJson(
    "https://api.anthropic.com/v1/messages",
    {
      model: EXTRACT.model.anthropic, max_tokens: EXTRACT.maxTokens,
      tools: [{ name: TOOL_NAME, description: "輸出結構化穿搭", input_schema: SCHEMA }],
      tool_choice: { type: "tool", name: TOOL_NAME },
      messages: [{ role: "user", content: buildPrompt(style, article, want) }],
    },
    { "x-api-key": process.env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
  );
  const tool = (res.content || []).find((c) => c.type === "tool_use");
  if (!tool) throw new Error("模型沒有回 tool_use");
  return { data: tool.input, usage: res.usage };
}

const PROVIDERS = { openrouter: viaOpenRouter, openai: viaOpenAI, anthropic: viaAnthropic };

export function pickProvider(explicit) {
  const want = explicit || EXTRACT.defaultProvider;
  if (!PROVIDERS[want]) throw new Error(`未知的 LLM provider: ${want}`);
  const keyFor = { openrouter: "OPENROUTER_API_KEY", openai: "OPENAI_API_KEY", anthropic: "ANTHROPIC_API_KEY" }[want];
  if (!process.env[keyFor]) throw new Error(`provider=${want} 需要 ${keyFor}，.env 沒設`);
  return want;
}

export async function extractOutfits({ style, article, provider, want = CRAWL.outfitsPerStyle }) {
  return PROVIDERS[pickProvider(provider)](style, article, want);
}

// ── 後處理 ────────────────────────────────────────────────────────────

const clean = (v, n) => (Array.isArray(v) ? v.map(String).filter(Boolean).slice(0, n) : []);

/** 一套 outfit -> 一筆可入庫的紀錄（不含 source 欄位，由 crawl.mjs 補） */
export function buildRecord(outfit, style, articleLevel) {
  const items = {};
  const flags = { vocab: 0, generic: 0, oov: 0 };
  for (const slot of ["top", "bottom"]) {
    const raw = outfit.items?.[slot];
    if (!raw?.category) continue;
    const { category, status } = normalizeCategory(raw.category, slot);
    if (!category) continue;
    flags[status]++;
    items[slot] = { category, description: String(raw.description || "").trim(), category_status: status };
  }

  const outfitText = String(outfit.outfit_text || "").trim() ||
    Object.values(items).map((i) => i.description).join(" + ");
  const paletteNames = clean(outfit.palette_names, 5);
  const dos = clean(outfit.do, 4);

  return {
    style: style.key,
    style_zh: style.zh,
    aliases: style.aliases || [],
    style_present: articleLevel.style_present !== false,
    items,
    palette: clean(outfit.palette, 5),
    palette_names: paletteNames,
    fabrics: clean(outfit.fabrics, 6),
    do: dos,
    occasion: clean(outfit.occasion, 5),
    season: clean(outfit.season, 4),
    confidence: Number(outfit.confidence ?? articleLevel.confidence ?? 0),
    category_flags: flags,
    outfit_text: outfitText,
    embed_text: [
      `${style.zh} / ${style.key.replace(/_/g, " ")}`,
      outfitText,
      paletteNames.join(", "),
      dos.join("；"),
    ].filter(Boolean).join("\n"),
  };
}

export function validateOutfit(rec) {
  if (!rec.style_present) return { ok: false, reason: "style_not_present" };
  if (ACCEPT.requireTopAndBottom && !(rec.items.top && rec.items.bottom))
    return { ok: false, reason: `missing_${!rec.items.top ? "top" : "bottom"}` };
  for (const [slot, it] of Object.entries(rec.items)) {
    if ((it.description || "").length < ACCEPT.minDescriptionChars)
      return { ok: false, reason: `${slot}_description_too_short` };
  }
  if (rec.confidence < ACCEPT.minConfidence) return { ok: false, reason: `low_conf_${rec.confidence}` };
  if (ACCEPT.requireDo && !rec.do.length) return { ok: false, reason: "no_do" };
  const n = Object.keys(rec.items).length || 1;
  if (rec.category_flags.oov / n > ACCEPT.maxOovRatio) return { ok: false, reason: "oov_categories" };
  if (!rec.outfit_text) return { ok: false, reason: "no_outfit_text" };
  return { ok: true };
}

/** 同一個風格裡去掉重複的搭配 */
export const outfitKey = (rec) =>
  `${rec.style}\u0000${rec.items.top?.category}\u0000${rec.items.bottom?.category}\u0000${rec.outfit_text.toLowerCase().replace(/[^a-z0-9]+/g, "")}`;
