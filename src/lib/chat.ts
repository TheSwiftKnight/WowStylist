import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
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

// 穿搭對話核心模組。
// webhook 收到「不是 IG 連結」的文字時會呼叫 generateChatReply()，
// 由 CHAT_PROVIDER 環境變數決定用哪個引擎：
//   - "anthropic"  : Claude API（需 ANTHROPIC_API_KEY，預設 claude-haiku-4-5-20251001）★ 預設
//                    原本這裡是 OpenRouter 的 Nemotron，已整個換成 Claude；
//                    兩邊 API 的差異寫在下面 callAnthropic 上方。
//   - "openai"     : OpenAI API（需 OPENAI_API_KEY）
//   - "rules"      : 純關鍵字規則（不用金鑰，保底 fallback）
//
// 核心流程（LLM 模式）：
//   1. 若輸入為問候 / 使用說明 → chatWithRules() 直接回傳
//   2. 取得或開啟 session
//      - 新 session：accumulatedRequest 以使用者偏好檔
//        （data/user-prefs/<userId>.md）初始化
//      - session 只在使用者傳「結束這次討論」或傳 IG 連結時結束，
//        在那之前每一輪的輸入都會累積起來一起送進分析
//   3. accumulatedRequest = accumulatedRequest + "\n\n" + 本次輸入
//   4. 送 accumulatedRequest 給 LLM 做語意分析（單次 call）→ 得到 [風格:] 等標籤
//   5. 若 intent = "other" → 回傳「告訴我多一點…」
//   6. A/B/C 意圖 → 分類結果**不是**最終回覆，而是推薦 pipeline 的輸入：
//        runRecommendation
//          → searchCandidates  : [風格:] 查 style_kb → 撈候選商品向量 + 偏好向量
//          → scoreOutfits      : rank.ts 算 S_final = 0.67×S_user + 0.33×S_query
//          → formatRecommendation : 排出前幾套，格式化成回覆
//      （合併 feature/llm-routing 時特別保留這段：分支上原本是直接把
//        「適合風格」當成回覆輸出，那會跳過整個查表→算分流程。）
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

// ── LLM 呼叫：Claude（Anthropic Messages API）──────────────────────────────
//
// 跟先前用的 OpenRouter / Nemotron（OpenAI 相容格式）幾個關鍵差異：
//
//   1. 端點與認證
//        OpenAI 相容：POST /chat/completions，Authorization: Bearer <key>
//        Claude：      POST /v1/messages，x-api-key: <key> + anthropic-version
//   2. system prompt
//        OpenAI 相容：塞進 messages[0]，role="system"
//        Claude：      是 body 最上層的 `system` 欄位，不進 messages
//   3. max_tokens
//        Claude 是**必填**，漏了直接 400
//   4. 回應形狀
//        OpenAI 相容：choices[0].message.content（字串，有些模型給 chunk 陣列）
//        Claude：      content[] 是 block 陣列，文字在 type==="text" 的 .text，
//                      而且可能不只一塊，要全部接起來
//   5. 截斷判斷
//        OpenAI 相容：choices[0].finish_reason === "length"
//        Claude：      stop_reason === "max_tokens"
//   6. 錯誤格式
//        Claude 用 HTTP 狀態碼 + { type:"error", error:{ type, message } }；
//        不像 OpenRouter 會拿 HTTP 200 包一個 error 物件回來，所以不用再多檢查一層
//   7. temperature 範圍 0~1（OpenAI 是 0~2），而且沒有 reasoning / reasoning_effort
//
// 這裡刻意不做重試：整條流程跑在 webhook 的 after() 背景裡，時間預算很緊
// （見 route.ts 的說明），寧可把失敗原因講清楚，讓上層降級到 rules。

/** 最快也最便宜；分類這種照表填欄位的工作夠用。要更準可設 CHAT_MODEL=claude-sonnet-5。 */
const DEFAULT_CLAUDE_MODEL = "claude-haiku-4-5-20251001";

function claudeModel(): string {
  return process.env.CHAT_MODEL || DEFAULT_CLAUDE_MODEL;
}

