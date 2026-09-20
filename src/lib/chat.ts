import { readFileSync } from "fs";
import { join } from "path";
import {
  loadStyleCandidates,
  loadCandidateProducts,
  loadUserPreferenceEmbeddings,
  embedQuery,
  rankCategory,
  resolveProductSource,
  TOP_M,
  USER_WEIGHT,
  QUERY_WEIGHT,
  type StyleCandidates,
  type StyleMatch,
  type Product,
  type RankedProduct,
} from "@/lib/rank";

// 打字對話的核心模組。
// webhook 收到「不是 IG 連結」的文字時會呼叫 generateChatReply()，
// 由 CHAT_PROVIDER 環境變數決定用哪個引擎：
//   - "openrouter" : OpenRouter API（需 OPENROUTER_API_KEY，預設 nvidia/nemotron-3-ultra-550b-a55b:free）
//   - "anthropic"  : Claude API（需 ANTHROPIC_API_KEY）
//   - "openai"     : OpenAI API（需 OPENAI_API_KEY）
//   - "rules"      : 純關鍵字規則（不用金鑰，保底 fallback）
//
// 核心流程（LLM 模式）：
//   Phase 1：LLM 分類意圖（A/B/C）→ 抽取標籤
//   Phase 2：Session 決策（僅 B/C）→ 開新 session 或繼續現有 session
//   Phase 3：記錄使用者 turn
//   Phase 4：runRecommendation → searchCandidates → scoreOutfits → formatRecommendation
//   Phase 5：記錄 assistant turn，回傳結果
//
// 意圖類型：
//   A：找「一件特定單品」，給限制條件，不需要搭配
//   B：已有「一件指定衣物」，找可以互相搭配的其他衣物
//   C：針對「場合/情境」，找完整一套穿搭，沒有指定衣物
//
// DEBUG 模式（CHAT_DEBUG=true）：
//   LINE Bot 回傳訊息會包含逐步驟的執行狀態，方便測試整體流程正確性。
//   格式：[步驟/總步驟] emoji 說明 \n ... \n ──────── \n 實際結果

// ── 型別定義 ──────────────────────────────────────────────────────────────────

type Intent = "A" | "B" | "C" | "other";

interface ChatTurn {
  role: "user" | "assistant";
  content: string;
  intent?: Intent;
  timestamp: number;
}

interface FashionSession {
  sessionId: string;
  userId: string;
  status: "active" | "ended";
  turns: ChatTurn[];
  createdAt: number;
  updatedAt: number;
}

// ── In-memory session store ───────────────────────────────────────────────────
// Demo 用途：每個 userId 只保留最新一個 session。
// Production 請換成 Redis（upstash-redis）或 PostgreSQL session table。
const sessionStore = new Map<string, FashionSession>();

// ── Session 輔助函式 ──────────────────────────────────────────────────────────

function getActiveSession(userId: string): FashionSession | null {
  const session = sessionStore.get(userId);
  if (!session || session.status !== "active") return null;
  return session;
}

