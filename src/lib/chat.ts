// 打字對話的核心模組。
// webhook 收到「不是 IG 連結」的文字時會呼叫 generateChatReply()，
// 由 CHAT_PROVIDER 環境變數決定用哪個引擎：
//   - "anthropic" : Claude API（需 ANTHROPIC_API_KEY）
//   - "openai"    : OpenAI API（需 OPENAI_API_KEY）
//   - "rules"     : 純關鍵字規則（不用金鑰，預設值）
// 之後要換模型只要改 .env，不用動程式。

const SYSTEM_PROMPT = `你是 WowStylist 的時尚穿搭助手，說繁體中文，語氣親切自然（回覆不超過 4 句）。

## 你的職責
1. **收藏 IG 穿搭**：使用者傳 Instagram 連結過來，你會自動收藏並分析風格。
2. **穿搭建議**：根據使用者描述的場合、風格、預算，給出具體的穿搭建議。
3. **風格分析**：當使用者傳來非 IG 的時尚連結或描述穿搭，幫他分析風格標籤（風格/色系/形容詞）。

## 回覆原則
- 穿搭建議要具體（上衣、下半身、外套、鞋子都說清楚）
- 可以問一個最關鍵的追問（場合？預算？性別？），但不要一次問多個問題
- 不確定的事老實說，不要編造
- 如果使用者給的是非 IG 的時尚連結，告訴他「我注意到你貼了一個連結，但我目前只能收藏 Instagram 的連結。你可以告訴我那個連結是什麼風格或你喜歡哪個部分嗎？」

## 使用方式說明
- 收藏 IG 貼文：把 Instagram 連結直接傳過來
- 穿搭建議：用自然語言描述，例如「幫我找一套適合秋天約會的穿搭，預算 2000 以內」
- 查看收藏：打「收藏夾」或到網頁看`;

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

// ---------- 對外的主函式 ----------

export async function generateChatReply(
  userId: string | null,
  text: string,
  nonIgUrls?: string[]
): Promise<string> {
  const provider = (process.env.CHAT_PROVIDER || "rules").toLowerCase();
  const uid = userId ?? "anonymous";

  // 若有非 IG URL，在 user 訊息前面加上提示，讓 LLM 理解上下文
  const enrichedText =
    nonIgUrls && nonIgUrls.length > 0
      ? `[使用者傳來了非 IG 的連結：${nonIgUrls.join(", ")}]\n${text}`
      : text;

  if (provider === "rules") {
    return chatWithRules(text);
  }

  remember(uid, { role: "user", content: enrichedText });
  const history = histories.get(uid) ?? [{ role: "user" as const, content: enrichedText }];

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
