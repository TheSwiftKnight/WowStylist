import crypto from "node:crypto";
import { NextResponse, after } from "next/server";
import { extractIgLinks } from "@/lib/ig";
import { extractAnyUrls } from "@/lib/url";
import { saveLinkBasic, enrichLink } from "@/lib/ingest";
import { generateChatReply } from "@/lib/chat";

// LINE Messaging API webhook 接收端。
// LINE 平台會把使用者傳給官方帳號的訊息 POST 到這個網址。
//
// 路由邏輯（三路）：
//   1. 含 IG 連結  → 存 DB，回覆「已收藏」，背景補抓 IG 內容（after()）
//   2. 含其他 URL  → 交給 LLM，附上「偵測到非 IG 連結」的上下文
//   3. 純文字      → 交給 LLM 做穿搭對話
//
// 為什麼用 after()：抓 IG 一個連結要兩次 HTTP 往返，放在回應之前會把
// function 的執行時間拉長，LINE 等不到 200 會重送，serverless 上也容易吃到
// 逾時上限。after() 讓我們先把 200 丟回去，剩下的在背景跑完。

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

    // ── 路由判斷 ─────────────────────────────────────────────────
    const igLinks = extractIgLinks(text);
    const allUrls = extractAnyUrls(text);
    // 非 IG 的 URL（排除已被 IG 正規化處理的）
    const nonIgUrls = allUrls.filter((u) => !u.includes("instagram.com"));

    console.log(
      `[webhook] IG 連結 ${igLinks.length} 個、非 IG URL ${nonIgUrls.length} 個`
    );

    // ── 路徑 1：有 IG 連結 → 收藏流程 ───────────────────────────
    if (igLinks.length > 0) {
      const senderId = event.source?.userId ?? null;
      const senderName = senderId ? await getSenderName(senderId) : null;

      const savedRows = [];
      for (const link of igLinks) {
        savedRows.push(
          await saveLinkBasic(link, { sourceText: text, senderId, senderName })
        );
      }
      console.log(`[webhook] 已存入 ${savedRows.length} 筆`);

      if (event.replyToken) {
        await replyText(
          event.replyToken,
          `收到！已收藏 ${savedRows.length} 個 IG 連結 ✅`
        );
      }

      // 回應送出之後才抓 IG 內容
      const pending = savedRows.filter((row) => row.fetchStatus !== "ok");
      if (pending.length > 0) {
        after(async () => {
          for (const row of pending) {
            try {
              await enrichLink(row);
            } catch (e) {
              console.error(`[webhook] 抓取 ${row.shortcode} 內容時出錯:`, e);
            }
          }
          console.log(`[webhook] 背景補抓完成 ${pending.length} 筆`);
        });
      }
      continue;
    }

    // ── 路徑 2 & 3：非 IG URL 或純文字 → LLM 對話 ──────────────
    // nonIgUrls 若有值，chat.ts 會把連結帶進 prompt 讓 LLM 知道上下文
    if (event.replyToken) {
      const answer = await generateChatReply(
        event.source?.userId ?? null,
        text,
        nonIgUrls.length > 0 ? nonIgUrls : undefined
      );
      await replyText(event.replyToken, answer);
    }
  }

  // LINE 只要求回 200，內容不重要；出錯也盡量回 200 避免 LINE 重送轟炸
  return NextResponse.json({ ok: true });
}

// 方便你在瀏覽器打開這個網址確認路由活著（LINE 的 verify 用的是 POST）
export async function GET() {
  return NextResponse.json({ ok: true, hint: "LINE webhook endpoint (POST)" });
}