function startNewSession(userId: string): FashionSession {
  const session: FashionSession = {
    sessionId: `${userId}_${Date.now()}`,
    userId,
    status: "active",
    turns: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  sessionStore.set(userId, session);
  console.log(`[chat] 開啟新 session sessionId=${session.sessionId}`);
  return session;
}

function endSession(userId: string): void {
  const session = sessionStore.get(userId);
  if (session) {
    session.status = "ended";
    session.updatedAt = Date.now();
    console.log(`[chat] 結束 session sessionId=${session.sessionId}`);
  }
}

function appendTurn(session: FashionSession, turn: ChatTurn): void {
  session.turns.push(turn);
  session.updatedAt = Date.now();
}

// ── Intent 解析 ───────────────────────────────────────────────────────────────
// 規則：有 [item:] → B；有 [keywords:] 但沒有 [item:] → C；否則 → "other"（含 A）
// A 意圖的輸出不帶任何標籤（直接回傳原始訊息），因此這裡歸入 "other" 一起處理。

function parseIntent(classifierOutput: string): Intent {
  if (/\[item:/i.test(classifierOutput)) return "B";
  if (/\[keywords:/i.test(classifierOutput)) return "C";
  return "other"; // 含 A 意圖（無標籤）與閒聊
}

// ── Prompt：Session 決策器 ────────────────────────────────────────────────────
const SESSION_DECISION_PROMPT = `你是 WowStylist 的對話狀態管理器。
根據現有的穿搭討論歷史，判斷使用者的新訊息是「補充/修改現有需求」還是「全新的穿搭需求」。

## 判斷為「繼續」（continue）的情況
- 使用者在調整上一輪的穿搭參數（例如：「顏色換深一點」「預算降低」「要寬鬆版型」）
- 使用者詢問上一輪推薦的某件商品細節
- 使用者說否定後給出修改方向（例如：「不喜歡，換個風格試試」）
- 使用者在原有場合上微調（例如：「更正式一點」「簡約風的」）

## 判斷為「重開」（new）的情況
- 使用者提出與目前討論完全不同的場合或需求（例如：從「辦公室穿搭」→「海邊度假穿搭」）
- 使用者明確說「重新」「算了換一個」「另外」「我想找別的」
- 使用者詢問與穿搭無關的問題
- 使用者說「謝謝」「好了」「結束」等收尾詞

## 輸出格式
只輸出一個單詞，不要任何說明文字：
continue
或
new`;

// 呼叫 LLM 決定 "continue" 或 "new"；失敗時預設繼續
async function decideSessionAction(
  session: FashionSession,
  newMessage: string,
  provider: string
): Promise<"continue" | "new"> {
  const recentTurns = session.turns.slice(-6);
  const historyText = recentTurns
    .map((t) => `${t.role === "user" ? "使用者" : "助手"}：${t.content.slice(0, 120)}`)
    .join("\n");

  const decisionMessage = `[現有對話歷史]\n${historyText}\n\n[使用者新訊息]\n${newMessage}`;
  const result = await callLLM(provider, SESSION_DECISION_PROMPT, decisionMessage, 10);

  if (!result.content) {
    console.warn("[chat] session 決策 LLM 無回應，預設繼續");
    return "continue";
  }

  const answer = result.content.trim().toLowerCase();
  if (answer.startsWith("new")) return "new";
  return "continue";
}

// ── Prompt：意圖分類器 ────────────────────────────────────────────────────────
const CLASSIFIER_SYSTEM_PROMPT = `你是 WowStylist 穿搭需求分析器。根據使用者輸入，判斷意圖並輸出結構化結果。

## 風格資料庫（用於語意匹配）
以下是可用的穿搭風格，每個風格含有別名、場合、季節供語意比對：

老錢風: aliases=[old money aesthetic, old money, 老錢, preppy, classic elegance], occasions=[日常通勤, 休閒聚會, 商務休閒, 度假, 週末出遊], seasons=[spring, fall, autumn, winter, summer]
靜奢風: aliases=[stealth wealth, quiet luxury, 靜奢, 低調奢華, minimalist luxury], occasions=[日常穿著, 辦公室, 正式場合, 晚間活動, 特殊場合], seasons=[fall, winter, spring, summer]
芭蕾風: aliases=[ballet core, balletcore, 芭蕾核心, 芭蕾女孩, ballet aesthetic, ballerina], occasions=[日常通勤, 休閒街頭, 舞蹈教室, 健身課程], seasons=[spring, fall, winter, summer]
蝴蝶結甜美風: aliases=[coquette aesthetic, bow girl, coquette, 甜美, 蝴蝶結, feminine, girly], occasions=[紐約時裝週, 街拍, 春日約會, 通勤, 咖啡廳], seasons=[spring, winter, fall]
田園風: aliases=[cottage core, cottagecore, 鄉村風, 田園, 自然風, nature, botanical], occasions=[健行, 野餐, 城市漫步, 音樂節], seasons=[spring, summer, fall, winter]
明亮學院風: aliases=[light academia, light academia aesthetic, 學院風, 書卷氣, intellectual, academic], occasions=[咖啡廳, 校園, 圖書館, 半正式場合], seasons=[spring, fall, winter, summer]

## 意圖類型定義
- A：找「一件特定單品」——使用者給出條件（顏色、材質、款式等），想找某類型的單品，不涉及搭配
- B：「已有一件指定衣物」——使用者描述手邊某件衣物，想找其他可以和它搭配的衣物
- C：針對「場合或情境」——使用者描述要去哪裡或做什麼，想找完整一套穿搭，沒有指定任何特定衣物
- 其他：閒聊、問候、詢問使用方式

## 風格匹配規則（B 和 C 情境適用）
1. 將使用者輸入與風格資料庫中的 aliases 做語意比對（不限完全相符，語意相近即可）
2. 若 aliases 匹配不足 5 個風格，再與 occasions 做語意比對補足
3. 若仍不足，再與 seasons 比對補足
4. 挑選最相符的最多 5 個 style_zh（中文風格名），輸出為 [風格:] 標籤
5. 若完全無法匹配，省略 [風格:] 標籤

## 價格處理
若輸入中有價格相關描述（預算、元、NT$、以內、便宜、高價位等），
→ 抽取為獨立的 [price] 標籤
→ 並從主要描述中移除這段文字

## 輸出規則（嚴格遵守以下格式，不要輸出任何說明文字）

### 其他（閒聊 / 問候 / 使用說明）
直接輸出使用者原始訊息，不添加任何標籤。

### A（找單品）
直接輸出使用者原始訊息，不添加任何標籤。

### B（有指定衣物，找搭配）
[風格: {最多5個相符的中文風格名，逗號分隔；若無匹配則省略此行}]
{使用者原始訊息（移除價格相關文字）}
[item: {已知衣物的詳細描述，英文，包含 color/style/material 等特徵，例如：navy slim-fit wool blazer}]
[keywords: {5~10個英文名詞或形容詞，逗號分隔，例如：navy, slim, formal, blazer, business, clean}]
[price: {若有，英文描述，例如：under NT$2000；否則省略此行}]

### C（找完整穿搭）
[風格: {最多5個相符的中文風格名，逗號分隔；若無匹配則省略此行}]
{使用者原始訊息（移除價格相關文字）}
[keywords: {5~10個英文名詞或形容詞，逗號分隔，涵蓋場合、風格、限制，例如：wedding guest, formal, light-color, elegant, feminine}]
[price: {若有，英文描述，例如：under NT$3000；否則省略此行}]`;

// LLM 回傳結果，content=null 時 reason 說明失敗原因
type LLMResult = { content: string; reason: string } | { content: null; reason: string };

// ── LLM 呼叫：OpenRouter ─────────────────────────────────────────────────────
async function callOpenRouter(
  systemPrompt: string,
  userMessage: string,
  maxTokens = 400
): Promise<LLMResult> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    const reason = "NO_API_KEY: OPENROUTER_API_KEY 未設定";
    console.error(`[chat] ${reason}`);
    return { content: null, reason };
  }

  const model = process.env.CHAT_MODEL || "nvidia/nemotron-3-ultra-550b-a55b:free";
  const timeoutMs = 8000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = Date.now();

  try {
    console.log(`[chat] OpenRouter 送出請求 model=${model} timeout=${timeoutMs}ms`);
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
        "HTTP-Referer": process.env.SITE_URL ?? "https://wowstylist.app",
        "X-Title": "WowStylist",
      },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userMessage },
        ],
      }),
    });
    clearTimeout(timer);
    const elapsed = Date.now() - startedAt;

    if (!res.ok) {
      const body = await res.text();
      const reason = `HTTP_${res.status} (${elapsed}ms): ${body.slice(0, 300)}`;
      console.error(`[chat] OpenRouter ${reason} model=${model}`);
      return { content: null, reason };
    }

    const data = (await res.json()) as {
      choices?: {
        finish_reason?: string;
        message?: { content?: string | { text?: string }[] };
      }[];
      error?: { message?: string; code?: number };
    };

    if (data.error) {
      const reason = `API_ERROR code=${data.error.code}: ${data.error.message}`;
      console.error(`[chat] OpenRouter ${reason} (${elapsed}ms) model=${model}`);
      return { content: null, reason };
    }

    const choice = data.choices?.[0];
    const msg = choice?.message;

    if (choice?.finish_reason === "length") {
      const reason = `TRUNCATED finish_reason=length (${elapsed}ms) — 考慮換小模型或降低 maxTokens`;
      console.error(`[chat] OpenRouter ${reason} model=${model}`);
      return { content: null, reason };
    }

    if (!msg) {
      const raw = JSON.stringify(data).slice(0, 200);
      const reason = `EMPTY_CHOICES (${elapsed}ms) raw=${raw}`;
      console.error(`[chat] OpenRouter ${reason} model=${model}`);
      return { content: null, reason };
    }

    const rawContent = msg.content;
    const content = Array.isArray(rawContent)
      ? rawContent.map((c) => (typeof c === "object" && c !== null ? (c.text ?? "") : String(c))).join("")
      : rawContent ?? null;

    if (!content) {
      const raw = JSON.stringify(msg).slice(0, 200);
      const reason = `EMPTY_CONTENT (${elapsed}ms) finish=${choice?.finish_reason} msg=${raw}`;
      console.error(`[chat] OpenRouter ${reason} model=${model}`);
      return { content: null, reason };
    }

    console.log(`[chat] OpenRouter 回應成功 (${elapsed}ms) finish_reason=${choice?.finish_reason}`);
    return { content, reason: "ok" };

  } catch (e: unknown) {
    clearTimeout(timer);
    const elapsed = Date.now() - startedAt;
    let reason: string;
    if (e instanceof Error && e.name === "AbortError") {
      reason = `TIMEOUT >${elapsed}ms — 考慮換小模型：CHAT_MODEL=meta-llama/llama-3.1-8b-instruct:free`;
    } else if (e instanceof TypeError) {
      reason = `NETWORK_ERROR (${elapsed}ms): ${e.message}`;
    } else {
      reason = `UNKNOWN_ERROR (${elapsed}ms): ${String(e)}`;
    }
    console.error(`[chat] OpenRouter ${reason} model=${model}`);
    return { content: null, reason };
  }
}

