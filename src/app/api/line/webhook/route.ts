import crypto from "node:crypto";
import { NextResponse, after } from "next/server";
import { extractIgLinks } from "@/lib/ig";
import { requestIngest } from "@/lib/pipeline";
import { createFailedJob } from "@/lib/jobs";
import { generateChatReply } from "@/lib/chat";

// LINE Messaging API webhook 接收端。
// LINE 平台會把使用者傳給官方帳號的訊息 POST 到這個網址。
//
// 流程：驗證簽章 → 解析事件 → 抓出 IG 連結 → 回覆使用者
//       → 回應送出「之後」才把連結送進分析 pipeline（after()）。
//
// pipeline 那端（./pipeline 的 FastAPI）也是立刻回 job id 就結束，
// Apify → Claude Vision → BGE-M3 → 寫 RDS 全部在它自己的背景跑。
// 所以這裡是「兩層非同步」：
//   LINE 秒收到回覆 → Next.js 背景送件 → Python 背景分析
// 使用者在網頁上看到的進度來自 ingest_jobs 表（GET /api/jobs）。

export const dynamic = "force-dynamic";

type LineTextMessageEvent = {
  type: string;
  replyToken?: string;
  source?: { type: string; userId?: string };
  message?: { type: string; text?: string };
};

function verifySignature(rawBody: string, signature: string | null): boolean {
  const secret = process.env.LINE_CHANNEL_SECRET;
  if (!secret || !signature) return false;
  const hmac = crypto
    .createHmac("sha256", secret)
    .update(rawBody)
    .digest("base64");
  try {
    return crypto.timingSafeEqual(Buffer.from(hmac), Buffer.from(signature));
  } catch {
    return false;
  }
}

async function getSenderName(userId: string): Promise<string | null> {
  const token = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  if (!token) return null;
  try {
    const res = await fetch(`https://api.line.me/v2/bot/profile/${userId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return null;
    const profile = (await res.json()) as { displayName?: string };
    return profile.displayName ?? null;
  } catch {
    return null;
  }
}

async function replyText(replyToken: string, text: string): Promise<void> {
  const token = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  if (!token) {
    console.error("[webhook] 沒有 LINE_CHANNEL_ACCESS_TOKEN，無法回覆");
    return;
  }
  try {
    const res = await fetch("https://api.line.me/v2/bot/message/reply", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        replyToken,
        messages: [{ type: "text", text }],
      }),
    });
    if (!res.ok) {
      // token 錯誤/過期、replyToken 用過或逾時，都會在這裡看到原因
      console.error(
        `[webhook] LINE 回覆失敗 HTTP ${res.status}:`,
        await res.text()
      );
    } else {
      console.log("[webhook] 已回覆使用者 ✅");
    }
  } catch (e) {
    console.error("[webhook] LINE reply failed:", e);
  }
}

export async function POST(req: Request) {
  // 一定要用「原始字串」驗簽章，先 json() 再 stringify 會驗不過
  const rawBody = await req.text();
  const signature = req.headers.get("x-line-signature");

  if (!verifySignature(rawBody, signature)) {
    console.error(
      "[webhook] 簽章驗證失敗（LINE_CHANNEL_SECRET 不對，或請求不是來自 LINE）"
    );
    return NextResponse.json({ error: "invalid signature" }, { status: 401 });
  }

  const body = JSON.parse(rawBody) as { events?: LineTextMessageEvent[] };
  const events = body.events ?? [];
  console.log(
    `[webhook] 收到 ${events.length} 個事件:`,
    events.map((e) => `${e.type}/${e.message?.type ?? "-"}`).join(", ") || "(空)"
  );

  for (const event of events) {
    if (event.type !== "message" || event.message?.type !== "text") continue;

    const text = event.message.text ?? "";
    console.log(`[webhook] 文字訊息: ${text.slice(0, 120)}`);
    const links = extractIgLinks(text);
    console.log(`[webhook] 解析出 ${links.length} 個 IG 連結`);

    if (links.length === 0) {
      // 不是 IG 連結 → 走對話引擎（src/lib/chat.ts，由 CHAT_PROVIDER 決定用哪家 LLM）
      if (event.replyToken) {
        const answer = await generateChatReply(event.source?.userId ?? null, text);
        await replyText(event.replyToken, answer);
      }
      continue;
    }

    const senderId = event.source?.userId ?? null;
    const senderName = senderId ? await getSenderName(senderId) : null;

    // 先回覆，再送件。LINE 的 replyToken 只有幾秒可以用，
    // 而 requestIngest 要跨機器打 FastAPI，不能擋在回覆前面。
    if (event.replyToken) {
      await replyText(
        event.replyToken,
        `收到！正在分析 ${links.length} 則貼文的穿搭，完成後就會出現在收藏夾 ✅`
      );
    }

    after(async () => {
      for (const link of links) {
        try {
          const ticket = await requestIngest(link.url, {
            sourceText: text,
            senderId,
            senderName,
          });
          console.log(
            `[webhook] ${link.shortcode} 已送進 pipeline（job ${ticket.jobId}）`
          );
        } catch (e) {
          console.error(`[webhook] ${link.shortcode} 送件失敗:`, e);

          // 送不出去也要留下痕跡，不然前端完全不知道發生什麼事
          await createFailedJob(link.url, String(e), {
            shortcode: link.shortcode,
            sourceText: text,
            senderId,
            senderName,
          });
        }
      }
    });
  }

  // LINE 只要求回 200，內容不重要；出錯也盡量回 200 避免 LINE 重送轟炸
  return NextResponse.json({ ok: true });
}

// 方便你在瀏覽器打開這個網址確認路由活著（LINE 的 verify 用的是 POST）
export async function GET() {
  return NextResponse.json({ ok: true, hint: "LINE webhook endpoint (POST)" });
}