async function callAnthropic(
  systemPrompt: string,
  userMessage: string,
  maxTokens = 400
): Promise<LLMResult> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    const reason = "NO_API_KEY: ANTHROPIC_API_KEY 未設定";
    console.error(`[chat] ${reason}`);
    return { content: null, reason };
  }

  const model = claudeModel();
  const timeoutMs = Number(process.env.CHAT_TIMEOUT_MS || 8000);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = Date.now();

  try {
    console.log(`[chat] Claude 送出請求 model=${model} timeout=${timeoutMs}ms`);
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,   // Claude 必填
        temperature: 0,          // 分類要穩定，不要發散
        system: systemPrompt,    // 最上層欄位，不是 messages[0]
        messages: [{ role: "user", content: userMessage }],
      }),
    });
    clearTimeout(timer);
    const elapsed = Date.now() - startedAt;

    if (!res.ok) {
      const body = await res.text();
      let detail = body.slice(0, 300);
      try {
        const parsed = JSON.parse(body) as { error?: { type?: string; message?: string } };
        if (parsed.error) detail = `${parsed.error.type}: ${parsed.error.message}`;
      } catch { /* 不是 JSON 就用原文 */ }

      const hint =
        res.status === 401 ? "（金鑰不對或沒權限）"
        : res.status === 404 ? `（模型名稱可能有誤：${model}）`
        : res.status === 429 ? "（rate limit 或額度用完）"
        : res.status === 529 ? "（Anthropic 端過載，稍後再試）"
        : "";

      const reason = `HTTP_${res.status} (${elapsed}ms)${hint}: ${detail}`;
      console.error(`[chat] Claude ${reason} model=${model}`);
      return { content: null, reason };
    }

    const data = (await res.json()) as {
      content?: { type: string; text?: string }[];
      stop_reason?: string;
      usage?: { input_tokens?: number; output_tokens?: number };
    };

    if (data.stop_reason === "max_tokens") {
      const reason = `TRUNCATED stop_reason=max_tokens (${elapsed}ms) — 調高 maxTokens`;
      console.error(`[chat] Claude ${reason} model=${model}`);
      return { content: null, reason };
    }

    // content 是 block 陣列，文字可能被切成好幾塊
    const content = (data.content ?? [])
      .filter((c) => c.type === "text")
      .map((c) => c.text ?? "")
      .join("")
      .trim();

    if (!content) {
      const raw = JSON.stringify(data).slice(0, 200);
      const reason = `EMPTY_CONTENT (${elapsed}ms) stop_reason=${data.stop_reason} raw=${raw}`;
      console.error(`[chat] Claude ${reason} model=${model}`);
      return { content: null, reason };
    }

    console.log(
      `[chat] Claude 回應成功 (${elapsed}ms) stop_reason=${data.stop_reason} ` +
      `tokens=${data.usage?.input_tokens ?? "?"}/${data.usage?.output_tokens ?? "?"}`
    );
    return { content, reason: "ok" };

  } catch (e: unknown) {
    clearTimeout(timer);
    const elapsed = Date.now() - startedAt;
    let reason: string;
    if (e instanceof Error && e.name === "AbortError") {
      reason = `TIMEOUT >${elapsed}ms — 可調 CHAT_TIMEOUT_MS，或換更快的模型`;
    } else if (e instanceof TypeError) {
      reason = `NETWORK_ERROR (${elapsed}ms): ${e.message}`;
    } else {
      reason = `UNKNOWN_ERROR (${elapsed}ms): ${String(e)}`;
    }
    console.error(`[chat] Claude ${reason} model=${claudeModel()}`);
    return { content: null, reason };
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
  if (provider === "anthropic") return callAnthropic(systemPrompt, userMessage, maxTokens);
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
// data/user-prefs/<userId>.md —— 由 doUpdateUserPreference() 在使用者傳
// 「結束這次討論」時寫入／更新（見本檔下方）。
//
// 注意：這裡讀的是「給 prompt 看的文字偏好」。rank.ts 另外有
// loadUserPreferenceEmbeddings()，那個是算 S_user 用的向量，來源是 IG RDS，
// 兩者互不影響。
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
  /** 明確分開上下身 —— Flex 卡片要分別放 like 按鈕跟商品連結 */
  top: RankedProduct | null;
  bottom: RankedProduct | null;
  score: number;
  reason: string;
}

/**
 * 給 UI 用的推薦結果（不帶 embedding 那些重東西）。
 * chat.ts 只負責算出這個；要變成 LINE Flex 卡片是 src/lib/flex.ts 的事。
 */
export type RecommendedItem = {
  slot: "top" | "bottom";
  productId: number;
  title: string | null;
  priceTwd: number | null;
  productUrl: string | null;
  finalScore: number;
};

export type RecommendedOutfit = {
  /** 第幾套，從 1 開始 */
  index: number;
  styleZh: string;
  items: RecommendedItem[];
};