// ── LLM 呼叫：Anthropic ──────────────────────────────────────────────────────
async function callAnthropic(
  systemPrompt: string,
  userMessage: string,
  maxTokens = 400
): Promise<string | null> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: process.env.CHAT_MODEL || "claude-haiku-4-5",
        max_tokens: maxTokens,
        system: systemPrompt,
        messages: [{ role: "user", content: userMessage }],
      }),
    });
    if (!res.ok) {
      console.error(`[chat] Anthropic HTTP ${res.status}:`, await res.text());
      return null;
    }
    const data = (await res.json()) as { content?: { type: string; text?: string }[] };
    return data.content?.find((c) => c.type === "text")?.text ?? null;
  } catch (e) {
    console.error("[chat] Anthropic 錯誤:", e);
    return null;
  }
}

// ── LLM 呼叫：OpenAI ─────────────────────────────────────────────────────────
async function callOpenAI(
  systemPrompt: string,
  userMessage: string,
  maxTokens = 400
): Promise<string | null> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;
  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: process.env.CHAT_MODEL || "gpt-4o-mini",
        max_tokens: maxTokens,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userMessage },
        ],
      }),
    });
    if (!res.ok) {
      console.error(`[chat] OpenAI HTTP ${res.status}:`, await res.text());
      return null;
    }
    const data = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    return data.choices?.[0]?.message?.content ?? null;
  } catch (e) {
    console.error("[chat] OpenAI 錯誤:", e);
    return null;
  }
}

