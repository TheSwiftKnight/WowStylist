#!/usr/bin/env npx tsx
/**
 * WowStylist Session 邏輯本地測試腳本
 * ─────────────────────────────────────────────────────────────────────
 *
 * 執行方式：
 *   npx tsx scripts/test-session.ts          # 互動模式（readline）
 *   npx tsx scripts/test-session.ts --batch  # 自動跑預設測試腳本後退出
 *
 * 環境變數（放在 .env.local，或直接 export）：
 *   CHAT_PROVIDER   = anthropic | openai | rules
 *   ANTHROPIC_API_KEY / OPENAI_API_KEY
 *   CHAT_MODEL      = （可選）覆蓋預設模型
 *   CHAT_DEBUG      = true  顯示詳細 debug 資訊
 *
 * 互動模式特殊指令：
 *   /end     手動結束目前 session（觸發偏好檔更新）
 *   /status  顯示目前 session 狀態與對話歷史
 *   /quit    退出
 *
 * 驗證重點：
 *   ✓ 第一則訊息 → 開新 session
 *   ✓ 繼續補充同一需求 → 「continue」決策，LLM 得到帶歷史的 prompt
 *   ✓ 切換完全不同場合 → 「new」決策，舊 session 結束並更新偏好檔
 *   ✓ 每個 phase 的耗時顯示
 *   ✓ data/user-prefs/{userId}.md 是否正確生成/更新
 */

// ── 載入 .env.local ──────────────────────────────────────────────────
import { resolve } from "path";
import { existsSync } from "fs";

const envPath = resolve(process.cwd(), ".env");
if (existsSync(envPath)) {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { configDotenv } = require("dotenv") as typeof import("dotenv");
  configDotenv({ path: envPath });
  process.stdout.write(`\x1b[2m[env] 已載入 ${envPath}\x1b[0m\n`);
}

// ── 匯入 chat 模組 ────────────────────────────────────────────────────
import {
  generateChatReply,
  endFashionSession,
  getSessionHistory,
  updateUserPreferenceFile,
  writeOutfitAdvice,
} from "../src/lib/chat";

import readline from "readline";

// ── ANSI 顏色 ─────────────────────────────────────────────────────────
const C = {
  reset:   "\x1b[0m",
  bold:    "\x1b[1m",
  dim:     "\x1b[2m",
  cyan:    "\x1b[36m",
  green:   "\x1b[32m",
  yellow:  "\x1b[33m",
  red:     "\x1b[31m",
  magenta: "\x1b[35m",
  blue:    "\x1b[34m",
};

// ── 工具函式 ──────────────────────────────────────────────────────────

function c(color: keyof typeof C, text: string): string {
  return `${C[color]}${text}${C.reset}`;
}

function getProvider(): string {
  const explicit = (process.env.CHAT_PROVIDER || "").toLowerCase();
  if (explicit) return explicit;
  if (process.env.ANTHROPIC_API_KEY)  return "anthropic";
  if (process.env.OPENAI_API_KEY)     return "openai";
  return "rules";
}

function printStatus(userId: string): void {
  const turns = getSessionHistory(userId);
  if (!turns || turns.length === 0) {
    console.log(c("yellow", "📂 無活躍 session（或 session 已結束）"));
    return;
  }
  console.log(c("green", `📂 Session 進行中 | turns: ${turns.length}`));
  turns.forEach((t, i) => {
    const role  = t.role === "user" ? c("cyan", "你") : c("magenta", "AI");
    const preview = t.content.replace(/\n/g, " ").slice(0, 80);
    console.log(`  ${c("dim", `[${i + 1}]`)} ${role}：${preview}…`);
  });
}

async function handleEnd(userId: string): Promise<void> {
  const turns = getSessionHistory(userId);
  if (!turns || turns.length === 0) {
    console.log(c("yellow", "⚠️  目前無 session 可以結束"));
    return;
  }
  const provider = getProvider();
  console.log(c("yellow", `⏹️  結束 session（${turns.length} 輪），更新偏好檔...`));
  const t0 = Date.now();
  endFashionSession(userId);
  await updateUserPreferenceFile(userId, provider);
  console.log(c("green", `✅ 偏好檔已更新（${Date.now() - t0}ms）`));
  console.log(c("dim", `   → data/user-prefs/${userId}.md`));
}

