# WowStylist

把喜歡的 Instagram 貼文 / Reels 透過 LINE 分享給官方帳號 bot，
系統會把貼文裡的**每一件衣服**拆出來、寫成語意描述、編成向量存進 RDS，
然後一件一件釘在網頁上。

## 架構

```
IG App ──share link──> LINE chatbot（官方帳號）
                          │ webhook (HTTPS POST)
                          ▼
                 Next.js  /api/line/webhook
                          │ 驗簽章 → 抓出 IG 連結 → 秒回使用者
                          │
                          │ after()：POST /ingest
                          ▼
            FastAPI（./pipeline · 預設 localhost:8000）
                          │ 立刻回 job_id，整條在它自己的背景跑
                          ▼
    Apify → Post/Reel Parser → Image Filter(Claude + dHash)
          → Fashion Analyzer(Claude Vision) → BGE-M3 Encoder
                          │
                          ▼
                       Amazon RDS (PostgreSQL)
                   ├── fashion_items  一件衣服 = 一列（含 embedding）
                   ├── ingest_jobs    分析進度
                   └── style_tags     風向標標籤
                          ▲
                          │ pg（直接下 SQL，沒有 ORM）
                 Next.js 前端  /favorites · /compass
```

一條連結進來會變成**好幾列**：Reel 抽格 → 過濾 → 每一格辨識出的上衣 / 褲子各一列。

## 技術棧

- **Next.js 15**（App Router, TypeScript）— 前端 + API
- **node-postgres (`pg`)** — 直接連 RDS。**沒有 Prisma 了**：
  schema 由 Python 那邊的 `pipeline/migrations/001_fashion_items.sql` 管，
  再維護一份 `schema.prisma` 只會兩邊對不起來。
- **LINE Messaging API** — 直接用 `fetch`
- **分析 pipeline** — `./pipeline`（Python + FastAPI）。同一個 repo、同一份 `.env`，
  但是獨立的行程 —— Next.js 跑不了 Python。

## 快速開始

一個 repo，兩個行程（Next.js + Python），一份 `.env`。

```bash
cp .env.example .env    # LINE 金鑰 / DB_* / APIFY_TOKEN / HF_TOKEN / ANTHROPIC_API_KEY
```

所有指令都在**專案根目錄**跑。

### 1. Python 環境

```bash
npm run pipeline:install    # 第一次會自己建 pipeline/.venv，然後裝套件
npm run db:doctor           # 一關一關檢查，卡住時先看這個
```

不用 `source activate` —— 所有 `npm run` 的 pipeline 指令都走
`pipeline/py`，它固定用 `pipeline/.venv` 裡的 python。
這樣就不會出現「裝進 conda、跑的時候用 Homebrew」那種對不起來的狀況，
也不會撞到 macOS 系統 python 的 PEP 668（`externally-managed-environment`）。

### 2. RDS（做一次就好）

```bash
npm run db:migrate
```

建三張表：`fashion_items`（單品，IG 和商品共用）、`ingest_jobs`（分析進度）、
`style_tags`（風向標）。另外在 `(source, source_item_id)` 上開一個 unique index，
同一則貼文重跑會 upsert 而不是長出重複列。

連不到 RDS（`Operation timed out`、IP 是 `172.31.x.x`）→ 見 **pipeline/README.md**
的「RDS 連不到」，那是 AWS 的 Publicly accessible / security group 設定問題。

### 3. 分析服務（terminal 1）

```bash
npm run pipeline            # uvicorn，port 8000
npm run pipeline:health     # 確認 "ok": true
```

> `HF_TOKEN` 沒填的話服務會直接起不來 —— BGE-M3 走 Hugging Face
> Inference API，`fashion_encoder.py` 在 import 時就會檢查。

### 4. 網站（terminal 2）

```bash
npm install
npm run dev                 # http://localhost:3000
```

沒設定 LINE 之前也能玩：打開 `/favorites`，用最上面的輸入框貼任何 IG 連結。

LINE bot 的設定步驟（Developers Console 的兩把鑰匙、關自動回覆、ngrok、
填 webhook URL）見 LINE 官方文件；本專案的 webhook 路徑是
`/api/line/webhook`。

不想一直開著本機 server → **pipeline/README.md** 的「部署」（Render / HF Spaces / Cloud Run）。
分析那側的細節（檔案分工、直接用 CLI 測、成本）→ 見 **pipeline/README.md**。

## 專案結構

```text
WowStylist/
├── src/                      Next.js（前端 + API route）
│   ├── app/
│   └── lib/
│       ├── rds.ts            pg 連線池
│       ├── garments.ts       讀單品
│       ├── jobs.ts           讀分析進度
│       └── pipeline.ts       呼叫下面那支 FastAPI
│
├── pipeline/                 Python 分析服務（原 HachThon）
│   ├── api/main.py           FastAPI
│   ├── fashion_retrieval/    Apify → Claude → BGE-M3 → fashion_items
│   └── migrations/           建表 SQL
│
└── .env                      兩邊共用
```

## API