// 統一入口
async function callLLM(
  provider: string,
  systemPrompt: string,
  userMessage: string,
  maxTokens = 400
): Promise<LLMResult> {
  if (provider === "openrouter") return callOpenRouter(systemPrompt, userMessage, maxTokens);
  if (provider === "anthropic") {
    const content = await callAnthropic(systemPrompt, userMessage, maxTokens);
    return content ? { content, reason: "ok" } : { content: null, reason: "ANTHROPIC_NO_RESPONSE" };
  }
  if (provider === "openai") {
    const content = await callOpenAI(systemPrompt, userMessage, maxTokens);
    return content ? { content, reason: "ok" } : { content: null, reason: "OPENAI_NO_RESPONSE" };
  }
  return { content: null, reason: `UNKNOWN_PROVIDER: ${provider}` };
}

// ── Fallback：關鍵字規則 ─────────────────────────────────────────────────────
function chatWithRules(text: string): string {
  const t = text.trim().toLowerCase();
  if (/怎麼用|怎么用|幫助|help|說明/.test(t)) {
    return "使用方式：\n1️⃣ 收藏穿搭 → 把 Instagram 貼文/Reels 連結傳過來\n2️⃣ 穿搭建議 → 用文字描述場合、風格、預算，例如「秋天約會穿搭，預算 2000」\n3️⃣ 查看收藏 → 打「收藏夾」或到網頁瀏覽 ✨";
  }
  if (/收藏夾|我的收藏|看收藏/.test(t)) {
    const url = process.env.SITE_URL ? `${process.env.SITE_URL}/favorites` : "網頁收藏夾";
    return `你的 IG 穿搭收藏在這裡 👉 ${url}`;
  }
  if (/你好|嗨|哈囉|hi|hello/.test(t)) {
    return "嗨嗨！我是你的穿搭助手 ✨\n• 傳 IG 連結給我 → 自動收藏\n• 說出場合和預算 → 我給穿搭建議\n打「怎麼用」看更多說明！";
  }
  if (/穿搭|穿什麼|怎麼穿|搭配/.test(t)) {
    return "告訴我多一點，我幫你搭！🎯\n你要去哪裡？預算大概多少？有偏好的風格嗎（例如簡約、可愛、復古）？";
  }
  return "我是穿搭收藏小幫手！傳 IG 連結可以收藏，或直接告訴我場合和預算，我來幫你搭配 ✨";
}

// ── 讀取使用者偏好檔 ──────────────────────────────────────────────────────────
function loadUserPrefs(userId: string | null): string | null {
  if (!userId) return null;
  try {
    const filePath = join(process.cwd(), "data", "user-prefs", `${userId}.md`);
    const content = readFileSync(filePath, "utf-8").trim();
    return content || null;
  } catch {
    return null;
  }
}

// ── 訊息組裝 ─────────────────────────────────────────────────────────────────

function buildFirstTurnMessage(
  text: string,
  nonIgUrls?: string[],
  userPrefs?: string | null
): string {
  let msg = text;
  if (nonIgUrls && nonIgUrls.length > 0) {
    msg += `\n[使用者附上非 IG 連結：${nonIgUrls.join(", ")}]`;
  }
  if (userPrefs) {
    msg += `\n\n[使用者偏好紀錄]\n${userPrefs}`;
  }
  return msg;
}

function buildContinuationMessage(
  session: FashionSession,
  text: string,
  nonIgUrls?: string[],
  userPrefs?: string | null
): string {
  const recentTurns = session.turns.slice(-6);
  const historyText = recentTurns
    .map((t) => `${t.role === "user" ? "使用者" : "助手"}：${t.content.slice(0, 200)}`)
    .join("\n");
  let msg = `[對話歷史]\n${historyText}\n\n[使用者新訊息]\n${text}`;
  if (nonIgUrls && nonIgUrls.length > 0) {
    msg += `\n[使用者附上非 IG 連結：${nonIgUrls.join(", ")}]`;
  }
  if (userPrefs) {
    msg += `\n\n[使用者偏好紀錄]\n${userPrefs}`;
  }
  return msg;
}

// ══════════════════════════════════════════════════════════════════════════════
// 推薦流程三段式（各為獨立 dummy，後續可各自替換實作）
// ══════════════════════════════════════════════════════════════════════════════

