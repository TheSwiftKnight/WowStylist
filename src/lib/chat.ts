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

## 意圖類型定義
- A：找「一件特定單品」——使用者給出條件（顏色、材質、款式等），想找某類型的單品，不涉及搭配
- B：「已有一件指定衣物」——使用者描述手邊某件衣物，想找其他可以和它搭配的衣物
- C：針對「場合或情境」——使用者描述要去哪裡或做什麼，想找完整一套穿搭，沒有指定任何特定衣物
- 其他：閒聊、問候、詢問使用方式

## 價格處理
若輸入中有價格相關描述（預算、元、NT$、以內、便宜、高價位等），
→ 抽取為獨立的 [價格] 標籤
→ 並從主要描述中移除這段文字

## 輸出規則（嚴格遵守以下格式，不要輸出任何說明文字）

### 其他（閒聊 / 問候 / 使用說明）
直接輸出使用者原始訊息，不添加任何標籤。

### A（找單品）
直接輸出使用者原始訊息，不添加任何標籤。

### B（有指定衣物，找搭配）
{使用者原始訊息（移除價格相關文字）}
[已知單品: {已知衣物的詳細描述，包含顏色、款式、材質等特徵}]
[搭配關鍵字: {5~10個名詞或形容詞，空格分隔，例如：深藍 修身 正式 西裝 商務 俐落}]
[價格: {若有；否則省略此行}]

### C（找完整穿搭）
{使用者原始訊息（移除價格相關文字）}
[限制條件: {所有限制條件，逗號分隔，例如：婚禮, 正式, 不搶新娘風采, 淡色系}]
[價格: {若有；否則省略此行}]`;

// ── LLM 呼叫：OpenRouter ─────────────────────────────────────────────────────
async function callOpenRouter(
  systemPrompt: string,
  userMessage: string,
  maxTokens = 400
): Promise<string | null> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    console.error("[chat] CHAT_PROVIDER=openrouter 但沒設 OPENROUTER_API_KEY");
    return null;
  }
  try {
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
        "HTTP-Referer": process.env.SITE_URL ?? "https://wowstylist.app",
        "X-Title": "WowStylist",
      },
      body: JSON.stringify({
        model: process.env.CHAT_MODEL || "nvidia/nemotron-3-ultra-550b-a55b:free",
        max_tokens: maxTokens,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userMessage },
        ],
      }),
    });
    if (!res.ok) {
      console.error(`[chat] OpenRouter HTTP ${res.status}:`, await res.text());
      return null;
    }
    const data = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    return data.choices?.[0]?.message?.content ?? null;
  } catch (e) {
    console.error("[chat] OpenRouter 錯誤:", e);
    return null;
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
): Promise<string | null> {
  if (provider === "openrouter") return callOpenRouter(systemPrompt, userMessage, maxTokens);
  if (provider === "anthropic") return callAnthropic(systemPrompt, userMessage, maxTokens);
  if (provider === "openai") return callOpenAI(systemPrompt, userMessage, maxTokens);
  return null;
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
  // const debug = process.env.CHAT_DEBUG === "TRUE";
  const debug = (1===1);

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

  const result = await callLLM(provider, CLASSIFIER_SYSTEM_PROMPT, userMessage, 400);

  if (!result) {
    console.warn("[chat] LLM 無回應，降級到 rules");
    const fallback = chatWithRules(text);
    if (debug) {
      return `[DEBUG] provider=${provider} model=${model}\n[ERROR] LLM 無回應，已降級\n────────────\n${fallback}`;
    }
    return fallback;
  }

  console.log(`[chat] LLM 分類結果: ${result.slice(0, 300)}`);

  if (debug) {
    return `[DEBUG] provider=${provider}\nmodel=${model}\n────────────\n${result}`;
  }
  return result;
}
