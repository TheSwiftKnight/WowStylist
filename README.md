# WowStylist

把喜歡的 Instagram 貼文 / Reels 透過 LINE 分享給官方帳號 bot，自動收藏並顯示在網頁上（類似 yaay 的核心流程）。

## 架構

```
IG App ──share link──> LINE chatbot（官方帳號）
                          │ webhook (HTTPS POST)
                          ▼
                 Next.js API Route  /api/line/webhook
                          │ 驗簽章 → 解析 IG 連結 → 存 DB
                          ▼
                    SQLite (Prisma)          ←之後可無痛換雲端 Postgres
                          ▲
                          │
                 Next.js 前端  /   （列表 + IG embed 預覽）
```

## 技術棧

- **Next.js 15**（App Router, TypeScript）— 前端頁面 + API 同一個 repo，之後串 LLM / 第三方 API 也放 API route
- **Prisma + SQLite** — MVP 本機資料庫；上雲時把 `schema.prisma` 的 provider 改成 `postgresql`、換 `DATABASE_URL` 即可
- **LINE Messaging API** — 直接用 `fetch` 呼叫，沒有多裝 SDK

## 快速開始

```bash
npm install          # 安裝依賴（會自動 prisma generate）
cp .env.example .env # 填入 LINE 的金鑰（見 SETUP.md）
npx prisma db push   # 建立 SQLite 資料庫
npm run db:seed      # （可選）塞兩筆範例資料
npm run dev          # http://localhost:3000
```

沒設定 LINE 之前也能玩：打開首頁，用最上面的輸入框貼任何 IG 貼文/Reels 連結。

LINE bot 完整設定步驟 → 見 **SETUP.md**。

## API

| Method | Path                | 說明 |
|--------|---------------------|------|
| POST   | `/api/line/webhook` | LINE 平台呼叫的 webhook（驗 `x-line-signature`） |
| GET    | `/api/links`        | 列出收藏 |
| POST   | `/api/links`        | 手動新增 `{ "url": "https://www.instagram.com/p/..." }` |
| DELETE | `/api/links/:id`    | 刪除一筆 |

## IG 內容是怎麼抓的？

收到連結後，後端會去抓 `instagram.com/p/<code>/embed/captioned/`（IG 公開的 embed 頁，不用登入、不用 API 金鑰），從 HTML 解析出**帳號、caption、圖片網址**（Reels 是影片縮圖），並把圖片下載到 `public/media/` 存起來（IG 的 CDN 圖片網址帶簽名、幾天後會過期，所以必須落地保存）。前端卡片顯示這些內容，點卡片直接跳原始 IG 貼文。相關程式在 `src/lib/igFetch.ts`。

## 已知限制（MVP）

- **私人帳號、被下架/限制的貼文**抓不到內容，卡片會顯示「尚未抓到圖片」，狀態記為 `failed`；頁面右上的「補抓」按鈕可重試（一次 10 筆）。
- 短時間大量抓取可能被 IG 限流（429），等一陣子再按補抓即可。要更穩定可之後改串官方 oEmbed API（需 Facebook 開發者帳號審核）或第三方服務。
- 目前多圖輪播貼文只抓第一張圖。
- IG App 的「分享」選單裡選 LINE 時，實際送出的是**連結文字訊息**，bot 收到的就是一段含網址的文字，本專案就是解析這段文字。
- SQLite 檔在本機（`prisma/dev.db`，已 gitignore），部署到 Vercel 這類 serverless 前要先換雲端 DB。