async function sendMessage(userId: string, text: string): Promise<void> {
  const startTs = Date.now();

  console.log(`\n${c("dim", "─────────────────────────────────────────")}`);
  console.log(c("bold", `你 > ${text}`));
  console.log("");

  const debug = process.env.CHAT_DEBUG === "true";

  try {
    const answer = await generateChatReply(userId, text, {
      onProgress: async (msg: string) => {
        const elapsed = Date.now() - startTs;
        const lines   = msg.split("\n");
        const header  = lines[0];

        // 以不同顏色區分不同 phase 的 header
        let headerColored: string;
        if (header.startsWith("🧠"))  headerColored = c("magenta", header);
        else if (header.startsWith("📂")) headerColored = c("cyan",    header);
        else if (header.startsWith("🔄")) headerColored = c("blue",    header);
        else if (header.startsWith("🔍") || header.startsWith("📊")) headerColored = c("yellow", header);
        else if (header.startsWith("💾")) headerColored = c("green",   header);
        else if (header.startsWith("📝")) headerColored = c("dim",     header);
        else if (header.startsWith("ℹ️") || header.startsWith("[DEBUG]")) headerColored = c("dim", header);
        else if (header.startsWith("❌") || header.startsWith("⚠️")) headerColored = c("red",    header);
        else                             headerColored = header;

        console.log(`${c("dim", `[+${String(elapsed).padStart(5, " ")}ms]`)} ${headerColored}`);

        // debug 模式顯示 phase 的詳細內容
        if (debug && lines.length > 1) {
          lines.slice(1).filter((l) => l.trim()).forEach((l) => {
            console.log(`         ${c("dim", l)}`);
          });
        }
      },
    });

    const totalMs = Date.now() - startTs;
    console.log("");
    console.log(c("green", `${c("bold", "AI 回覆")} ${c("dim", `[總耗時 ${totalMs}ms]`)}：`));
    console.log(answer.text);

    // LINE 上會變成 Flex carousel；這裡用文字把卡片內容列出來對照
    if (answer.outfits?.length) {
      console.log("");
      console.log(c("cyan", `${c("bold", "卡片")} ${c("dim", `(${answer.outfits.length} 張，偏好來源 ${answer.prefScope ?? "-"})`)}：`));
      for (const o of answer.outfits) {
        console.log(c("bold", `  第 ${o.index} 套 · ${o.styleZh}`));
        for (const it of o.items) {
          const price = it.priceTwd === null ? "—" : `NT$${Math.round(it.priceTwd)}`;
          console.log(
            `    ${it.slot.padEnd(6)} #${it.productId} ${it.title ?? "(無標題)"} ${price} ` +
            c("dim", `score=${it.finalScore.toFixed(3)}`)
          );
          console.log(c("dim", `           ${it.productUrl ?? "(無連結)"}`));
        }
      }
    }
    if (answer.advice) {
      console.log("");
      console.log(c("magenta", `${c("bold", "穿搭建議")} ${c("dim", `(第 ${answer.advice.outfitIndex} 套，吻合度 ${answer.advice.matchScore.toFixed(3)}，來源：${answer.advice.sourceTitle ?? "—"})`)}：`));
      const advice = await writeOutfitAdvice(answer.advice);
      console.log(advice ?? c("red", "（產生失敗，看上面的 log）"));
    }
    console.log(c("dim", "─────────────────────────────────────────"));

  } catch (e) {
    console.error(c("red", `❌ 錯誤：${e}`));
  }
}

