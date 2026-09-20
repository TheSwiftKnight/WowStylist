import crypto from "node:crypto";
import { NextResponse, after } from "next/server";
import { extractIgLinks } from "@/lib/ig";
import { extractAnyUrls } from "@/lib/url";
import { requestIngest, warmUp } from "@/lib/pipeline";
import { createFailedJob } from "@/lib/jobs";
import { generateChatReply, endFashionSession, updateUserPreferenceFile, writeOutfitAdvice } from "@/lib/chat";
import { buildOutfitCarousel, siteUrl } from "@/lib/flex";
import { likeProduct } from "@/lib/likes";

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

// 免費方案的分析服務冷啟動要一分鐘左右，送件會在 after() 裡等那麼久。
// Vercel 預設的 function 上限比這短，所以放寬。
export const maxDuration = 60;

type LineEvent = {
  type: string;
  replyToken?: string;
  source?: { type: string; userId?: string };
  message?: { type: string; text?: string };
  /** 使用者按下 Flex 卡片上的按鈕時會帶這個 */
  postback?: { data?: string };
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

// Reply API：用 replyToken，只能用一次，但**免費且不限量**。
// Push API 在 LINE 免費方案有每月上限（用完之後 push 會直接失敗），
// 所以主要的回覆一律走 Reply，Push 只當 replyToken 失效時的備援。
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function replyRaw(replyToken: string, messages: any[]): Promise<boolean> {
  const token = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  if (!token) {
    console.error("[webhook] 沒有 LINE_CHANNEL_ACCESS_TOKEN，無法回覆");
    return false;
  }
  try {
    const res = await fetch("https://api.line.me/v2/bot/message/reply", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ replyToken, messages }),
    });
    if (!res.ok) {
      // token 錯誤/過期、replyToken 用過或逾時，都會在這裡看到原因
      console.error(`[webhook] LINE reply 失敗 HTTP ${res.status}:`, await res.text());
      return false;
    }
    console.log(`[webhook] 已回覆使用者 ✅（${messages.length} 則）`);
    return true;
  } catch (e) {
    console.error("[webhook] LINE reply failed:", e);
    return false;
  }
}

async function replyText(replyToken: string, text: string): Promise<void> {
  await replyRaw(replyToken, [{ type: "text", text }]);
}

/**
 * 顯示「輸入中」動畫。
 * 不佔 push 配額、也不會用掉 replyToken，適合拿來取代「⏳ 收到」那則訊息。
 * 只在一對一聊天有效；失敗了也無所謂。
 */
async function startLoading(userId: string, seconds = 60): Promise<void> {
  const token = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  if (!token) return;
  try {
    const res = await fetch("https://api.line.me/v2/bot/chat/loading/start", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      // loadingSeconds 必須是 5 的倍數，最多 60
      body: JSON.stringify({ chatId: userId, loadingSeconds: Math.min(60, Math.round(seconds / 5) * 5) }),
    });
    if (!res.ok) {
      console.warn(`[webhook] loading 動畫失敗 HTTP ${res.status}:`, (await res.text()).slice(0, 200));
    }
  } catch (e) {
    console.warn("[webhook] loading 動畫失敗:", e);
  }
}

// Push API：用 userId，可以任何時候傳。
// ⚠️ LINE 免費方案每月有推播則數上限（依方案與地區而定，到官方帳號管理後台看），
// 而且使用者端完全沒有任何提示 —— 「只收到第一則、後面都沒了」通常就是這個原因。
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function pushRaw(userId: string, messages: any[]): Promise<boolean> {
  const token = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  if (!token) {
    console.error("[webhook] 沒有 LINE_CHANNEL_ACCESS_TOKEN，無法 push");
    return false;
  }
  try {
    const res = await fetch("https://api.line.me/v2/bot/message/push", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ to: userId, messages }),
    });
    if (!res.ok) {
      const body = await res.text();
      console.error(
        `[webhook] LINE push 失敗 HTTP ${res.status}: ${body.slice(0, 300)}` +
        (res.status === 429 ? "　← 很可能是每月 push 配額用完了" : "")
      );
      return false;
    }
    console.log(`[webhook] push 成功 userId=${userId.slice(0, 8)}...（${messages.length} 則）`);
    return true;
  } catch (e) {
    console.error("[webhook] LINE push failed:", e);
    return false;
  }
}