/** generateChatReply 的回傳：純文字一定有，outfits 有推薦時才有。 */
export type ChatReply = {
  text: string;
  outfits?: RecommendedOutfit[];
  /** 偏好來源，webhook 想顯示提示時可用 */
  prefScope?: "user" | "global" | "none";
};

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
      top: top ?? null,
      bottom: bottom ?? null,
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
/** ScoredOutfit → 給 UI 的精簡結構（丟掉 embedding 等內部欄位）。 */
function toRecommendedOutfits(
  scored: ScoredOutfit[],
  styleZh: string
): RecommendedOutfit[] {
  return scored.map((o, i) => {
    const items: RecommendedItem[] = [];
    for (const [slot, p] of [["top", o.top], ["bottom", o.bottom]] as const) {
      if (!p) continue;
      items.push({
        slot,
        productId: p.productId,
        title: p.title,
        priceTwd: p.priceTwd,
        productUrl: p.productUrl,
        finalScore: p.finalScore,
      });
    }
    return { index: i + 1, styleZh, items };
  }).filter((o) => o.items.length > 0);
}

async function runRecommendation(
  classifiedResult: string,
  session: FashionSession,
  provider: string,
  debugLines?: string[]
): Promise<{ text: string; outfits: RecommendedOutfit[]; prefScope: "user" | "global" | "none" }> {
  // Step A：搜尋候選服飾
  debugLines?.push("[4/6] 🔍 搜尋候選服飾（searchCandidates）...");
  const searchResult = await searchCandidates(classifiedResult, session);
  debugLines?.push(`      ↳ ${searchResult.debugSummary}`);

  // Step B：評分排序
  debugLines?.push("[5/6] 📊 評分排序（scoreOutfits）...");
  const scoredOutfits = await scoreOutfits(searchResult, session);
  debugLines?.push(
    `      ↳ 最終套餐數：${scoredOutfits.length}` +
    `（S_final = ${USER_WEIGHT} × S_user + ${QUERY_WEIGHT} × S_query）`
  );

  // Step C：格式化
  debugLines?.push("[6/6] ✍️  格式化推薦結果（formatRecommendation）...");
  const text = await formatRecommendation(
    scoredOutfits, classifiedResult, session, provider, searchResult
  );

  const styleZh =
    searchResult.style?.styleZh ?? searchResult.style?.style ?? "推薦搭配";
  const outfits = toRecommendedOutfits(scoredOutfits, styleZh);
  debugLines?.push(`      ↳ 完成，${outfits.length} 套可以做成卡片`);

  return { text, outfits, prefScope: searchResult.userPrefs.scope as "user" | "global" | "none" };
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
): Promise<ChatReply> {
  const nonIgUrls = options?.nonIgUrls;
  const onProgress = options?.onProgress;
  const debug = process.env.CHAT_DEBUG === "true";

  // debug 模式：累積逐步說明，最後拼在回傳訊息最前面
  const debugLines: string[] = [];
  const D = (line: string) => { if (debug) debugLines.push(line); };

  const explicit = (process.env.CHAT_PROVIDER || "").toLowerCase();
  const provider = explicit ||
    (process.env.ANTHROPIC_API_KEY ? "anthropic" :
     process.env.OPENAI_API_KEY    ? "openai"    : "rules");
  const model = process.env.CHAT_MODEL ||
    (provider === "anthropic" ? DEFAULT_CLAUDE_MODEL :
     provider === "openai"    ? "gpt-4o-mini" : "-");

  if (debug) {
    await onProgress?.(`[DEBUG] provider=${provider} | model=${model} | userId=${userId ?? "null"}`);
  }
  D(`[DEBUG] provider=${provider} | model=${model} | userId=${userId ?? "null"}`);
  D("");

  // ── rules 模式 ──────────────────────────────────────────────────────────────
  if (provider === "rules") {
    return { text: chatWithRules(text) };
  }

  // ── 問候 / 使用說明：不進 session，直接 rules 回應 ─────────────────────────
  if (isGreetingOrHowTo(text)) {
    console.log(`[chat] 問候/使用說明，直接 rules 回應`);
    return { text: chatWithRules(text) };
  }

  // ── 使用者偏好 ──────────────────────────────────────────────────────────────
  // 來源是 data/user-prefs/<userId>.md，由上一次 session 結束時萃取寫入。
  const userPrefs = loadUserPrefs(userId);
  if (userPrefs) {
    console.log(`[chat] 已載入使用者偏好檔 userId=${userId}（${userPrefs.length} chars）`);
    D(`ℹ️  已載入使用者偏好檔（${userPrefs.length} chars）`);
  } else {
    console.log(`[chat] 無使用者偏好檔 userId=${userId}（冷啟動）`);
    D(`ℹ️  無使用者偏好檔（冷啟動）`);
  }

  // ── Session：取得現有的，沒有就開新的 ───────────────────────────────────────
  // 注意：session 不會被 LLM 自動切換。只有使用者傳「結束這次討論」（webhook
  // 呼叫 endFashionSession）或傳 IG 連結時才結束，在那之前一律視為同一次對話。
  let session: FashionSession;
  const existingSession = userId ? getActiveSession(userId) : null;

  if (!existingSession) {
    const initialRequest = userPrefs ? `[使用者偏好紀錄]\n${userPrefs}` : "";
    session = startNewSession(userId ?? `anon_${Date.now()}`, initialRequest);
    console.log(`[chat] 開啟新 session，初始偏好 ${initialRequest.length} 字元`);
    D(`[1/6] 🗂️  開啟新 session（${session.sessionId}），初始偏好 ${initialRequest.length} 字元`);
  } else {
    session = existingSession;
    console.log(`[chat] 繼續現有 session ${session.sessionId}，已有 ${session.turns.length} 輪`);
    D(`[1/6] 🗂️  沿用 session ${session.sessionId}（已 ${session.turns.length} 輪）`);
  }

  // ── 累積需求：舊內容 + 本次輸入 ─────────────────────────────────────────────
  // 同一個 session 裡的每一句都會被帶進來一起分析，所以使用者可以分多次
  // 慢慢補條件（「要去婚禮」→「預算三千」→「想低調一點」）。
  let inputText = text;
  if (nonIgUrls && nonIgUrls.length > 0) {
    inputText += `\n[使用者附上非 IG 連結：${nonIgUrls.join(", ")}]`;
  }

  const accumulated = session.accumulatedRequest
    ? `${session.accumulatedRequest}\n\n${inputText}`
    : inputText;

  console.log(`[chat] 累積需求長度 ${accumulated.length} 字元，送 LLM 分析`);
  D(`[2/6] 📚 累積需求 ${accumulated.length} 字元（本輪 ${inputText.length} 字元）`);

  // ── 單次 LLM 分析（送累積需求）→ 解析出 [風格:] [item:] [keywords:] [price:] ─
  D("[3/6] 🧠 意圖分類 + 風格匹配（CLASSIFIER_SYSTEM_PROMPT）...");
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
    return { text: chatWithRules(text) };
  }

  const intent = parseIntent(classifiedResult);
  console.log(`[chat] 分類結果 intent=${intent}: ${classifiedResult.slice(0, 200)}`);
  D(`      ↳ intent=${intent}｜${classifiedResult.slice(0, 120).replace(/\n/g, " ")}`);

  // ── 意圖不明：問清楚，不污染累積需求 ──────────────────────────────────────
  if (intent === "other") {
    // 不更新 accumulatedRequest（本次輸入不納入累積），也不記錄 turn
    return {
      text: "告訴我多一點，我幫你搭！🎯\n你要去哪裡？預算大概多少？有偏好的風格嗎（例如簡約、可愛、復古）？",
    };
  }

  // ── A / B / C：確認累積需求，記錄 turn ────────────────────────────────────
  session.accumulatedRequest = accumulated;
  session.updatedAt = Date.now();
  appendTurn(session, { role: "user", content: text, intent, timestamp: Date.now() });

  // ── 分類結果是 pipeline 的「輸入」，不是回覆 ───────────────────────────────
  // classifiedResult 裡的 [風格:] 會被 searchCandidates 拿去查 style_kb.jsonl，
  // 撈出候選商品後由 rank.ts 算分，最後才格式化成使用者看到的推薦。
  await onProgress?.("🔍 抓到適合的風格了，正在從商品庫挑搭配...");

  const { text: recommendation, outfits, prefScope } = await runRecommendation(
    classifiedResult,
    session,
    provider,
    debug ? debugLines : undefined
  );

  appendTurn(session, { role: "assistant", content: recommendation, timestamp: Date.now() });
  console.log(
    `[chat] 完成 sessionId=${session.sessionId} 總 turns=${session.turns.length} 套數=${outfits.length}`
  );

  return {
    text: debug
      ? `${debugLines.join("\n")}\n────────────\n${recommendation}`
      : recommendation,
    outfits,
    prefScope,
  };
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
 * @param provider  LLM provider（anthropic / openai / rules）
 */
export async function updateUserPreferenceFile(userId: string, provider: string): Promise<void> {
  await doUpdateUserPreference(userId, provider);
}