// ── 預設 Batch 測試場景 ────────────────────────────────────────────────
const BATCH_SCENARIOS: { label: string; msg: string; cmd?: "end" | "status" }[] = [
  { label: "Turn 1 — 新需求（辦公室穿搭）",
    msg:   "我想找辦公室穿搭，簡約一點，預算 3000 以內" },

  { label: "Turn 2 — 補充（同 session：調整顏色）",
    msg:   "顏色換淺一點，不要黑色" },

  { label: "Turn 3 — 補充（同 session：調整版型）",
    msg:   "上衣版型寬鬆一點，下身修身" },

  { label: "查看 session 狀態",
    msg:   "",
    cmd:   "status" },

  { label: "Turn 4 — 全新需求（新 session：海邊度假）",
    msg:   "我想找海邊度假穿搭，波西米亞風，預算不限" },

  { label: "Turn 5 — 補充新 session",
    msg:   "要有連身裙，顏色要鮮豔" },

  { label: "使用者傳「結束這次討論」結束 session（觸發偏好更新）",
    msg:   "結束這次討論" },
];

async function runBatch(userId: string): Promise<void> {
  console.log(c("bold", "\n── BATCH 測試模式 ──────────────────────────────\n"));

  for (const scenario of BATCH_SCENARIOS) {
    console.log(c("bold", `\n▶ ${scenario.label}`));

    if (scenario.cmd === "status") {
      printStatus(userId);
      await new Promise((r) => setTimeout(r, 500));
      continue;
    }
    if (scenario.cmd === "end") {
      await handleEnd(userId);
      await new Promise((r) => setTimeout(r, 500));
      continue;
    }
    if (scenario.msg) {
      await sendMessage(userId, scenario.msg);
    }
    // 在 batch 模式中每次交換間稍作停頓，避免 rate limit
    await new Promise((r) => setTimeout(r, 1000));
  }

  console.log(c("green", "\n✅ Batch 測試完成"));
  console.log(c("dim", `請確認 data/user-prefs/${userId}.md 的內容是否正確`));
}

// ── 互動模式 ──────────────────────────────────────────────────────────
async function runInteractive(userId: string): Promise<void> {
  const rl = readline.createInterface({
    input:  process.stdin,
    output: process.stdout,
    prompt: `${c("bold", "你")} > `,
  });

  rl.prompt();

  rl.on("line", async (line) => {
    // rl 在非 TTY 環境（如 pipe）下可能連續觸發，暫停接收以免競態
    rl.pause();

    const input = line.trim();
    if (!input) { rl.resume(); rl.prompt(); return; }

    if (input === "/quit") {
      console.log(c("dim", "再見！"));
      rl.close();
      process.exit(0);
    }
    if (input === "/status") {
      printStatus(userId);
      rl.resume();
      rl.prompt();
      return;
    }
    // "/end" 指令 或 直接輸入「結束這次討論」（模擬 LINE 使用者行為）
    if (input === "/end" || input.trim() === "結束這次討論") {
      await handleEnd(userId);
      rl.resume();
      rl.prompt();
      return;
    }

    await sendMessage(userId, input);

    rl.resume();
    rl.prompt();
  });

  rl.on("close", () => {
    console.log(c("dim", "\n（stdin 關閉）"));
    process.exit(0);
  });
}

// ── 主程式 ────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  const userId  = process.env.TEST_USER_ID || "test_user_local";
  const batch   = process.argv.includes("--batch");
  const provider = getProvider();

  console.log(`\n${c("bold", c("cyan", "╔══════════════════════════════════════════════╗"))}`);
  console.log(`${c("bold", c("cyan", "║   WowStylist  Session 邏輯本地測試工具     ║"))}`);
  console.log(`${c("bold", c("cyan", "╚══════════════════════════════════════════════╝"))}`);
  console.log(`${c("dim", `userId        = ${userId}`)}`);
  console.log(`${c("dim", `CHAT_PROVIDER = ${provider}`)}`);
  console.log(`${c("dim", `CHAT_DEBUG    = ${process.env.CHAT_DEBUG || "false"}`)}`);
  console.log(`${c("dim", `模式          = ${batch ? "batch（自動腳本）" : "interactive（互動 readline）"}`)}`);

  if (!batch) {
    console.log(`\n${c("yellow", "指令：/end 或「結束這次討論」結束 session｜/status 查看狀態｜/quit 退出")}`);
    console.log(c("dim", "─────────────────────────────────────────\n"));
  }

  if (batch) {
    await runBatch(userId);
    process.exit(0);
  } else {
    await runInteractive(userId);
  }
}

main().catch((e) => {
  console.error(c("red", `[fatal] ${e}`));
  process.exit(1);
});