// ── 候選搜尋（TODO：實作 embedding + 向量搜尋） ───────────────────────────────
// 輸入：分類器輸出（含 [keywords:] [item:] [風格:] [price:] 標籤）
// 輸出：各 layer 候選商品清單 + query_embedding
//
// TODO 實作步驟：
//   1. 解析 [keywords:] [item:] [風格:] [price:] 標籤
//   2. embed keywords → query_embedding（呼叫 HF InferenceClient / BAAI/bge-m3）
//   3. 在 fashion_items 資料表做向量搜尋（cosine similarity = dot product，已 L2-normalized）
//   4. 若有 [item:]，固定該 layer，只搜尋其餘 layer
//   5. 回傳各 layer 的 top-15~20 候選商品

// 候選商品（TODO：替換成實際 DB 型別）
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type CandidateItem = Record<string, any>;

interface SearchResult {
  // 各 layer 的候選商品清單，key = layer 名稱（top / bottom / outer / footwear）
  candidatesByLayer: Record<string, CandidateItem[]>;
  // query embedding（供評分階段用）
  queryEmbedding: number[] | null;
  // debug 摘要（顯示解析出的標籤）
  debugSummary: string;
  // ── 以下是接上 rank.ts 之後新增的 ──
  style: StyleCandidates | null;
  products: Map<number, Product>;
  userPrefs: { top: number[][]; bottom: number[][]; scope: string };
  error: string | null;
}

const EMPTY_LAYERS = { top: [], bottom: [], outer: [], footwear: [] };

function emptySearchResult(
  debugSummary: string,
  error: string | null
): SearchResult {
  return {
    candidatesByLayer: { ...EMPTY_LAYERS },
    queryEmbedding: null,
    debugSummary,
    style: null,
    products: new Map(),
    userPrefs: { top: [], bottom: [], scope: "none" },
    error,
  };
}

// ── 搜尋候選服飾 ─────────────────────────────────────────────────────────────
// 輸入：分類器輸出（含 [keywords:] [item:] [風格:] [price:] 標籤）
// 輸出：每個 layer 的候選商品 + query embedding
//
// 流程：
//   1. 解析標籤
//   2. [風格:] → data/style-kb/style_kb.jsonl 查出離線算好的候選商品
//      （build_style_lookup.py 跑的，demo 期間商品庫和風格庫都不會變）
//   3. 撈這幾十個候選的向量 + 使用者長期偏好向量
//   4. 把這次查詢編成向量

async function searchCandidates(
  classifiedResult: string,
  session: FashionSession
): Promise<SearchResult> {
  const keywordsMatch = classifiedResult.match(/\[keywords:\s*([^\]]+)\]/i);
  const itemMatch     = classifiedResult.match(/\[item:\s*([^\]]+)\]/i);
  const styleMatch    = classifiedResult.match(/\[風格:\s*([^\]]+)\]/);
  const priceMatch    = classifiedResult.match(/\[price:\s*([^\]]+)\]/i);

  const keywords = keywordsMatch?.[1]?.trim() ?? null;
  const item     = itemMatch?.[1]?.trim()     ?? null;
  const styleTag = styleMatch?.[1]?.trim()    ?? null;
  const price    = priceMatch?.[1]?.trim()    ?? null;

  const debugParts = [
    `keywords: ${keywords ?? "(未解析到)"}`,
    item  ? `item: ${item}`       : null,
    styleTag ? `style: ${styleTag}` : null,
    price ? `price: ${price}`     : null,
  ].filter(Boolean);

  // 分類器可能一次給好幾個風格，取第一個在 KB 裡找得到的
  const styleNames = (styleTag ?? "")
    .split(/[,，、]/)
    .map((s) => s.trim())
    .filter(Boolean);

  let style: StyleCandidates | null = null;
  for (const name of styleNames) {
    style = loadStyleCandidates(name);
    if (style) break;
  }

  if (!style) {
    const reason = styleNames.length === 0
      ? "分類器沒有給 [風格:] 標籤"
      : `style_kb.jsonl 裡找不到：${styleNames.join(" / ")}`;
    console.log(`[chat] searchCandidates 跳過排序 — ${reason}`);
    return emptySearchResult(
      [...debugParts, reason].join(" | "),
      reason
    );
  }

  debugParts.push(`命中風格: ${style.styleZh ?? style.style}`);

  // query 文字：關鍵字最能代表這次的需求，沒有的話退回 item / 原句
  const queryText =
    keywords ?? item ?? classifiedResult.replace(/\[[^\]]*\]/g, "").trim();

  const productIds = [
    ...style.top.map((c) => c.product_id),
    ...style.bottom.map((c) => c.product_id),
  ];

  try {
    const [products, queryEmbedding, topPrefs, bottomPrefs] = await Promise.all([
      loadCandidateProducts(productIds),
      embedQuery(queryText),
      loadUserPreferenceEmbeddings(session.userId, "top"),
      loadUserPreferenceEmbeddings(session.userId, "bottom"),
    ]);

    if (products.size === 0) {
      const source = await resolveProductSource();
      const reason = source
        ? `${source.table} 裡找不到這 ${productIds.length} 個候選商品的 embedding`
        : "找不到商品向量來源（fashion_items 沒有 source='product' 的列，也沒有 products 表）";
      console.warn(`[chat] searchCandidates: ${reason}`);
      return emptySearchResult([...debugParts, reason].join(" | "), reason);
    }

    const scope =
      topPrefs.scope === "user" || bottomPrefs.scope === "user"
        ? "user"
        : topPrefs.scope === "global" || bottomPrefs.scope === "global"
          ? "global"
          : "none";

    debugParts.push(
      `候選 top=${style.top.length} bottom=${style.bottom.length}`,
      `商品向量 ${products.size} 筆`,
      `偏好向量 top=${topPrefs.embeddings.length} bottom=${bottomPrefs.embeddings.length}（${
        scope === "user" ? "本人收藏" : scope === "global" ? "全體收藏" : "無"
      }）`
    );

    return {
      candidatesByLayer: {
        top: style.top,
        bottom: style.bottom,
        outer: [],
        footwear: [],
      },
      queryEmbedding,
      debugSummary: debugParts.join(" | "),
      style,
      products,
      userPrefs: {
        top: topPrefs.embeddings,
        bottom: bottomPrefs.embeddings,
        scope,
      },
      error: null,
    };
  } catch (err) {
    const reason = String(err);
    console.error("[chat] searchCandidates 失敗：", err);
    return emptySearchResult([...debugParts, reason].join(" | "), reason);
  }
}

