import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { join } from "path";

// 穿搭對話核心模組。
// webhook 收到「不是 IG 連結」的文字時會呼叫 generateChatReply()，
// 由 CHAT_PROVIDER 環境變數決定用哪個引擎：
//   - "openrouter" : OpenRouter API（需 OPENROUTER_API_KEY，預設 nvidia/nemotron-3-ultra-550b-a55b:free）
//   - "anthropic"  : Claude API（需 ANTHROPIC_API_KEY）
//   - "openai"     : OpenAI API（需 OPENAI_API_KEY）
//   - "rules"      : 純關鍵字規則（不用金鑰，保底 fallback）
//
// 核心流程（LLM 模式）：
//   1. 若輸入為問候 / 使用說明 → chatWithRules() 直接回傳
//   2. 取得或開啟 session
//      - 新 session：accumulatedRequest 以偏好檔內容初始化
//   3. accumulatedRequest = accumulatedRequest + "\n\n" + 本次輸入
//   4. 送 accumulatedRequest 給 LLM 做語意分析（單次 call）
//   5. 若 intent = "other" → 回傳「告訴我多一點…」
//   6. 其他意圖 → 更新 session，回傳分類結果
//
// 意圖類型：
//   A：找「一件特定單品」，給限制條件，不需要搭配
//   B：已有「一件指定衣物」，找可以互相搭配的其他衣物
//   C：針對「場合/情境」，找完整一套穿搭，沒有指定衣物

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
  /** 累積所有輪次的使用者需求（含初始偏好）；每輪 append 後送給 LLM */
  accumulatedRequest: string;
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

/**
 * 開啟新 session。
 * @param userId         LINE userId 或 test 用字串
 * @param initialRequest 可選的初始累積需求（通常為使用者偏好檔內容）
 */
