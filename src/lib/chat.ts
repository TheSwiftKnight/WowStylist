import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { join } from "path";

// 打字對話的核心模組。
// webhook 收到「不是 IG 連結」的文字時會呼叫 generateChatReply()，
// 由 CHAT_PROVIDER 環境變數決定用哪個引擎：
//   - "openrouter" : OpenRouter API（需 OPENROUTER_API_KEY，預設 nvidia/nemotron-3-ultra-550b-a55b:free）
//   - "anthropic"  : Claude API（需 ANTHROPIC_API_KEY）
//   - "openai"     : OpenAI API（需 OPENAI_API_KEY）
//   - "rules"      : 純關鍵字規則（不用金鑰，保底 fallback）
//
// 核心流程（LLM 模式）：
//   Phase 1：LLM 分類意圖（A/B/C）→ 抽取標籤 → 即時 push 分類結果
//   Phase 2：Session 決策（僅 B/C）→ 開新 session 或繼續現有 session → 即時 push 決策
//   Phase 3：記錄使用者 turn
//   Phase 4：runRecommendation → searchCandidates → scoreOutfits → formatRecommendation
//            每個子步驟完成後即時 push 進度
//   Phase 5：記錄 assistant turn，回傳結果（由 webhook push 給使用者）
//
// 意圖類型：
//   A：找「一件特定單品」，給限制條件，不需要搭配
//   B：已有「一件指定衣物」，找可以互相搭配的其他衣物
//   C：針對「場合/情境」，找完整一套穿搭，沒有指定衣物
//
// 即時回饋機制（onProgress callback）：
//   generateChatReply 接受 options.onProgress?: (msg: string) => Promise<void>
//   webhook 傳入 pushMessage 作為 onProgress，每個 phase 完成後立刻推送進度給 LINE 使用者
//   不傳 onProgress 時（例如直接測試），靜默略過 push。

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
}

async function searchCandidates(
  classifiedResult: string,
  _session: FashionSession
): Promise<SearchResult> {
  // ── TODO：替換以下 dummy 實作 ──────────────────────────────────────────────
  // 解析標籤（顯示用）
  const keywordsMatch = classifiedResult.match(/\[keywords:\s*([^\]]+)\]/i);
  const itemMatch = classifiedResult.match(/\[item:\s*([^\]]+)\]/i);
  const styleMatch = classifiedResult.match(/\[風格:\s*([^\]]+)\]/i);
  const priceMatch = classifiedResult.match(/\[price:\s*([^\]]+)\]/i);

  const keywords = keywordsMatch?.[1]?.trim() ?? "(未解析到)";
  const item = itemMatch?.[1]?.trim() ?? null;
  const style = styleMatch?.[1]?.trim() ?? null;
  const price = priceMatch?.[1]?.trim() ?? null;

  const summaryParts = [`keywords: ${keywords}`];
  if (item) summaryParts.push(`item: ${item}`);
  if (style) summaryParts.push(`風格: ${style}`);
  if (price) summaryParts.push(`price: ${price}`);

  const debugSummary = summaryParts.join(" | ");

  console.log(`[chat] searchCandidates (dummy) ${debugSummary}`);

  return {
    candidatesByLayer: {}, // dummy：各 layer 均為空陣列
    queryEmbedding: null,
    debugSummary,
  };
  // ── TODO 結束 ───────────────────────────────────────────────────────────────
}

// ── 評分排序（TODO：實作 Beam Search + 三部份評分公式） ────────────────────────
// 輸入：searchCandidates 結果 + session（用來取 user_vec）
// 輸出：評分後的搭配清單（降序）
//
// TODO 實作步驟：
//   S = α·S_query + β·S_user + γ·S_compatibility
//   S_query      : query_embedding 與各單品 embedding 的 cosine similarity
//   S_user       : user_vec 與各單品 embedding 的 cosine similarity（需偏好檔）
//   S_compatibility: 同套搭配各單品 embedding 兩兩 cosine similarity 的平均
//   Beam Search  : 寬度 3~5，逐 layer（top → bottom → outer → footwear）展開最佳路徑

