import { NextResponse } from "next/server";
import { generateChatReply, writeOutfitAdvice, inspectClassifierPrompt, resolveProvider } from "@/lib/chat";
import { buildOutfitCarousel, siteUrl } from "@/lib/flex";
import { listStyleProfiles } from "@/lib/rank";

// GET /api/chat/diag?token=...&text=幫我推薦夏日穿搭
//
// 在瀏覽器裡跑一次完整的穿搭流程，把每一段的耗時跟結果用 JSON 吐回來。
//
// 為什麼需要這支：LINE 那條路徑上，錯誤只會出現在 Vercel 的 log 裡，
// 而且訊息要靠 Push API 送出去 —— push 配額用完的話使用者端什麼都看不到，
// 看起來就像「卡住沒反應」。這支完全不碰 LINE，可以單獨確認是哪一段壞掉。
//
// 需要設 DIAG_TOKEN 環境變數才會啟用（這個網址是公開的）。

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * NextResponse.json() 送出的 content-type 不帶 charset，
 * 有些 client（終端機、部分瀏覽器設定）會拿系統編碼去解，中文就變亂碼。
 * 這是除錯工具，看不懂字等於沒用，所以明確標 utf-8。
 */
function json(data: unknown, status = 200) {
  return new NextResponse(JSON.stringify(data, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const expected = process.env.DIAG_TOKEN;

  if (!expected) {
    return json(
      {
        error: "DIAG_TOKEN is not set — this endpoint is disabled.",
        error_zh: "DIAG_TOKEN 沒設，這支端點是關閉的",
        howto: "Vercel → Settings → Environment Variables → 新增 DIAG_TOKEN（值自己取）→ 重新部署",
      },
      404
    );
  }
  if (url.searchParams.get("token") !== expected) {
    return json({ error: "bad token", error_zh: "token 不對" }, 401);
  }

  const text = url.searchParams.get("text") ?? "幫我推薦夏日穿搭";
  const userId = url.searchParams.get("userId") ?? "diag-user";
  const withAdvice = url.searchParams.get("advice") !== "0";

  const t0 = Date.now();
  const marks: { stage: string; ms: number; note?: string }[] = [];
  const mark = (stage: string, note?: string) =>
    marks.push({ stage, ms: Date.now() - t0, note });

  // 先把環境看一遍 —— 少一把金鑰就會整條掛掉，這裡一眼看得出來
  const env = {
    CHAT_PROVIDER: process.env.CHAT_PROVIDER || "(空，自動偵測)",
    // 環境變數是什麼、實際用的是什麼，這兩個要分開看
    resolvedProvider: resolveProvider(),
    CHAT_MODEL: process.env.CHAT_MODEL || "(預設)",
    CHAT_DEBUG: process.env.CHAT_DEBUG || "(未設)",
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ? "已設定" : "❌ 沒有",
    OPENAI_API_KEY: process.env.OPENAI_API_KEY ? "已設定" : "沒有",
    HF_TOKEN: process.env.HF_TOKEN ? "已設定" : "❌ 沒有（embedQuery 會直接丟錯）",
    DB_HOST: process.env.DB_HOST ? "已設定" : "❌ 沒有",
    PRODUCTS_DB_HOST: process.env.PRODUCTS_DB_HOST ? "已設定" : "沒有（會跟 IG 共用同一台）",
    SITE_URL: siteUrl() ?? "❌ 沒設（Flex 卡片會沒有圖）",
    LINE_CHANNEL_ACCESS_TOKEN: process.env.LINE_CHANNEL_ACCESS_TOKEN ? "已設定" : "❌ 沒有",
  };

  // Vercel 會自動注入這幾個。「為什麼改了還是舊行為」最常見的原因是
  // 對著舊的 deployment 按 Redeploy —— 那只會用同一個 commit 重建，
  // 環境變數更新了但程式碼沒有。把 commit 印出來就不用猜。
  const deploy = {
    commit: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? "(本機或非 Vercel)",
    message: process.env.VERCEL_GIT_COMMIT_MESSAGE ?? null,
    branch: process.env.VERCEL_GIT_COMMIT_REF ?? null,
    vercelEnv: process.env.VERCEL_ENV ?? null,
  };

  // 直接把明顯的設定錯誤講出來，不要讓人自己對著 env 猜
  const diagnosis: string[] = [];
  if (!process.env.ANTHROPIC_API_KEY && !process.env.OPENAI_API_KEY) {
    diagnosis.push(
      "❌ 沒有任何 LLM 金鑰（ANTHROPIC_API_KEY / OPENAI_API_KEY）→ " +
      "會降級成關鍵字規則，回覆是零延遲的罐頭句、也不會有推薦卡片。這是最優先要修的。"
    );
  }
  if ((process.env.CHAT_PROVIDER || "").toLowerCase() === "openrouter") {
    diagnosis.push(
      "⚠️ CHAT_PROVIDER=openrouter 是舊值（Nemotron 已移除），程式會自動改用 anthropic。" +
      "建議直接把這個環境變數刪掉或改成 anthropic，避免誤導。"
    );
  }
  if (!process.env.HF_TOKEN) {
    diagnosis.push("❌ 沒有 HF_TOKEN → embedQuery 會丟錯，排不出商品（會變成純文字的錯誤訊息）。");
  }
  if (!process.env.DB_HOST) {
    diagnosis.push("❌ 沒有 DB_HOST → 撈不到商品向量與使用者偏好。");
  }
  if (!siteUrl()) {
    diagnosis.push("⚠️ 沒有 SITE_URL → Flex 卡片會沒有圖（LINE 要用公開 HTTPS 網址抓圖）。");
  }

  let styleCount = 0;
  let classifier: {
    styleCount: number;
    styleNames: string[];
    promptChars: number;
    prompt?: string;
  } | null = null;

  try {
    styleCount = listStyleProfiles().length;
    mark("載入 style_kb", `${styleCount} 個風格`);

    // 分類器實際看到的風格清單。跟 styleCount 不一樣的話就是 prompt 沒重新生成
    const insp = inspectClassifierPrompt();
    classifier = {
      styleCount: insp.styleCount,
      styleNames: insp.styleNames,
      promptChars: insp.promptChars,
      // 完整 prompt 很長，要看再加 &prompt=1
      ...(url.searchParams.get("prompt") === "1" ? { prompt: insp.prompt } : {}),
    };
    mark("組分類器 prompt", `${insp.styleCount} 個風格、${insp.promptChars} 字元`);

    if (insp.styleCount !== styleCount) {
      diagnosis.push(
        `⚠️ style_kb 有 ${styleCount} 個風格，但分類器 prompt 只看到 ${insp.styleCount} 個`
      );
    }
    if (insp.styleCount <= 6) {
      diagnosis.push(
        `⚠️ 分類器只看到 ${insp.styleCount} 個風格 —— 若預期是 48，多半是部署的版本還沒更新，` +
        `或 data/style-kb/style_kb.jsonl 沒被打包進去`
      );
    }
  } catch (e) {
    mark("載入 style_kb 失敗", String(e));
    diagnosis.push(`❌ 讀 style_kb 失敗：${String(e)}`);
  }

  try {
    const reply = await generateChatReply(userId, text, {
      onProgress: async (msg) => { mark("progress", msg.split("\n")[0].slice(0, 120)); },
    });
    mark("generateChatReply", `${reply.outfits?.length ?? 0} 套`);

    const flex = reply.outfits ? buildOutfitCarousel(reply.outfits) : null;
    mark("組 Flex 卡片", flex ? `${flex.contents.contents.length} 張` : "組不出來（沒有可用的套數）");

    if ((reply.outfits?.length ?? 0) > 0 && !reply.advice) {
      diagnosis.push(
        "⚠️ 有推薦但沒有 advice context —— 三套都對不回 style_kb 的任何一筆搭配建議，" +
        "或者部署的版本還沒有穿搭建議這個功能（commit b427b9b 之後才有）"
      );
    }

    let advice: string | null = null;
    if (withAdvice && reply.advice) {
      advice = await writeOutfitAdvice(reply.advice);
      mark("穿搭建議", advice ? `${advice.length} 字` : "沒產出");
    }

    return json({
      ok: true,
      query: text,
      totalMs: Date.now() - t0,
      deploy,
      diagnosis: diagnosis.length ? diagnosis : ["✅ 看起來都正常"],
      env,
      styleCount,
      classifier,
      marks,
      prefScope: reply.prefScope ?? null,
      outfits: reply.outfits ?? [],
      adviceContext: reply.advice
        ? {
            outfitIndex: reply.advice.outfitIndex,
            matchScore: reply.advice.matchScore,
            sourceTitle: reply.advice.sourceTitle,
            dos: reply.advice.dos,
          }
        : null,
      advice,
      // 純文字版（debug 模式下會含各階段說明）
      text: reply.text,
      flexPreview: flex ? flex.contents : null,
    });
  } catch (e) {
    mark("丟出例外", String(e));
    return json(
      {
        ok: false,
        query: text,
        totalMs: Date.now() - t0,
        deploy,
        diagnosis,
        env,
        styleCount,
        marks,
        error: String(e),
        stack: e instanceof Error ? e.stack?.split("\n").slice(0, 12) : undefined,
      },
      500
    );
  }
}
