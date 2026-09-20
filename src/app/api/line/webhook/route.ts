import crypto from "node:crypto";
import { NextResponse, after } from "next/server";
import { extractIgLinks } from "@/lib/ig";
import { extractAnyUrls } from "@/lib/url";
import { requestIngest } from "@/lib/pipeline";
import { createFailedJob } from "@/lib/jobs";
import { generateChatReply, endFashionSession, updateUserPreferenceFile } from "@/lib/chat";

// LINE Messaging API webhook 接收端。
// LINE 平台會把使用者傳給官方帳號的訊息 POST 到這個網址。
//
// 路由邏輯（三路）：
//   1. 含 IG 連結  → 回覆「正在分析」，背景送進分析 pipeline（after()）
//                    並結束目前的穿搭 session（換話題了）
//   2. 含其他 URL  → 交給 LLM，附上「偵測到非 IG 連結」的上下文
//   3. 純文字      → 交給 LLM 做穿搭對話
//
// ★ 即時回饋架構（避免 LINE 5 秒 timeout）：
//   路徑 2/3 現在改為：
//     a. 立刻 replyText「⏳ 收到！」（< 1 秒）→ 確保 200 回傳給 LINE
//     b. after() 背景跑完整流程（Hobby plan 最多 15 秒）
//     c. 每個 phase 完成後用 pushMessage 即時推送進度給使用者
//     d. 最後推送實際推薦結果
//
// 路徑 1 是「兩層非同步」：
//   LINE 秒收到回覆 → Next.js 背景送件 → Python 背景分析
// 因為整條 pipeline（Apify + 每張圖一次 Claude Vision + 每件衣服一次 BGE-M3）
// 要跑幾十秒到幾分鐘。使用者在網頁上看到的進度來自 ingest_jobs 表（GET /api/jobs）。
//
// 為什麼用 Push API 而不是 Reply API：
//   replyToken 只能用一次、有效期約 30 秒，且在 after() 裡通常已過期。
//   Push API 使用 userId，可以任何時候傳訊息，適合異步推送進度。
//   注意：Push API 在 LINE 免費方案有月用量限制（每月 500 則）。

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

// Reply API：用 replyToken，只能用一次，第一則「已收到」用這個
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

// Push API：用 userId，可以任何時候傳，用於背景進度推送
// 注意：LINE 免費方案每月 500 則，使用時請注意用量
async function pushMessage(userId: string, text: string): Promise<void> {
  const token = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  if (!token) {
    console.error("[webhook] 沒有 LINE_CHANNEL_ACCESS_TOKEN，無法 push");
    return;
  }
  try {
    const res = await fetch("https://api.line.me/v2/bot/message/push", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        to: userId,
        messages: [{ type: "text", text }],
      }),
    });
    if (!res.ok) {
      console.error(
        `[webhook] LINE push 失敗 HTTP ${res.status}:`,
        await res.text()
      );
    } else {
      console.log(`[webhook] push 成功 userId=${userId.slice(0, 8)}...`);
    }
  } catch (e) {
    console.error("[webhook] LINE push failed:", e);
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
    const userId = event.source?.userId ?? null;
    console.log(`[webhook] 文字訊息: ${text.slice(0, 120)}`);

    // ── 路由判斷 ─────────────────────────────────────────────────
    const igLinks = extractIgLinks(text);
    const allUrls = extractAnyUrls(text);
    const nonIgUrls = allUrls.filter((u) => !u.includes("instagram.com"));

    console.log(
      `[webhook] IG 連結 ${igLinks.length} 個、非 IG URL ${nonIgUrls.length} 個`
    );

    // ── 路徑 1：有 IG 連結 → 收藏 + 分析流程 ─────────────────────
    if (igLinks.length > 0) {
      const senderId = userId;
      const senderName = senderId ? await getSenderName(senderId) : null;

      // 傳連結視為換一個話題：結束目前的穿搭 session，下一則文字會重新開始。
      if (userId) endFashionSession(userId);

      // 先回覆，再送件。LINE 的 replyToken 只有幾秒可以用，
      // 而 requestIngest 要跨行程打 FastAPI，不能擋在回覆前面。
      if (event.replyToken) {
        await replyText(
          event.replyToken,
          `收到！正在分析 ${igLinks.length} 則貼文的穿搭，完成後就會出現在收藏夾 ✅`
        );
      }

      after(async () => {
        for (const link of igLinks) {
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

      continue;
    }

    // ── 特殊指令：使用者傳「結束這次討論」→ 結束 session ──────────
    // session 只在此處結束；LLM 不會自動切換 session。
    if (text.trim() === "結束這次討論") {
      if (userId) {
        endFashionSession(userId);
        if (event.replyToken) {
          await replyText(
            event.replyToken,
            "已更新使用者偏好並開啟新的對話 ✅\n下次傳訊息時將自動開啟新對話。"
          );
        }
        // 偏好更新交給背景（LLM call 較慢）
        const capturedUid = userId;
        after(async () => {
          const p = process.env.CHAT_PROVIDER ||
            (process.env.OPENROUTER_API_KEY ? "openrouter" :
             process.env.ANTHROPIC_API_KEY  ? "anthropic"  :
             process.env.OPENAI_API_KEY     ? "openai"     : "rules");
          await updateUserPreferenceFile(capturedUid, p);
          await pushMessage(capturedUid, "偏好已更新 💾");
        });
      }
      continue;
    }

    // ── 路徑 2 & 3：非 IG URL 或純文字 → LLM 穿搭對話 ──────────
    //
    // ★ 新架構：立刻回覆「收到」，背景用 Push API 推送每一步進度
    //
    // Step 1：在 LINE 5 秒 timeout 前送出第一則「已收到」
    if (event.replyToken) {
      await replyText(event.replyToken, "⏳ 收到！正在幫你分析穿搭，請稍候...");
    }

    // Step 2：after() 背景處理（Hobby plan 最多 15 秒）
    // 用 const 捕捉迴圈變數，避免 closure 問題
    const capturedUserId = userId;
    const capturedText = text;
    const capturedNonIgUrls = nonIgUrls;

    after(async () => {
      const debug = process.env.CHAT_DEBUG === "true";

      try {
        // onProgress：每個 phase 完成後立刻 push 一則訊息給使用者
        // 若沒有 userId（不應發生），靜默略過 push
        const onProgress = capturedUserId
          ? async (msg: string) => {
              await pushMessage(capturedUserId, msg);
            }
          : undefined;

        // 執行完整穿搭流程
        const answer = await generateChatReply(capturedUserId, capturedText, {
          nonIgUrls: capturedNonIgUrls.length > 0 ? capturedNonIgUrls : undefined,
          onProgress,
        });

        // 推送最終推薦結果
        if (capturedUserId) {
          await pushMessage(capturedUserId, answer);
        }

      } catch (e) {
        console.error("[webhook] 背景處理失敗:", e);
        // 推送錯誤通知（debug 模式顯示詳情）
        if (capturedUserId) {
          const errMsg = debug
            ? `❌ 處理時發生錯誤：\n${String(e).slice(0, 400)}`
            : "很抱歉，處理時發生問題，請稍後再試 🙏";
          await pushMessage(capturedUserId, errMsg);
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