interface ScoredOutfit {
  // 搭配中各單品的資料（來自 candidatesByLayer 中的 CandidateItem）
  items: CandidateItem[];
  // 綜合評分（越高越好）
  score: number;
  // 搭配理由（TODO：由 LLM 生成）
  reason: string;
}

async function scoreOutfits(
  searchResult: SearchResult,
  _session: FashionSession
): Promise<ScoredOutfit[]> {
  // ── TODO：替換以下 dummy 實作 ──────────────────────────────────────────────
  const totalCandidates = Object.values(searchResult.candidatesByLayer)
    .reduce((sum, arr) => sum + arr.length, 0);

  console.log(`[chat] scoreOutfits (dummy) totalCandidates=${totalCandidates}`);

  return []; // dummy：回傳空陣列，等實作 Beam Search 後替換
  // ── TODO 結束 ───────────────────────────────────────────────────────────────
}

// ── 格式化回傳訊息（TODO：實作 LINE Flex Message） ────────────────────────────
// 輸入：scoreOutfits 結果 + 分類結果 + session + provider
// 輸出：對 LINE 使用者顯示的最終字串（或 JSON Flex Message）
//
// TODO 實作步驟：
//   1. 用 LLM 根據 rule 內容生成搭配理由（中文）
//   2. 組裝 LINE Flex Message（含商品圖片、名稱、價格、連結、說明）
//   3. 若 scoredOutfits 為空，回傳友善的找不到訊息

async function formatRecommendation(
  scoredOutfits: ScoredOutfit[],
  classifiedResult: string,
  _session: FashionSession,
  _provider: string
): Promise<string> {
  // ── TODO：替換以下 dummy 實作 ──────────────────────────────────────────────
  if (scoredOutfits.length === 0) {
    // placeholder：直接回傳分類器的結構化輸出，讓開發者看到標籤解析結果
    return classifiedResult;
  }
  return scoredOutfits
    .map((o, i) => `套餐 ${i + 1}（分數 ${o.score.toFixed(3)}）：${o.reason}`)
    .join("\n\n");
  // ── TODO 結束 ───────────────────────────────────────────────────────────────
}

// ── 推薦主流程（串接三段 dummy，每步完成後即時 push 進度） ────────────────────
// onProgress：由外部（webhook）傳入，用來即時推送進度給 LINE 使用者
async function runRecommendation(
  classifiedResult: string,
  session: FashionSession,
  provider: string,
  onProgress?: (msg: string) => Promise<void>
): Promise<string> {
  // Step A：搜尋候選服飾
  const searchResult = await searchCandidates(classifiedResult, session);
  const layerSummary = Object.entries(searchResult.candidatesByLayer)
    .map(([k, v]) => `  ${k}: ${v.length} 件`)
    .join("\n");
  await onProgress?.(
    `🔍 候選服飾搜尋完成\n──────────\n${searchResult.debugSummary}\n候選數：\n${layerSummary || "  （各 layer 均為 dummy 空陣列，等待 embedding 實作）"}`
  );

  // Step B：評分排序
  const scoredOutfits = await scoreOutfits(searchResult, session);
  const topScore = scoredOutfits[0]?.score.toFixed(3) ?? "—";
  await onProgress?.(
    `📊 評分排序完成\n──────────\n套餐數：${scoredOutfits.length}${scoredOutfits.length === 0 ? "（dummy，Beam Search 尚未實作）" : ""}\n最高分：${topScore}`
  );

  // Step C：格式化
  const result = await formatRecommendation(scoredOutfits, classifiedResult, session, provider);
  return result;
}

// ══════════════════════════════════════════════════════════════════════════════
// 使用者偏好更新
// 在 session 結束（「重開」或手動 /end）後，用 LLM 萃取本次對話的偏好，
// 寫入 data/user-prefs/{userId}.md，供下次 session 作為冷啟動上下文。
// ══════════════════════════════════════════════════════════════════════════════

