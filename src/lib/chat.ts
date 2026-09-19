// 打字對話的核心模組。
// webhook 收到「不是 IG 連結」的文字時會呼叫 generateChatReply()，
// 由 CHAT_PROVIDER 環境變數決定用哪個引擎：
//   - "openrouter" : OpenRouter API（需 OPENROUTER_API_KEY，預設 nvidia/nemotron-3-ultra-550b-a55b:free）
//   - "anthropic"  : Claude API（需 ANTHROPIC_API_KEY）
//   - "openai"     : OpenAI API（需 OPENAI_API_KEY）
//   - "rules"      : 純關鍵字規則（不用金鑰，保底 fallback）
//
// 核心流程（LLM 模式）：
//   單一 LLM 呼叫：分類意圖（A/B/C）→ 抽取標籤 → 輸出結構化結果
//
// 意圖類型：
//   A：找「一件特定單品」，給限制條件，不需要搭配
//   B：已有「一件指定衣物」，找可以互相搭配的其他衣物
//   C：針對「場合/情境」，找完整一套穿搭，沒有指定衣物

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

// LLM 回傳結果，content=null 時 reason 說明失敗原因（會直接出現在 DEBUG LINE 訊息裡）
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

    // OpenRouter 有時 HTTP 200 但 body 裡帶 error 欄位
    if (data.error) {
      const reason = `API_ERROR code=${data.error.code}: ${data.error.message}`;
      console.error(`[chat] OpenRouter ${reason} (${elapsed}ms) model=${model}`);
      return { content: null, reason };
    }

    const choice = data.choices?.[0];
    const msg = choice?.message;

    // finish_reason=length 代表輸出被截斷，內容不完整
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

    // Nemotron 等模型有時把 content 回成 array（參考 Kai 的 extract.mjs）
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

// 統一入口（OpenRouter 回傳 LLMResult；其他 provider 暫時包裝成同格式）
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

// ── Fallback：關鍵字規則（無金鑰或 LLM 全掛時用） ───────────────────────────
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

// ── 組裝送給 LLM 的 user message（附上非 IG URL 上下文） ─────────────────────
function buildUserMessage(text: string, nonIgUrls?: string[]): string {
  if (nonIgUrls && nonIgUrls.length > 0) {
    return `${text}\n[使用者附上非 IG 連結：${nonIgUrls.join(", ")}]`;
  }
  return text;
}

// ── 對外主函式 ────────────────────────────────────────────────────────────────
export async function generateChatReply(
  userId: string | null,
  text: string,
  nonIgUrls?: string[]
): Promise<string> {
  // 自動偵測 provider：優先用明確設定，其次看哪個 API key 有值
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

  // ── rules 模式 ──────────────────────────────────────────────────────────────
  if (provider === "rules") {
    const reply = chatWithRules(text);
    if (debug) {
      return `[DEBUG] provider=rules\n────────────\n${reply}`;
    }
    return reply;
  }

  // ── LLM 模式 ────────────────────────────────────────────────────────────────
  const userMessage = buildUserMessage(text, nonIgUrls);
  console.log(`[chat] 送出分析，provider=${provider} model=${model}`);
  console.log(`[chat] userMessage: ${userMessage.slice(0, 200)}`);

  const { content: result, reason } = await callLLM(provider, CLASSIFIER_SYSTEM_PROMPT, userMessage, 700);

  if (!result) {
    console.warn(`[chat] LLM 無回應（${reason}），降級到 rules`);
    const fallback = chatWithRules(text);
    if (debug) {
      return `[DEBUG] provider=${provider} model=${model}\n[ERROR] ${reason}\n────────────\n${fallback}`;
    }
    return fallback;
  }

  console.log(`[chat] LLM 分類結果: ${result.slice(0, 300)}`);

  if (debug) {
    return `[DEBUG] provider=${provider}\nmodel=${model}\n────────────\n${result}`;
  }
  return result;
}