function startNewSession(userId: string, initialRequest = ""): FashionSession {
  const session: FashionSession = {
    sessionId: `${userId}_${Date.now()}`,
    userId,
    status: "active",
    accumulatedRequest: initialRequest,
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

function parseIntent(classifierOutput: string): Intent {
  if (/\[item:/i.test(classifierOutput)) return "B";
  if (/\[keywords:/i.test(classifierOutput)) return "C";
  return "other"; // 含 A 意圖（無標籤）與閒聊
}

// ── 問候 / 使用說明 偵測 ──────────────────────────────────────────────────────
// 符合這些 pattern 的訊息直接用 rules 回應，不進 session 流程
function isGreetingOrHowTo(text: string): boolean {
  const t = text.trim().toLowerCase();
  return /怎麼用|怎么用|幫助|help|說明|收藏夾|我的收藏|看收藏|你好|嗨|哈囉|hi|hello/.test(t);
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
  return "告訴我多一點，我幫你搭！🎯\n你要去哪裡？預算大概多少？有偏好的風格嗎（例如簡約、可愛、復古）？";
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

// ══════════════════════════════════════════════════════════════════════════════
// 使用者偏好更新
// 在 session 結束（使用者傳「結束這次討論」）後，用 LLM 萃取本次對話的偏好，
// 寫入 data/user-prefs/{userId}.md，供下次 session 作為冷啟動上下文。
// ══════════════════════════════════════════════════════════════════════════════

const PREFERENCE_UPDATE_PROMPT = `你是 WowStylist 使用者偏好分析師。
根據以下使用者在本次穿搭討論中累積的所有需求輸入，提取使用者明確表達的偏好，以 Markdown 格式輸出。

輸入說明：
- 開頭若有 [使用者偏好紀錄] 區塊，是上次 session 留下的舊偏好，可作為參考但不應直接複製
- 其餘內容是本次 session 使用者實際輸入的穿搭需求（可能有多輪累積）
- 請以本次 session 的新需求為主更新偏好

規則：
- 只記錄使用者明確提到的內容，不推測或臆測沒說過的事
- 若某欄位資料不足，直接省略該欄位
- 每個欄位 1~3 條，簡潔即可
- 直接輸出 Markdown 格式，不要任何說明文字或前言

## 輸出格式（照此結構，省略空欄位）

### 偏好風格
（使用者在本次對話中提到的穿搭風格）

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
 * 內部：讀取已結束的 session → 以 accumulatedRequest 萃取偏好 → 寫入 .md 檔。
 * 在 endSession() 之後呼叫（sessionStore 中資料仍在，status=ended）。
 * 使用 accumulatedRequest（完整累積需求）而非 turns transcript，
 * 確保 LLM 拿到的是使用者原始需求全文，而非摘要過的對話紀錄。
 */
async function doUpdateUserPreference(userId: string, provider: string): Promise<void> {
  const session = sessionStore.get(userId);

  // 沒有累積需求 或 turns 少於 1 輪（使用者從未真正送出過需求），跳過
  const hasRequest = session?.accumulatedRequest && session.accumulatedRequest.trim().length > 0;
  const hasTurns   = (session?.turns.length ?? 0) >= 1;
  if (!session || !hasRequest || !hasTurns) {
    console.log(
      `[pref] 跳過偏好更新（turns=${session?.turns.length ?? 0}, accLen=${session?.accumulatedRequest?.length ?? 0}）`
    );
    return;
  }

  // 以本次 session 累積的使用者需求全文送給 LLM 萃取偏好
  const inputText = session.accumulatedRequest;
  console.log(`[pref] 送出累積需求（${inputText.length} 字元）給 LLM 萃取偏好`);

  const { content: extracted } = await callLLM(provider, PREFERENCE_UPDATE_PROMPT, inputText, 500);
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

  if (debug) {
    await onProgress?.(`[DEBUG] provider=${provider} | model=${model} | userId=${userId ?? "null"}`);
  }

  // ── rules 模式 ──────────────────────────────────────────────────────────────
  if (provider === "rules") {
    return chatWithRules(text);
  }

  // ── 問候 / 使用說明：不進 session，直接 rules 回應 ─────────────────────────
  if (isGreetingOrHowTo(text)) {
    console.log(`[chat] 問候/使用說明，直接 rules 回應`);
    return chatWithRules(text);
  }

  // ── LLM 模式：session 管理 ──────────────────────────────────────────────────
  const userPrefs = loadUserPrefs(userId);
  if (userPrefs) {
    console.log(`[chat] 已載入使用者偏好 userId=${userId}`);
  }

  // 取得現有 session 或開啟新 session
  let session: FashionSession;
  const existingSession = userId ? getActiveSession(userId) : null;

  if (!existingSession) {
    // 新 session：以偏好檔作為初始累積需求
    const initialRequest = userPrefs ? `[使用者偏好紀錄]\n${userPrefs}` : "";
    session = startNewSession(userId ?? `anon_${Date.now()}`, initialRequest);
    console.log(`[chat] 開啟新 session，初始偏好 ${initialRequest.length} 字元`);
  } else {
    session = existingSession;
    console.log(`[chat] 繼續現有 session ${session.sessionId}，已有 ${session.turns.length} 輪`);
  }

  // 組裝本輪的累積需求（舊內容 + 本次輸入）
  let inputText = text;
  if (nonIgUrls && nonIgUrls.length > 0) {
    inputText += `\n[使用者附上非 IG 連結：${nonIgUrls.join(", ")}]`;
  }

  const accumulated = session.accumulatedRequest
    ? `${session.accumulatedRequest}\n\n${inputText}`
    : inputText;

  console.log(`[chat] 累積需求長度 ${accumulated.length} 字元，送 LLM 分析`);

  // ── 單次 LLM 分析（送累積需求） ──────────────────────────────────────────────
  const { content: classifiedResult, reason: classifyReason } = await callLLM(
    provider,
    CLASSIFIER_SYSTEM_PROMPT,
    accumulated,
    700
  );

  if (!classifiedResult) {
    console.warn(`[chat] 分類器無回應（${classifyReason}），降級到 rules`);
    const errDetail = debug ? `\n原因：${classifyReason}` : "";
    await onProgress?.(`❌ 分析失敗，降級到關鍵字模式${errDetail}`);
    return chatWithRules(text);
  }

  const intent = parseIntent(classifiedResult);
  console.log(`[chat] 分類結果 intent=${intent}: ${classifiedResult.slice(0, 200)}`);

  // ── 意圖不明：告訴我多一點 ────────────────────────────────────────────────
  if (intent === "other") {
    // 不更新 accumulatedRequest（本次輸入不納入累積），也不記錄 turn
    return "告訴我多一點，我幫你搭！🎯\n你要去哪裡？預算大概多少？有偏好的風格嗎（例如簡約、可愛、復古）？";
  }

  // ── A / B / C 意圖：確認累積需求，記錄 turn，回傳分類結果 ─────────────────
  session.accumulatedRequest = accumulated;
  session.updatedAt = Date.now();

  appendTurn(session, { role: "user", content: text, intent, timestamp: Date.now() });
  appendTurn(session, { role: "assistant", content: classifiedResult, timestamp: Date.now() });

  return classifiedResult;
}

// ── 對外輔助函式 ──────────────────────────────────────────────────────────────

/**
 * 結束使用者的穿搭 session。
 * 由 webhook 在使用者傳「結束這次討論」時呼叫。
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
 * 手動觸發偏好檔更新（供 test script、webhook 的「結束這次討論」等外部呼叫）。
 * 會讀取 sessionStore 中最後一筆該 userId 的 session（active 或 ended 皆可）。
 * @param userId    LINE userId 或 test 用的任意字串
 * @param provider  LLM provider（openrouter / anthropic / openai / rules）
 */
export async function updateUserPreferenceFile(userId: string, provider: string): Promise<void> {
  await doUpdateUserPreference(userId, provider);
}
