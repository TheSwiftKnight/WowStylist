# pipeline — Instagram → 單品 → RDS

WowStylist 的分析後端。原本是另一個 repo（HachThon），現在整包搬進來，
跟 Next.js 同一個專案、同一份 `.env`（`../.env`，python-dotenv 會自己往上找）。

Next.js 不能跑 Python，所以這裡是一支獨立的 HTTP 服務，
由 `src/lib/pipeline.ts` 用 `POST /ingest` 呼叫。

```text
LINE  ──貼文連結──>  Next.js /api/line/webhook
                          │ 秒回使用者，after() 背景送件
                          ▼
                    POST localhost:8000/ingest
                          │ 建 ingest_jobs 一列，立刻回 job_id
                          ▼
              fashion_retrieval/pipeline.py
                  Apify           抓貼文 / Reel 原始 JSON
                  Parser          下載圖片；Reel 每 2 秒抽一格
                  Image Filter    Claude 篩掉沒衣服的 + dHash 去掉重複畫面
                  Analyzer        Claude Vision → 每件衣服一段描述 + tags
                  Encoder         BGE-M3 → 1024 維向量
                  DB Writer       upsert 進 fashion_items
                          │ 每階段回寫 ingest_jobs.status / stage
                          ▼
                    Amazon RDS (PostgreSQL)
```

## 檔案

| 檔案 | 做什麼 |
|------|--------|
| `api/main.py` | FastAPI：`POST /ingest`、`GET /jobs/:id`、`GET /health` |
| `fashion_retrieval/pipeline.py` | orchestrator：一條 URL 從頭跑到 RDS |
| `fashion_retrieval/apify_client.py` | IG URL → Apify 原始 JSON |
| `fashion_retrieval/post_parser.py` | 貼文 / 輪播 → 本機圖片 + caption |
| `fashion_retrieval/reel_parser.py` | Reel → 下載 mp4、每 2 秒抽一格 |
| `fashion_retrieval/image_filter.py` | Claude 語意篩選 + dHash 近似畫面去重 |
| `fashion_retrieval/fashion_analyzer.py` | Claude Vision → garment 描述 + display/outfit tags |
| `fashion_retrieval/fashion_encoder.py` | BGE-M3（Hugging Face Inference API） |
| `fashion_retrieval/fashion_formatter.py` | 組成統一 item 格式並編碼 |
| `fashion_retrieval/db_writer.py` | 寫進 `fashion_items`：欄位自動偵測、NOT NULL 先擋、`(source, source_item_id)` upsert |
| `fashion_retrieval/db_reader.py` | 讀商品 RDS（之後配商品用） |
| `migrations/001_fashion_items.sql` | 建表 / 補欄位（跑一次） |

## 跑起來

以下指令**都在專案根目錄跑**（不是 `pipeline/` 裡面）。

```bash
npm run pipeline:install   # 建 pipeline/.venv + 裝套件（不用 activate）
npm run db:doctor          # 檢查環境變數 / 套件 / 連不連得到 RDS / 資料表
npm run db:migrate         # 建表（連得到 RDS 才有用）
npm run pipeline           # 起服務，port 8000
npm run pipeline:health    # 應該回 "ok": true
```

### 為什麼不用 activate

`pipeline/py` 這支小 shell script 固定用 `pipeline/.venv/bin/python`，
所有 npm 指令都走它。這樣「套件裝在哪個 python、跑的時候用哪個 python」
永遠是同一個，不管你當下有沒有 activate、有沒有 conda。

第一次跑 `pipeline:install` 時它會自己把 venv 建起來。
想用自己的環境也可以 —— activate 之後把 `./py` 換成 `python` 就好。

**venv 不能跨機器共用**（裡面存的是絕對路徑）。同一個資料夾在別台機器打開過
的話，`rm -rf pipeline/.venv` 再 `npm run pipeline:install` 重建。
`py` 偵測到 venv 跑不動會直接告訴你這件事，不會讓你在半殘的環境裡除錯。

```bash
npm run db:show            # 看 RDS 裡實際有什麼（唯讀）
npm run db:show -- --full  # 描述不截斷
npm run db:show -- --id 42 # 某一列的全部欄位
```

`npm run db:doctor` 是卡住時的第一站 —— 它會一關一關告訴你哪裡不對、
怎麼修，包括 RDS 連不上時是 Publicly accessible 還是 security group 的問題。

`/health` 回的內容：缺哪個環境變數、連不連得上 DB、`fashion_items` 上有哪些欄位、
`missing_columns` 是不是空的（不是空的 = migration 還沒跑完整）、
`can_upsert` 是不是 `true`（false = 少了 unique index，重跑會長重複列）。

### 常見狀況

| 症狀 | 原因 | 修法 |
|------|------|------|
| `sh: uvicorn: command not found` | 套件沒裝 | `npm run pipeline:install` |
| `error: externally-managed-environment` | 裝到 macOS 的系統 / Homebrew python 去了 | `npm run pipeline:install`（走 venv，不會碰系統 python） |
| `ModuleNotFoundError: No module named 'apify_client'` | 套件沒裝，或裝在別的 Python 環境 | `npm run pipeline:install`；`npm run db:doctor` 會印出它用的是哪支 python |
| `.venv 壞了或不是這台機器建的` | venv 換過機器、或底下的 python 被升版/移掉 | `rm -rf pipeline/.venv && npm run pipeline:install` |
| `psql: connection ... Operation timed out`，IP 是 `172.31.x.x` | RDS 的 Publicly accessible = No，從 VPC 外面連不到 | 見下面 |
| `Table 'fashion_items' not found` | migration 還沒跑 | `npm run db:migrate` |