const PREFERENCE_UPDATE_PROMPT = `你是 WowStylist 使用者偏好分析師。
根據以下穿搭討論的對話記錄，提取使用者明確表達的偏好，以 Markdown 格式輸出。

規則：
- 只記錄使用者明確提到的內容，不推測或臆測沒說過的事
- 若某欄位資料不足，直接省略該欄位
- 每個欄位 1~3 條，簡潔即可
- 直接輸出 Markdown 格式，不要任何說明文字或前言

## 輸出格式（照此結構，省略空欄位）

### 偏好風格
（使用者在對話中提到的穿搭風格）

### 場合
（使用者討論的穿衣場合）

### 預算
（若有提到價格或預算範圍）

### 顏色偏好
（明確提到喜歡或不喜歡的顏色）

### 版型／材質
（若有特別提到的版型或材質偏好）

### 其他備註
（其他值得記錄的偏好，例如指定品牌、排斥風格等）`;

/**
 * 內部：讀取已結束的 session → LLM 萃取偏好 → 寫入 .md 檔。
 * 在 endSession() 之後呼叫（sessionStore 中資料仍在，status=ended）。
 */
async function doUpdateUserPreference(userId: string, provider: string): Promise<void> {
  const session = sessionStore.get(userId);
  if (!session || session.turns.length < 2) {
    console.log(`[pref] 跳過偏好更新（turns=${session?.turns.length ?? 0}，不足 2 輪）`);
    return;
  }

  const transcript = session.turns
    .map((t) => `${t.role === "user" ? "使用者" : "助手"}：${t.content.slice(0, 300)}`)
    .join("\n");

  const { content: extracted } = await callLLM(provider, PREFERENCE_UPDATE_PROMPT, transcript, 400);
  if (!extracted) {
    console.warn(`[pref] 偏好萃取 LLM 無回應，跳過`);
    return;
  }

  const dir  = join(process.cwd(), "data", "user-prefs");
  const file = join(dir, `${userId}.md`);

  try {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    const date      = new Date().toISOString().slice(0, 10);
    const newBlock  = `\n\n---\n## Session ${date}\n\n${extracted.trim()}`;

    if (existsSync(file)) {
      const old = readFileSync(file, "utf-8");
      // 把新的 session 插在第一行（標題）之後
      const firstNewline = old.indexOf("\n");
      const head = firstNewline >= 0 ? old.slice(0, firstNewline + 1) : old + "\n";
      const tail = firstNewline >= 0 ? old.slice(firstNewline + 1) : "";
      writeFileSync(file, head + newBlock + tail, "utf-8");
    } else {
      writeFileSync(file, `# 使用者偏好紀錄\n\n> userId: ${userId}${newBlock}`, "utf-8");
    }

    console.log(`[pref] 偏好檔更新完成 → ${file}`);
  } catch (e) {
    console.error(`[pref] 寫入偏好檔失敗:`, e);
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// 對外主函式
// ══════════════════════════════════════════════════════════════════════════════

export async function generateChatReply(
  userId: string | null,
  text: string,
  options?: {
    // 非 IG 的 URL（webhook 偵測到後附上，讓 LLM 知道上下文）
    nonIgUrls?: string[];
    // 每個 phase 完成後呼叫，即時推送進度給 LINE 使用者
    // 由 webhook 傳入 pushMessage(userId, msg)；不傳時靜默略過
    onProgress?: (msg: string) => Promise<void>;
  }
): Promise<string> {
  const nonIgUrls = options?.nonIgUrls;
  const onProgress = options?.onProgress;
  const debug = process.env.CHAT_DEBUG === "true";

  const explicit = (process.env.CHAT_PROVIDER || "").toLowerCase();
  const provider = explicit ||
    (process.env.OPENROUTER_API_KEY ? "openrouter" :
     process.env.ANTHROPIC_API_KEY  ? "anthropic"  :
     process.env.OPENAI_API_KEY     ? "openai"     : "rules");
  const model = process.env.CHAT_MODEL ||
    (provider === "openrouter" ? "nvidia/nemotron-3-ultra-550b-a55b:free" :
     provider === "anthropic"  ? "claude-haiku-4-5" :
     provider === "openai"     ? "gpt-4o-mini" : "-");

  // ── rules 模式 ──────────────────────────────────────────────────────────────
  if (provider === "rules") {
    return chatWithRules(text);
  }

  // ── LLM 模式 ────────────────────────────────────────────────────────────────
  if (debug) {
    await onProgress?.(`[DEBUG] provider=${provider} | model=${model} | userId=${userId ?? "null"}`);
  }

  const userPrefs = loadUserPrefs(userId);
  if (userPrefs) {
    console.log(`[chat] 已載入使用者偏好 userId=${userId}`);
    await onProgress?.(`ℹ️ 已載入偏好檔（${userPrefs.length} 字元）`);
  } else {
    await onProgress?.(`ℹ️ 無偏好檔（冷啟動）`);
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Phase 1：意圖分類
  // ──────────────────────────────────────────────────────────────────────────
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
    const errDetail = debug ? `\n原因：${classifyReason}` : "";
    await onProgress?.(`❌ 意圖分類失敗，降級到關鍵字模式${errDetail}`);
    return chatWithRules(text);
  }

  const intent = parseIntent(classifiedResult);
  const intentLabels: Record<Intent, string> = {
    A: "A（單品查找）",
    B: "B（搭配現有衣物）",
    C: "C（完整穿搭）",
    other: "其他（閒聊／問候）",
  };
  // 從分類結果中擷取標籤摘要
  const styleMatch = classifiedResult.match(/\[風格:\s*([^\]]+)\]/i);
  const kwMatch    = classifiedResult.match(/\[keywords:\s*([^\]]+)\]/i);
  const itemMatch  = classifiedResult.match(/\[item:\s*([^\]]+)\]/i);
  const priceMatch = classifiedResult.match(/\[price:\s*([^\]]+)\]/i);

  const tagLines: string[] = [`意圖：${intentLabels[intent]}`];
  if (styleMatch) tagLines.push(`風格：${styleMatch[1].trim()}`);
  if (kwMatch)    tagLines.push(`關鍵詞：${kwMatch[1].trim()}`);
  if (itemMatch)  tagLines.push(`指定單品：${itemMatch[1].trim()}`);
  if (priceMatch) tagLines.push(`預算：${priceMatch[1].trim()}`);
  if (debug) {
    tagLines.push(`分類輸出：${classifiedResult.slice(0, 120).replace(/\n/g, " ")}`);
  }

  await onProgress?.(`🧠 意圖分析完成\n──────────\n${tagLines.join("\n")}`);
  console.log(`[chat] 分類結果 intent=${intent}: ${classifiedResult.slice(0, 200)}`);

  // ──────────────────────────────────────────────────────────────────────────
  // Phase 2：Session 決策（僅 B/C；A/other 直接回傳）
  // ──────────────────────────────────────────────────────────────────────────
  let session: FashionSession | null = null;

  if (!userId || intent === "other") {
    // A 意圖或閒聊：不開 session，直接回傳分類結果
    return classifiedResult;
  }

  // B / C 意圖：進入 session 管理
  const existingSession = getActiveSession(userId);

  if (!existingSession) {
    session = startNewSession(userId);
    await onProgress?.(
      `📂 Session 已開啟\n──────────\nSession ID：${session.sessionId}\n這是新對話`
    );
  } else {
    const decision = await decideSessionAction(existingSession, text, provider);
    console.log(`[chat] session 決策：${decision} sessionId=${existingSession.sessionId}`);

    if (decision === "new") {
      const oldId    = existingSession.sessionId;
      const oldTurns = existingSession.turns.length;

      // 結束舊 session（資料仍保留在 sessionStore，status=ended）
      endSession(userId);

      // 若舊 session 有足夠對話，萃取偏好並寫檔
      if (oldTurns >= 2) {
        await onProgress?.(`💾 更新偏好檔（舊 session ${oldTurns} 輪）...`);
        await doUpdateUserPreference(userId, provider);
        await onProgress?.(`💾 偏好檔更新完成`);
      }

      session = startNewSession(userId);
      await onProgress?.(
        `📂 重新開啟 Session\n──────────\n舊 Session：${oldId}（${oldTurns} 輪）已結束\n新 Session：${session.sessionId}`
      );
    } else {
      session = existingSession;
      await onProgress?.(
        `📂 繼續現有 Session\n──────────\nSession ID：${session.sessionId}\n歷史對話：${session.turns.length} 輪`
      );

      // 繼續路徑：帶入對話歷史重新分類
      const continuationMessage = buildContinuationMessage(session, text, nonIgUrls, userPrefs);
      const { content: reClassified } = await callLLM(
        provider,
        CLASSIFIER_SYSTEM_PROMPT,
        continuationMessage,
        700
      );

      if (reClassified) {
        const reIntent = parseIntent(reClassified);
        const reStyleMatch = reClassified.match(/\[風格:\s*([^\]]+)\]/i);
        const reKwMatch    = reClassified.match(/\[keywords:\s*([^\]]+)\]/i);
        const reTagLines: string[] = [`意圖：${intentLabels[reIntent]}`];
        if (reStyleMatch) reTagLines.push(`風格：${reStyleMatch[1].trim()}`);
        if (reKwMatch)    reTagLines.push(`關鍵詞：${reKwMatch[1].trim()}`);
        if (debug) {
          reTagLines.push(`分類輸出：${reClassified.slice(0, 120).replace(/\n/g, " ")}`);
        }
        await onProgress?.(`🔄 重新分類（含對話歷史）\n──────────\n${reTagLines.join("\n")}`);
        console.log(`[chat] 重新分類（帶歷史）: ${reClassified.slice(0, 200)}`);

        // Phase 3（continuation 路徑）
        appendTurn(session, { role: "user", content: text, intent: reIntent, timestamp: Date.now() });

        // Phase 4
        const finalResult = await runRecommendation(reClassified, session, provider, onProgress);

        // Phase 5
        appendTurn(session, { role: "assistant", content: finalResult, timestamp: Date.now() });
        await onProgress?.(
          `📝 對話已記錄\n──────────\nSession：${session.sessionId}\n目前 turns：${session.turns.length}`
        );
        return finalResult;
      }

      await onProgress?.("⚠️ 重新分類失敗，使用初始分類結果繼續");
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Phase 3：記錄使用者 turn（新 session 路徑）
  // ──────────────────────────────────────────────────────────────────────────
  appendTurn(session, { role: "user", content: text, intent, timestamp: Date.now() });

  // ──────────────────────────────────────────────────────────────────────────
  // Phase 4：推薦流程（searchCandidates → scoreOutfits → formatRecommendation）
  // ──────────────────────────────────────────────────────────────────────────
  const recommendation = await runRecommendation(
    classifiedResult,
    session,
    provider,
    onProgress
  );

  // ──────────────────────────────────────────────────────────────────────────
  // Phase 5：記錄 assistant turn，回傳（由 webhook push 給使用者）
  // ──────────────────────────────────────────────────────────────────────────
  appendTurn(session, { role: "assistant", content: recommendation, timestamp: Date.now() });
  await onProgress?.(
    `📝 對話已記錄\n──────────\nSession：${session.sessionId}\n目前 turns：${session.turns.length}`
  );

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
 * 若無 session（含已結束的）回傳 null。
 */
export function getSessionHistory(userId: string): ChatTurn[] | null {
  const session = sessionStore.get(userId);
  if (!session) return null;
  return session.turns;
}

/**
 * 手動觸發偏好檔更新（供 test script、webhook 的「結束」按鈕等外部呼叫）。
 * 會讀取 sessionStore 中最後一筆該 userId 的 session（active 或 ended 皆可）。
 * @param userId    LINE userId 或 test 用的任意字串
 * @param provider  LLM provider（openrouter / anthropic / openai / rules）
 */
export async function updateUserPreferenceFile(userId: string, provider: string): Promise<void> {
  await doUpdateUserPreference(userId, provider);
}
