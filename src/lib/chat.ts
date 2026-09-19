// 打字對話的核心模組。
// webhook 收到「不是 IG 連結」的文字時會呼叫 generateChatReply()，
// 由 CHAT_PROVIDER 環境變數決定用哪個引擎：
//   - "openrouter" : OpenRouter API（需 OPENROUTER_API_KEY，用 CHAT_MODEL 指定模型）
//   - "anthropic"  : Claude API（需 ANTHROPIC_API_KEY）
//   - "openai"     : OpenAI API（需 OPENAI_API_KEY）
//   - "rules"      : 純關鍵字規則（不用金鑰，保底 fallback）
//
// OpenRouter 推薦模型範例（設在 CHAT_MODEL）：
//   nvidia/nemotron-3-ultra-550b-a55b:free ← 預設，免費
//   google/gemini-flash-1.5
//   anthropic/claude-haiku-4-5
//   openai/gpt-4o-mini
//   meta-llama/llama-3.1-8b-instruct
//
// 核心流程（LLM 模式）：
//   Step 1: analyzeIntent()     — 用 LLM 分析使用者語意，抽出場合/風格/預算/隱含條件
//   Step 2: enrichUserMessage() — 把分析結果附在原始訊息後面
//   Step 3: 帶著 enriched message + 對話歷史，呼叫主 LLM 產生回覆

// ── Prompt：語意分析（Step 1 專用，輕量，只抽資訊不回覆） ──────────────────
const ANALYSIS_SYSTEM_PROMPT = `你是穿搭需求分析器，只負責從使用者的訊息中抽取穿搭相關資訊。

輸出格式（一行繁體中文，只列出能確定的項目）：
[意圖] 場合=X｜風格=X｜預算=X｜性別=X｜隱含=X

意圖選項：找整套穿搭／找單品／有某件找剩餘搭配／詢問使用方式／閒聊
- 若是閒聊或問候，只輸出「[閒聊]」
- 若是詢問使用方式，只輸出「[使用說明]」
- 隱含條件從場合推斷（例：婚禮→不能搶新娘風采、上班→不能太暴露）
- 無法確定的項目直接省略，不要填「未知」`;

// ── Prompt：主對話（Step 3，穿搭顧問角色） ──────────────────────────────────
const STYLIST_SYSTEM_PROMPT = `你是 WowStylist 的時尚穿搭助手，說繁體中文，語氣親切自然（回覆不超過 4 句）。

## 你的職責
1. **穿搭建議**：根據使用者描述的場合、風格、預算，給出具體建議。
   訊息後方的「[需求分析：...]」是系統幫你整理好的結構化資訊，請善用它來給更精準的建議。
2. **風格分析**：使用者傳來非 IG 連結時，引導他說出喜歡的風格或元素。
3. **收藏說明**：使用者問怎麼收藏時，告訴他傳 IG 連結就會自動收藏。

## 回覆原則
- 穿搭建議要具體：至少說清楚上衣和下半身，有餘裕再加外套和鞋
- 最多問一個最關鍵的追問（場合？預算？性別？），不要連問
- 不確定的事老實說，不要編造
- 收到非 IG 連結時：告訴使用者目前只能收藏 IG 連結，請他描述喜歡那個連結的哪個部分`;

// ── 對話記憶 ─────────────────────────────────────────────────────────────────
type ChatTurn = { role: "user" | "assistant"; content: string };
const histories = new Map<string, ChatTurn[]>();
const MAX_TURNS = 10;

function remember(userId: string, turn: ChatTurn) {
  const h = histories.get(userId) ?? [];
  h.push(turn);
  while (h.length > MAX_TURNS) h.shift();
  histories.set(userId, h);
}

// ── LLM 呼叫：OpenRouter（OpenAI 相容格式） ──────────────────────────────────
async function callOpenRouter(
  systemPrompt: string,
  messages: ChatTurn[],
  maxTokens = 500
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
        messages: [{ role: "system", content: systemPrompt }, ...messages],
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
  messages: ChatTurn[],
  maxTokens = 500
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
        messages,
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
  messages: ChatTurn[],
  maxTokens = 500
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
        messages: [{ role: "system", content: systemPrompt }, ...messages],
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

// 統一入口：根據 provider 決定呼叫哪家
async function callLLM(
  provider: string,
  systemPrompt: string,
  messages: ChatTurn[],
  maxTokens = 500
): Promise<string | null> {
  if (provider === "openrouter") return callOpenRouter(systemPrompt, messages, maxTokens);
  if (provider === "anthropic") return callAnthropic(systemPrompt, messages, maxTokens);
  if (provider === "openai") return callOpenAI(systemPrompt, messages, maxTokens);
  return null;
}

// ── Step 1：語意分析 ──────────────────────────────────────────────────────────
async function analyzeIntent(
  provider: string,
  text: string
): Promise<string | null> {
  const result = await callLLM(
    provider,
    ANALYSIS_SYSTEM_PROMPT,
    [{ role: "user", content: text }],
    120 // 分析只需要短輸出
  );
  if (result) {
    console.log(`[chat] 語意分析結果: ${result}`);
  }
  return result;
}

// ── Step 2：把分析結果附到使用者訊息後方 ────────────────────────────────────
function enrichUserMessage(originalText: string, analysis: string | null, nonIgUrls?: string[]): string {
  const parts: string[] = [originalText];

  if (analysis && analysis !== "[閒聊]" && analysis !== "[使用說明]") {
    parts.push(`\n[需求分析：${analysis.replace(/^\[.*?\]\s*/, "")}]`);
  }

  if (nonIgUrls && nonIgUrls.length > 0) {
    parts.push(`\n[使用者附上非 IG 連結：${nonIgUrls.join(", ")}]`);
  }

  return parts.join("");
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

// ── 對外主函式 ────────────────────────────────────────────────────────────────
export async function generateChatReply(
  userId: string | null,
  text: string,
  nonIgUrls?: string[]
): Promise<string> {
  const provider = (process.env.CHAT_PROVIDER || "rules").toLowerCase();
  const uid = userId ?? "anonymous";

  // rules 模式：直接走關鍵字，不呼叫任何 LLM
  if (provider === "rules") {
    return chatWithRules(text);
  }

  // ── Step 1：語意分析 ─────────────────────────────────────────────────────
  const analysis = await analyzeIntent(provider, text);

  // ── Step 2：組裝 enriched 訊息 ──────────────────────────────────────────
  const enrichedText = enrichUserMessage(text, analysis, nonIgUrls);
  console.log(`[chat] Enriched message: ${enrichedText.slice(0, 200)}`);

  // ── Step 3：存進記憶，呼叫主 LLM ────────────────────────────────────────
  remember(uid, { role: "user", content: enrichedText });
  const history = histories.get(uid) ?? [{ role: "user" as const, content: enrichedText }];

  const answer = await callLLM(provider, STYLIST_SYSTEM_PROMPT, history, 500);

  if (!answer) {
    console.warn("[chat] LLM 無回應，降級到 rules");
    return chatWithRules(text);
  }

  remember(uid, { role: "assistant", content: answer });
  return answer;
}
