// 打字對話的核心模組。
// webhook 收到「不是 IG 連結」的文字時會呼叫 generateChatReply()，
// 由 CHAT_PROVIDER 環境變數決定用哪個引擎：
//   - "anthropic" : Claude API（需 ANTHROPIC_API_KEY）
//   - "openai"    : OpenAI API（需 OPENAI_API_KEY）
//   - "rules"     : 純關鍵字規則（不用金鑰，預設值）
// 之後要換模型只要改 .env，不用動程式。

const SYSTEM_PROMPT = `你是 WowStylist 的 LINE 小助手，說繁體中文，語氣親切簡短（不超過 3 句）。
這個服務讓使用者把喜歡的 Instagram 貼文/Reels 分享進來收藏，並在網頁上瀏覽。
如果使用者問怎麼使用，告訴他們：直接把 IG 貼文或 Reels 的連結傳過來就會自動收藏。
不確定的事就老實說不知道，不要編造。`;

// 每個使用者的短期對話記憶（存在記憶體，重啟就清空；MVP 夠用，之後可搬進 DB）
type ChatTurn = { role: "user" | "assistant"; content: string };
const histories = new Map<string, ChatTurn[]>();
const MAX_TURNS = 10;

function remember(userId: string, turn: ChatTurn) {
  const h = histories.get(userId) ?? [];
  h.push(turn);
  while (h.length > MAX_TURNS) h.shift();
  histories.set(userId, h);
}

// ---------- 各家 provider ----------

async function chatWithAnthropic(history: ChatTurn[]): Promise<string | null> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error("[chat] CHAT_PROVIDER=anthropic 但沒設 ANTHROPIC_API_KEY");
    return null;
  }
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
        max_tokens: 500,
        system: SYSTEM_PROMPT,
        messages: history,
      }),
    });
    if (!res.ok) {
      console.error(`[chat] Anthropic API 失敗 HTTP ${res.status}:`, await res.text());
      return null;
    }
    const data = (await res.json()) as { content?: { type: string; text?: string }[] };
    return data.content?.find((c) => c.type === "text")?.text ?? null;
  } catch (e) {
    console.error("[chat] Anthropic API 錯誤:", e);
    return null;
  }
}

async function chatWithOpenAI(history: ChatTurn[]): Promise<string | null> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    console.error("[chat] CHAT_PROVIDER=openai 但沒設 OPENAI_API_KEY");
    return null;
  }
  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: process.env.CHAT_MODEL || "gpt-4o-mini",
        max_tokens: 500,
        messages: [{ role: "system", content: SYSTEM_PROMPT }, ...history],
      }),
    });
    if (!res.ok) {
      console.error(`[chat] OpenAI API 失敗 HTTP ${res.status}:`, await res.text());
      return null;
    }
    const data = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    return data.choices?.[0]?.message?.content ?? null;
  } catch (e) {
    console.error("[chat] OpenAI API 錯誤:", e);
    return null;
  }
}

// 關鍵字規則：不用金鑰的保底方案（也是 LLM 掛掉時的 fallback 素材）
function chatWithRules(text: string): string {
  const t = text.trim();
  if (/怎麼用|怎么用|幫助|help|說明/i.test(t)) {
    return "使用方式很簡單：在 Instagram 看到喜歡的貼文或 Reels，按「分享 → 複製連結」，把連結貼到這裡傳給我，我就會幫你收藏！收藏的內容可以在我們的網頁上瀏覽 ✨";
  }
  if (/你好|嗨|哈囉|hi|hello/i.test(t)) {
    return "嗨嗨！把你喜歡的 IG 貼文連結傳給我，我會幫你收藏起來 ✨ 打「怎麼用」可以看使用說明。";
  }
  return "我是收藏小幫手！傳 IG 貼文/Reels 連結給我就會自動收藏。打「怎麼用」看說明 ✨";
}

// ---------- 對外的主函式 ----------

export async function generateChatReply(
  userId: string | null,
  text: string
): Promise<string> {
  const provider = (process.env.CHAT_PROVIDER || "rules").toLowerCase();
  const uid = userId ?? "anonymous";

  if (provider === "rules") {
    return chatWithRules(text);
  }

  remember(uid, { role: "user", content: text });
  const history = histories.get(uid) ?? [{ role: "user" as const, content: text }];

  const answer =
    provider === "anthropic"
      ? await chatWithAnthropic(history)
      : provider === "openai"
        ? await chatWithOpenAI(history)
        : null;

  if (!answer) {
    // LLM 掛了或沒設金鑰 → 降級成規則回覆，至少不已讀不回
    return chatWithRules(text);
  }

  remember(uid, { role: "assistant", content: answer });
  return answer;
}