### RDS 連不到

`172.31.x.x` / `10.x.x.x` / `192.168.x.x` 都是 VPC 內網位址 ——
RDS endpoint 從外面解出這種 IP，代表這台的 **Publicly accessible 是 No**，
不管密碼對不對都連不上。三條路：

1. **開公開存取**：AWS Console → RDS → 這台 instance → Modify →
   Connectivity → Public access 選 Publicly accessible → 套用。
   然後 Connectivity & security → VPC security groups → Inbound rules →
   Add rule：PostgreSQL / 5432 / My IP。
2. **SSH 跳板**：VPC 裡有 EC2 的話
   `ssh -N -L 5432:<rds-endpoint>:5432 ec2-user@<bastion>`，
   再把 `.env` 的 `DB_HOST` 改成 `127.0.0.1`。
3. **請開這台 RDS 的人跑 migration**，或問清楚他們是怎麼連的。

解出來是公開 IP 但還是 timeout → 那就是 security group 沒開你的 IP，走第 1 點的後半段。

## 不開服務也能直接測

在專案根目錄：

```bash
# 跑完整條並寫進 RDS
npm run ig -- "https://www.instagram.com/p/XXXX/"

# 只跑分析，把「準備好要送上 RDS 的每一列」印出來，不寫 DB
npm run ig -- "https://www.instagram.com/reel/XXXX/" --no-db
```

（網址的 query string 會自動去掉，`?igsh=` / `?stkn=` 那些不用先清。）

`--no-db` 會印出 `rows`，每一列長這樣：

```json
{
  "source": "instagram",
  "source_item_id": "DcmYBQDA9bT_t6.0_0_top",
  "category": "top",
  "text_description": "A fitted dark brown ribbed tank top with a sleeveless cut and scoop neckline.",
  "embedding_dim": 1024,
  "embedding_model": "BAAI/bge-m3",
  "image_bytes": 184320,
  "image_mime": "image/jpeg",
  "display_tags": ["Dark Brown", "Tank Top", "Ribbed", "Fitted"],
  "outfit_tags": ["Casual", "Monochrome"],
  "instagram_url": "https://www.instagram.com/reel/DcmYBQDA9bT/",
  "instagram_type": "reel",
  "shortcode": "DcmYBQDA9bT",
  "timestamp": 6.0,
  "title": null,
  "price_twd": null,
  "product_url": null
}
```

key 就是 `fashion_items` 的欄位名，`db_writer.write_items()` 直接照著 INSERT。
只有兩個是顯示用的替身：`embedding_dim` 實際是 `embedding`（1024 個 float，
印出來沒法看），`image_bytes` 實際是 `image_data`（bytea）。

`title` / `price_twd` / `product_url` 是商品端的欄位，IG 來的一律 `null`；
反過來 `display_tags` / `outfit_tags` / `instagram_*` / `shortcode` / `timestamp`
是 IG 專屬的，商品那邊會是 `null`。

`source_item_id` 的組法（`pipeline.py` 的 `build_source_item_id`）：

```
post: <shortcode>_p<第幾張圖>_<第幾件衣服>_<category>
reel: <shortcode>_t<第幾秒>_<第幾件衣服>_<category>
```

同一則貼文重跑會打到 `(source, source_item_id)` 的 unique index，走 upsert。

## 一則貼文的成本

| 階段 | 外部呼叫 |
|------|----------|
| `apify` | Apify × 1 |
| `parse` | IG CDN（下載圖 / 影片） |
| `filter` | Claude × 1（一次把所有圖丟進去） |
| `analyze` | Claude Vision × N（一張圖一次） |
| `encode` | HF × M（一件衣服一次） |
| `write` | RDS |

Reel 一則可能是十幾次 Claude Vision。`GARMENT_DEDUP_THRESHOLD`（預設 0.82）
會在 encode 之前先把描述太像的衣服收掉，設 0 可以關掉。

## 環境變數

全部在 `../.env`（跟 Next.js 共用一份）。pipeline 會用到：

```
APIFY_TOKEN, ANTHROPIC_API_KEY, HF_TOKEN,
DB_HOST, DB_PORT, DB_NAME, DB_USER, DB_PASSWORD, DB_SSLMODE,
FASHION_TABLE, PIPELINE_TOKEN, ALLOWED_ORIGINS, GARMENT_DEDUP_THRESHOLD
```

`PIPELINE_OUTPUT_DIR` 可以改暫存圖片 / 影片的位置，預設 `pipeline/outputs/`。

商品在另一台 RDS 的話還要 `PRODUCTS_DB_HOST` / `_PORT` / `_NAME` / `_USER` /
`_PASSWORD` / `_SSLMODE` 跟 `PRODUCTS_TABLE`。`db_reader.get_connection()` 是
IG 那台，`get_products_connection()` 是商品那台；沒設 `PRODUCTS_DB_HOST` 時
後者會退回前者。