async function pushMessage(userId: string, text: string): Promise<void> {
  await pushRaw(userId, [{ type: "text", text }]);
}

/**
 * 先用 Reply（免費），失敗了才改用 Push（吃配額）。
 * LINE 一次最多 5 則訊息。
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function deliver(
  replyToken: string | undefined,
  userId: string | null,
  messages: any[]
): Promise<void> {
  const slice = messages.slice(0, 5);
  if (replyToken && (await replyRaw(replyToken, slice))) return;
  if (userId) {
    console.warn("[webhook] reply 沒送成功，改用 push（會吃配額）");
    await pushRaw(userId, slice);
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

  const body = JSON.parse(rawBody) as { events?: LineEvent[] };
  const events = body.events ?? [];
  console.log(
    `[webhook] 收到 ${events.length} 個事件:`,
    events.map((e) => `${e.type}/${e.message?.type ?? "-"}`).join(", ") || "(空)"
  );

  for (const event of events) {
    // ── postback：Flex 卡片上的「♡ 收藏」 ────────────────────────
    // data 格式：action=like&pid=<product_id>&slot=top|bottom
    if (event.type === "postback") {
      const params = new URLSearchParams(event.postback?.data ?? "");
      const uid = event.source?.userId ?? null;

      if (params.get("action") !== "like" || !uid) {
        console.warn(`[webhook] 看不懂的 postback：${event.postback?.data}`);
        continue;
      }

      const pid = params.get("pid") ?? "";
      const slotLabel = params.get("slot") === "bottom" ? "下著" : "上衣";

      // 先回一則，讓使用者馬上看到有反應（replyToken 幾秒就過期）
      if (event.replyToken) {
        await replyText(event.replyToken, `♡ 收到，正在把這件${slotLabel}加進你的偏好...`);
      }

      after(async () => {
        const senderName = await getSenderName(uid);
        const result = await likeProduct(uid, pid, { senderName });

        if (!result.ok) {
          console.error(`[webhook] 按讚失敗 product=${pid}: ${result.reason}`);
          await pushMessage(
            uid,
            process.env.CHAT_DEBUG === "true"
              ? `❌ 收藏失敗：${result.reason.slice(0, 300)}`
              : "收藏沒成功，等一下再試試 🙏"
          );
          return;
        }

        const name = result.title ? `「${result.title}」` : `這件${slotLabel}`;
        await pushMessage(
          uid,
          result.created
            ? `已收藏 ${name} ✅\n之後推薦會更偏向這種風格。`
            : `${name} 你已經收藏過了 👍`
        );
      });

      continue;
    }

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
            (process.env.ANTHROPIC_API_KEY ? "anthropic" :
             process.env.OPENAI_API_KEY    ? "openai"    : "rules");
          await updateUserPreferenceFile(capturedUid, p);
          await pushMessage(capturedUid, "偏好已更新 💾");
        });
      }
      continue;
    }

    // ── 路徑 2 & 3：非 IG URL 或純文字 → LLM 穿搭對話 ──────────
    //
    // 為什麼不先回一則「⏳ 收到」：
    //   那會用掉唯一的 replyToken，導致後面的卡片只能走 Push API，
    //   而 Push 在 LINE 免費方案每月有上限，用完之後全部靜默失敗 ——
    //   從使用者端看就是「只收到收到、然後就沒下文」。
    //
    // 現在改成：顯示「輸入中」動畫（免費、不用掉 replyToken），
    // 背景跑完整流程，最後用 replyToken 一次回 [卡片, 建議]。
    // replyToken 有效期約一分鐘，maxDuration 是 60 秒，剛好在範圍內；
    // 真的來不及才退回 Push。
    if (userId) await startLoading(userId);

    const capturedUserId = userId;
    const capturedText = text;
    const capturedNonIgUrls = nonIgUrls;
    const capturedReplyToken = event.replyToken;

    after(async () => {
      const debug = process.env.CHAT_DEBUG === "true";
      // 進度訊息預設只寫 log 不推播 —— 每一則都吃 push 配額。
      // 真的要在手機上看逐步進度再開 CHAT_PUSH_PROGRESS=true。
      const pushProgress = process.env.CHAT_PUSH_PROGRESS === "true";
      const t0 = Date.now();
      const ms = () => `${Date.now() - t0}ms`;

      console.log(`[webhook] after() 開始 userId=${capturedUserId?.slice(0, 8) ?? "null"} text=${capturedText.slice(0, 40)}`);

      try {
        const onProgress = async (msg: string) => {
          console.log(`[webhook] 進度 (${ms()}) ${msg.split("\n")[0]}`);
          if (pushProgress && capturedUserId) await pushMessage(capturedUserId, msg);
        };

        const reply = await generateChatReply(capturedUserId, capturedText, {
          nonIgUrls: capturedNonIgUrls.length > 0 ? capturedNonIgUrls : undefined,
          onProgress,
        });
        console.log(`[webhook] generateChatReply 完成 (${ms()}) outfits=${reply.outfits?.length ?? 0}`);

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const messages: any[] = [];

        const flex = reply.outfits ? buildOutfitCarousel(reply.outfits) : null;

        if (flex) {
          messages.push({
            type: "text",
            text:
              reply.prefScope === "user"
                ? "幫你挑了這幾套 ✨（已參考你收藏的單品，左右滑動看看）"
                : reply.prefScope === "global"
                  ? "幫你挑了這幾套 ✨（你還沒有收藏，先用大家的當參考 —— 按 ♡ 收藏會更準）"
                  : "幫你挑了這幾套 ✨（左右滑動瀏覽，按 ♡ 收藏會讓下次更準）",
          });
          messages.push(flex);

          // 卡片跟建議放在同一次 reply 裡（最多 5 則），不用多花一次 push
          if (reply.advice) {
            const provider = process.env.CHAT_PROVIDER ||
              (process.env.ANTHROPIC_API_KEY ? "anthropic" :
               process.env.OPENAI_API_KEY    ? "openai"    : "rules");
            const advice = await writeOutfitAdvice(reply.advice, provider);
            console.log(`[webhook] 穿搭建議 (${ms()}) ${advice ? "完成" : "沒產出"}`);
            if (advice) {
              messages.push({
                type: "text",
                text: `💡 第 ${reply.advice.outfitIndex} 套的搭配建議\n\n${advice}`,
              });
            }
          }
        } else {
          if (!siteUrl() && reply.outfits?.length) {
            console.warn("[webhook] SITE_URL 沒設，卡片會沒有圖");
          }
          messages.push({ type: "text", text: reply.text.slice(0, 4900) });
        }

        if (debug && flex) {
          messages.push({ type: "text", text: reply.text.slice(0, 4900) });
        }

        await deliver(capturedReplyToken, capturedUserId, messages);
        console.log(`[webhook] after() 結束 (${ms()})`);

      } catch (e) {
        console.error(`[webhook] 背景處理失敗 (${ms()}):`, e);
        const errMsg = debug
          ? `❌ 處理時發生錯誤：\n${String(e).slice(0, 400)}`
          : "很抱歉，處理時發生問題，請稍後再試 🙏";
        await deliver(capturedReplyToken, capturedUserId, [{ type: "text", text: errMsg }]);
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