// ── 評分與排序 ───────────────────────────────────────────────────────────────
// S_final = 0.67 × S_user + 0.33 × S_query
//   S_user  = 商品向量跟「使用者收藏的 IG 單品」的平均 cosine
//   S_query = 商品向量跟這次查詢的 cosine
// 沒有收藏紀錄時 S_final = S_query（見 rank.ts 的 finalScore）
//
// 目前一套 = 一件上衣 + 一件下著，按名次配對。
// 之後要做 Beam Search / 相容性分數的話，從這裡往下加。

interface ScoredOutfit {
  items: CandidateItem[];
  score: number;
  reason: string;
}

async function scoreOutfits(
  searchResult: SearchResult,
  _session: FashionSession
): Promise<ScoredOutfit[]> {
  const { queryEmbedding, products, userPrefs, style } = searchResult;

  if (!style || !queryEmbedding || products.size === 0) return [];

  const rankedTops = rankCategory(
    searchResult.candidatesByLayer.top as StyleMatch[],
    products,
    userPrefs.top,
    queryEmbedding,
    TOP_M
  );

  const rankedBottoms = rankCategory(
    searchResult.candidatesByLayer.bottom as StyleMatch[],
    products,
    userPrefs.bottom,
    queryEmbedding,
    TOP_M
  );

  console.log(
    `[chat] scoreOutfits top=${rankedTops.length} bottom=${rankedBottoms.length} ` +
    `weights=${USER_WEIGHT}/${QUERY_WEIGHT} prefScope=${userPrefs.scope}`
  );

  const outfits: ScoredOutfit[] = [];
  const pairs = Math.max(rankedTops.length, rankedBottoms.length);

  for (let i = 0; i < pairs; i++) {
    const top = rankedTops[i];
    const bottom = rankedBottoms[i];
    const items = [top, bottom].filter(Boolean) as RankedProduct[];
    if (items.length === 0) continue;

    const score =
      items.reduce((sum, x) => sum + x.finalScore, 0) / items.length;

    outfits.push({
      items,
      score,
      reason: style.outfitText ?? style.styleZh ?? style.style,
    });
  }

  return outfits;
}

// ── 格式化回傳訊息 ───────────────────────────────────────────────────────────
// TODO：之後改成 LINE Flex Message（含商品圖），現在先給純文字。

function formatPrice(price: number | null): string {
  return price === null ? "" : ` NT$${Math.round(price).toLocaleString("en-US")}`;
}

function formatProduct(product: RankedProduct): string {
  const name = product.title ?? `商品 ${product.productId}`;
  const scores =
    product.userScore === null
      ? `符合度 ${product.queryScore.toFixed(2)}`
      : `符合度 ${product.finalScore.toFixed(2)}（你的喜好 ${product.userScore.toFixed(2)} / 這次需求 ${product.queryScore.toFixed(2)}）`;

  return [
    `　${name}${formatPrice(product.priceTwd)}`,
    product.productUrl ? `　${product.productUrl}` : null,
    `　${scores}`,
  ].filter(Boolean).join("\n");
}

async function formatRecommendation(
  scoredOutfits: ScoredOutfit[],
  classifiedResult: string,
  _session: FashionSession,
  _provider: string,
  searchResult?: SearchResult
): Promise<string> {
  if (scoredOutfits.length === 0) {
    // 排不出來時把原因講出來，不然使用者只會看到一串標籤
    if (searchResult?.error) {
      return `目前還挑不出商品：${searchResult.error}\n\n${classifiedResult}`;
    }
    return classifiedResult;
  }

  const style = searchResult?.style;
  const header = style
    ? `幫你抓了「${style.styleZh ?? style.style}」的搭配 ✨`
    : "幫你挑了這幾套 ✨";

  const body = scoredOutfits.map((outfit, i) => {
    const lines = [`套餐 ${i + 1}`];
    for (const item of outfit.items as RankedProduct[]) {
      lines.push(formatProduct(item));
    }
    return lines.join("\n");
  });

  const footer =
    searchResult?.userPrefs.scope === "user"
      ? "（已參考你收藏的 IG 穿搭）"
      : searchResult?.userPrefs.scope === "global"
        ? "（你還沒有收藏紀錄，先用大家的收藏當參考 —— 分享幾則 IG 穿搭給我會更準）"
        : "（還沒有收藏紀錄，這次只看你這句話的需求）";

  return [header, "", ...body, "", footer].join("\n");
}