| Method | Path                        | 說明 |
|--------|-----------------------------|------|
| POST   | `/api/line/webhook`         | LINE 平台呼叫的 webhook（驗 `x-line-signature`） |
| POST   | `/api/ingest`               | 送一條 IG 連結進 pipeline，回 `{ job }`（202，不等分析完） |
| GET    | `/api/jobs`                 | 最近的分析進度（前端每 2 秒 poll） |
| GET    | `/api/garments`             | 列出收藏的單品（`?category=top&limit=50`） |
| DELETE | `/api/garments/:id`         | 取下一件單品 |
| GET    | `/api/garments/:id/image`   | 把 RDS 裡的 `image_data`（bytea）吐成圖片 |
| GET/POST | `/api/tags`               | style 風向標的標籤 |
| POST   | `/api/tags/sync`            | 從收藏的單品自動長出標籤（依 tag 出現次數算權重） |

## 為什麼是兩層非同步？

整條 pipeline 跑一則貼文要幾十秒到幾分鐘（Apify 一次 + 每張圖各一次
Claude Vision + 每件衣服各一次 BGE-M3）。而：

- LINE 的 `replyToken` 只有幾秒
- Vercel 這類 serverless 的 function 有執行時間上限

所以：**LINE 秒收到回覆 → Next.js 用 `after()` 背景送件 → Python 背景分析**。
使用者看到的進度來自 `ingest_jobs` 表，Next.js 直接 SELECT，
不用去 poll FastAPI（那支重開也不會掉狀態）。

## 圖片存在哪？

存在資料庫裡（`image_data bytea`），不是檔案系統。IG 的 CDN 網址帶簽名、
幾天後會過期，而且 serverless 沒有可以寫的磁碟。所以 pipeline 下載完就直接
寫進 RDS，前端走 `/api/garments/:id/image` 出圖（列表查詢一律不撈這個欄位，
不然一頁就是好幾 MB）。

## 兩台資料庫

| | 連線設定 | 放什麼 | 誰在用 |
|---|---|---|---|
| **IG RDS** | `DB_*` | `fashion_items`（IG 單品）、`ingest_jobs`、`style_tags` | pipeline 寫；網站的收藏夾、風向標、**使用者偏好**讀 |
| **商品 RDS** | `PRODUCTS_DB_*` | `products`（電商商品 + 向量） | 只有推薦排序讀，而且只讀不寫 |

兩台的向量都是 `BAAI/bge-m3` 編的、都已經 L2 normalize，所以在同一個語意空間 ——
推薦就是拿「你收藏的 IG 單品」去跟「商品」算 cosine。

`PRODUCTS_DB_HOST` 留空的話商品會沿用 IG 那條連線（兩批資料放同一台時才這樣設）。

## 資料表長什麼樣

`fashion_items` 是 Instagram 單品和商品共用的一張表，用 `source` 區分：

| 欄位 | instagram | product |
|------|-----------|---------|
| `source_item_id` | `<shortcode>_<位置>_<序號>_<category>` | `product_id` |
| `category` | `top` / `pants` | 同左 |
| `text_description` | Claude Vision 寫的語意描述 | 同左 |
| `embedding` | BGE-M3 1024 維（已 L2 normalize） | 同左 |
| `image_data` / `image_mime` | 貼文圖 / Reel frame | 商品圖 |
| `display_tags` / `outfit_tags` | ✓ | NULL |
| `title` / `price_twd` / `product_url` | NULL | ✓ |
| `instagram_url` / `instagram_type` / `shortcode` / `timestamp` | ✓ | NULL |

## 語意向量拿來做什麼？

兩邊都用同一個模型（`BAAI/bge-m3`）編碼、都已經 L2 normalize，
所以在同一個語意空間，之後配商品就是一句查詢 —— 向量已經正規化，
cosine 相似度等於內積：

```sql
-- 拿某件 IG 上衣，找最像的商品
SELECT f.title, f.price_twd, f.product_url
  FROM fashion_items f, fashion_items q
 WHERE q.id = $1
   AND f.source = 'product'
   AND f.category = q.category
 ORDER BY (
   SELECT sum(a * b)
     FROM unnest(f.embedding, q.embedding) AS t(a, b)
 ) DESC
 LIMIT 10;
```

`embedding` 目前是 `DOUBLE PRECISION[]`，沒有向量索引，所以這查詢是全表掃描。
資料量長大之後再加一個 pgvector 欄位（做法寫在 migration 檔最下面），
`db_writer.py` 會自動偵測欄位型別，Python 那邊不用改。

## 已知限制

- **私人帳號、被下架/限制的貼文**：Apify 抓不到，job 會記成 `failed`，錯誤訊息顯示在收藏夾上方。
- `fashion_items` 沒有「誰分享的」欄位 —— LINE 分享人記在 `ingest_jobs` 上。
- 目前只辨識 **top（上衣）** 和 **pants（褲子，含短褲）**，裙子/洋裝/外套/鞋包配件會被忽略。
- Reel 的重複畫面用 dHash 去掉，衣服層級的重複再用描述文字比對去掉一次
  （`GARMENT_DEDUP_THRESHOLD`，預設 0.82）。還是有機會留下同一套的兩列。
- 一則 Reel 可能會打十幾次 Claude Vision，注意 API 用量。