// ── 推薦主流程（串接三段 dummy） ─────────────────────────────────────────────
// debug 模式時將各步驟說明 push 到 debugLines（由呼叫者傳入）
async function runRecommendation(
  classifiedResult: string,
  session: FashionSession,
  provider: string,
  debugLines?: string[]
): Promise<string> {
  // Step A：搜尋候選服飾
  debugLines?.push("[4/6] 🔍 搜尋候選服飾（searchCandidates）...");
  const searchResult = await searchCandidates(classifiedResult, session);
  debugLines?.push(`      ↳ ${searchResult.debugSummary}`);
  debugLines?.push(`      ↳ 各 layer 候選數：${
    Object.entries(searchResult.candidatesByLayer)
      .map(([k, v]) => `${k}=${v.length}`)
      .join(", ")
  }`);

  // Step B：評分排序
  debugLines?.push("[5/6] 📊 評分排序（scoreOutfits）...");
  const scoredOutfits = await scoreOutfits(searchResult, session);
  debugLines?.push(
    `      ↳ 最終套餐數：${scoredOutfits.length}` +
    `（S_final = ${USER_WEIGHT} × S_user + ${QUERY_WEIGHT} × S_query）`
  );

  // Step C：格式化
  debugLines?.push("[6/6] ✍️  格式化推薦結果（formatRecommendation）...");
  const result = await formatRecommendation(
    scoredOutfits, classifiedResult, session, provider, searchResult
  );
  debugLines?.push("      ↳ 完成，準備回傳");

  return result;
}

// ══════════════════════════════════════════════════════════════════════════════
// 對外主函式
// ══════════════════════════════════════════════════════════════════════════════

export async function generateChatReply(
  userId: string | null,
  text: string,
  nonIgUrls?: string[]
): Promise<string> {
  const explicit = (process.env.CHAT_PROVIDER || "").toLowerCase();
  const provider = explicit ||
    (process.env.OPENROUTER_API_KEY ? "openrouter" :
     process.env.ANTHROPIC_API_KEY  ? "anthropic"  :
     process.env.OPENAI_API_KEY     ? "openai"     : "rules");
  const model = process.env.CHAT_MODEL ||
    (provider === "openrouter" ? "nvidia/nemotron-3-ultra-550b-a55b:free" :
     provider === "anthropic"  ? "claude-haiku-4-5" :
     provider === "openai"     ? "gpt-4o-mini" : "-");
  const debug = process.env.CHAT_DEBUG === "true";

  // debug 模式：累積逐步說明，最後拼在回傳訊息最前面
  const debugLines: string[] = [];
  const D = (line: string) => { if (debug) debugLines.push(line); };

  // ── rules 模式 ──────────────────────────────────────────────────────────────
  if (provider === "rules") {
    const reply = chatWithRules(text);
    if (debug) {
      return `[DEBUG] provider=rules\n────────────\n${reply}`;
    }
    return reply;
  }

  // ── LLM 模式 ────────────────────────────────────────────────────────────────
  D(`[DEBUG] provider=${provider} | model=${model} | userId=${userId ?? "null"}`);
  D("");

  const userPrefs = loadUserPrefs(userId);
  if (userPrefs) {
    console.log(`[chat] 已載入使用者偏好 userId=${userId}`);
    D(`ℹ️  已載入使用者偏好檔 (${userPrefs.length} chars)`);
  } else {
    D(`ℹ️  無使用者偏好檔（冷啟動）`);
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Phase 1：意圖分類
  // ──────────────────────────────────────────────────────────────────────────
  D("[1/6] 🧠 意圖分類中（CLASSIFIER_SYSTEM_PROMPT）...");
  const firstTurnMessage = buildFirstTurnMessage(text, nonIgUrls, userPrefs);
  console.log(`[chat] Phase 1 分類，provider=${provider} model=${model}`);

  const { content: classifiedResult, reason: classifyReason } = await callLLM(
    provider,
    CLASSIFIER_SYSTEM_PROMPT,
    firstTurnMessage,
    700
  );

  if (!classifiedResult) {
    console.warn(`[chat] 分類器無回應（${classifyReason}），降級到 rules`);
    D(`      ↳ ❌ LLM 無回應：${classifyReason}`);
    D("      ↳ 降級到 rules fallback");
    const fallback = chatWithRules(text);
    if (debug) {
      return `${debugLines.join("\n")}\n────────────\n${fallback}`;
    }
    return fallback;
  }

  const intent = parseIntent(classifiedResult);
  D(`      ↳ ✅ intent=${intent}`);
  D(`      ↳ 分類輸出（前 120 字）：${classifiedResult.slice(0, 120).replace(/\n/g, " ")}`);
  console.log(`[chat] 分類結果 intent=${intent}: ${classifiedResult.slice(0, 200)}`);

  // ──────────────────────────────────────────────────────────────────────────
  // Phase 2：Session 決策（僅 B/C；A/other 直接回傳）
  // ──────────────────────────────────────────────────────────────────────────
  let session: FashionSession | null = null;

  if (!userId || intent === "other") {
    D(`[2/6] 🗂️  Session：不適用（intent=${intent}，無需追蹤對話）`);
    D("[3/6] ⏭️  跳過（非 B/C 意圖）");
    D("");
    D("────────────");
    if (debug) return `${debugLines.join("\n")}\n${classifiedResult}`;
    return classifiedResult;
  }

  // B / C 意圖：進入 session 管理
  D("[2/6] 🗂️  Session 決策（intent=B/C）...");
  const existingSession = getActiveSession(userId);

  if (!existingSession) {
    session = startNewSession(userId);
    D(`      ↳ 無現有 session → 開啟新 session（${session.sessionId}）`);
  } else {
    D(`      ↳ 現有 session=${existingSession.sessionId}（turns=${existingSession.turns.length}）`);
    D("      ↳ 呼叫 SESSION_DECISION_PROMPT 判斷 continue/new...");

    const decision = await decideSessionAction(existingSession, text, provider);
    D(`      ↳ 決策結果：${decision}`);
    console.log(`[chat] session 決策：${decision} sessionId=${existingSession.sessionId}`);

    if (decision === "new") {
      endSession(userId);
      session = startNewSession(userId);
      D(`      ↳ 結束舊 session → 開啟新 session（${session.sessionId}）`);
    } else {
      session = existingSession;
      D("      ↳ 繼續現有 session，重新分類（帶對話歷史）...");

      const continuationMessage = buildContinuationMessage(session, text, nonIgUrls, userPrefs);
      const { content: reClassified } = await callLLM(
        provider,
        CLASSIFIER_SYSTEM_PROMPT,
        continuationMessage,
        700
      );

      if (reClassified) {
        const reIntent = parseIntent(reClassified);
        D(`      ↳ 重新分類完成 intent=${reIntent}`);
        console.log(`[chat] 重新分類（帶歷史）: ${reClassified.slice(0, 200)}`);

        // Phase 3（continuation 路徑）
        D("[3/6] 📝 記錄使用者 turn（continuation）");
        appendTurn(session, { role: "user", content: text, intent: reIntent, timestamp: Date.now() });

        // Phase 4
        const finalResult = await runRecommendation(reClassified, session, provider, debug ? debugLines : undefined);

        // Phase 5
        D("[5/6 已完成] 📝 記錄 assistant turn");
        appendTurn(session, { role: "assistant", content: finalResult, timestamp: Date.now() });
        D(`      ↳ sessionId=${session.sessionId} | 總 turns=${session.turns.length}`);
        D("");
        D("────────────");
        if (debug) return `${debugLines.join("\n")}\n${finalResult}`;
        return finalResult;
      }

      D("      ↳ 重新分類失敗，使用第一輪結果繼續");
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Phase 3：記錄使用者 turn（新 session 路徑）
  // ──────────────────────────────────────────────────────────────────────────
  D("[3/6] 📝 記錄使用者 turn");
  appendTurn(session, { role: "user", content: text, intent, timestamp: Date.now() });

  // ──────────────────────────────────────────────────────────────────────────
  // Phase 4：推薦流程
  // ──────────────────────────────────────────────────────────────────────────
  const recommendation = await runRecommendation(
    classifiedResult,
    session,
    provider,
    debug ? debugLines : undefined
  );

  // ──────────────────────────────────────────────────────────────────────────
  // Phase 5：記錄 assistant turn，回傳
  // ──────────────────────────────────────────────────────────────────────────
  D("[5/6 已完成] 📝 記錄 assistant turn");
  appendTurn(session, { role: "assistant", content: recommendation, timestamp: Date.now() });
  D(`      ↳ sessionId=${session.sessionId} | 總 turns=${session.turns.length}`);
  D("");
  D("────────────");

  if (debug) return `${debugLines.join("\n")}\n${recommendation}`;
  return recommendation;
}

// ── 對外輔助函式 ──────────────────────────────────────────────────────────────

/**
 * 結束使用者的穿搭 session。
 * 由 webhook 在使用者點擊「選擇這套」「收藏」等按鈕時呼叫。
 * 結束後下一則訊息將自動開啟新 session。
 */
export function endFashionSession(userId: string): void {
  endSession(userId);
}

/**
 * 取得使用者目前 session 的對話歷史。
 * 供偏好更新模組（preference updater）使用：
 *   - 讀取使用者在本次搭配討論中說過的需求
 *   - 結合最終選擇，更新 user_vec
 * 若無 session（或已結束）回傳 null。
 */
export function getSessionHistory(userId: string): ChatTurn[] | null {
  const session = sessionStore.get(userId);
  if (!session) return null;
  return session.turns;
}
