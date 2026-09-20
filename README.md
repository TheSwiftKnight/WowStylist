# WowStylist

Share an Instagram post / Reel you like with the LINE official-account bot,
and the system pulls out **every single garment** in it, writes a semantic
description for each, encodes it into a vector, stores it in RDS, and pins
them one by one on the web page.

## Architecture

```
IG App ──share link──> LINE chatbot (official account)
                          │ webhook (HTTPS POST)
                          ▼
                 Next.js  /api/line/webhook
                          │ verify signature → extract IG link → reply instantly
                          │
                          │ after(): POST /ingest
                          ▼
            FastAPI (./pipeline · localhost:8000 by default)
                          │ returns job_id immediately, runs the whole chain in its own background
                          ▼
    Apify → Post/Reel Parser → Image Filter(Claude + dHash)
          → Fashion Analyzer(Claude Vision) → BGE-M3 Encoder
                          │
                          ▼
                       Amazon RDS (PostgreSQL)
                   ├── fashion_items  one garment = one row (with embedding)
                   ├── ingest_jobs    analysis progress
                   └── style_tags     style-compass tags
                          ▲
                          │ pg (raw SQL, no ORM)
                 Next.js frontend  /favorites · /compass
```

One incoming link turns into **several rows**: Reel → frame extraction → filtering
→ one row each for the top and the pants recognised in every frame.

## Tech stack

- **Next.js 15** (App Router, TypeScript) — frontend + API
- **node-postgres (`pg`)** — connects to RDS directly. **Prisma is gone**:
  the schema is owned by the Python side in `pipeline/migrations/001_fashion_items.sql`,
  and keeping a second `schema.prisma` around would only let the two drift apart.
- **LINE Messaging API** — called with plain `fetch`
- **Analysis pipeline** — `./pipeline` (Python + FastAPI). Same repo, same `.env`,
  but a separate process — Next.js cannot run Python.

## Quick start

One repo, two processes (Next.js + Python), one `.env`.

```bash
cp .env.example .env    # LINE keys / DB_* / APIFY_TOKEN / HF_TOKEN / ANTHROPIC_API_KEY
```

Run every command from the **project root**.

### 1. Python environment

```bash
npm run pipeline:install    # creates pipeline/.venv on first run, then installs packages
npm run db:doctor           # checks one gate at a time — start here when something is stuck
```

No `source activate` needed — every pipeline command under `npm run` goes through
`pipeline/py`, which always uses the python inside `pipeline/.venv`.
That avoids the classic "installed into conda, ran with Homebrew" mismatch,
and it never hits PEP 668 (`externally-managed-environment`) on the macOS system python.

### 2. RDS (one-time)

```bash
npm run db:migrate
```

Creates three tables: `fashion_items` (garments, shared by IG items and products),
`ingest_jobs` (analysis progress) and `style_tags` (style compass). It also adds a
unique index on `(source, source_item_id)`, so re-running the same post upserts
instead of growing duplicate rows.

Can't reach RDS (`Operation timed out`, IP looks like `172.31.x.x`) → see
**"Can't reach RDS"** in **pipeline/README.md**; that's an AWS
"Publicly accessible" / security-group problem.

### 3. Analysis service (terminal 1)

```bash
npm run pipeline            # uvicorn, port 8000
npm run pipeline:health     # confirm "ok": true
```

> Without `HF_TOKEN` the service won't even start — BGE-M3 runs through the
> Hugging Face Inference API, and `fashion_encoder.py` checks for the token at import time.

### 4. Website (terminal 2)

```bash
npm install
npm run dev                 # http://localhost:3000
```

You can play with it before setting LINE up at all: open `/favorites` and paste any
IG link into the input box at the top.

For the LINE bot setup steps (the two keys in the Developers Console, turning off
auto-reply, ngrok, filling in the webhook URL) see LINE's official docs; this
project's webhook path is `/api/line/webhook`.

Don't want to keep a local server running → see "Deployment" (Render / HF Spaces /
Cloud Run) in **pipeline/README.md**. Details of the analysis side (file
responsibilities, testing straight from the CLI, cost) → also **pipeline/README.md**.

## Project layout

```text
WowStylist/
├── src/                      Next.js (frontend + API routes)
│   ├── app/
│   └── lib/
│       ├── rds.ts            pg connection pool
│       ├── garments.ts       reads garments
│       ├── jobs.ts           reads analysis progress
│       └── pipeline.ts       calls the FastAPI service below
│
├── pipeline/                 Python analysis service (formerly HachThon)
│   ├── api/main.py           FastAPI
│   ├── fashion_retrieval/    Apify → Claude → BGE-M3 → fashion_items
│   └── migrations/           table-creation SQL
│
└── .env                      shared by both sides
```

## API

| Method | Path                        | Description |
|--------|-----------------------------|-------------|
| POST   | `/api/line/webhook`         | Webhook called by the LINE platform (verifies `x-line-signature`) |
| POST   | `/api/ingest`               | Sends one IG link into the pipeline, returns `{ job }` (202, does not wait for analysis) |
| GET    | `/api/jobs`                 | Recent analysis progress (frontend polls every 2 s) |
| GET    | `/api/garments`             | Lists saved garments (`?category=top&limit=50`) |
| DELETE | `/api/garments/:id`         | Removes one garment |
| GET    | `/api/garments/:id/image`   | Serves `image_data` (bytea) from RDS as an image |
| GET/POST | `/api/tags`               | Style-compass tags |
| POST   | `/api/tags/sync`            | Grows tags automatically from saved garments (weighted by tag frequency) |

## Why two layers of async?

Running the full pipeline on one post takes tens of seconds to a few minutes
(one Apify call + one Claude Vision call per image + one BGE-M3 call per garment).
Meanwhile:

- LINE's `replyToken` is only valid for a few seconds
- Serverless functions (Vercel and friends) have an execution time limit

So: **LINE gets a reply instantly → Next.js submits in the background with `after()`
→ Python analyses in the background**. The progress the user sees comes from the
`ingest_jobs` table, which Next.js SELECTs directly — no need to poll FastAPI
(and restarting it doesn't lose state).

## Where are the images stored?

In the database (`image_data bytea`), not on the filesystem. IG's CDN URLs are
signed and expire after a few days, and serverless has no writable disk. So the
pipeline writes images straight into RDS after downloading them, and the frontend
serves them via `/api/garments/:id/image` (list queries never select that column —
one page would be several MB otherwise).

## Two databases

| | Connection settings | Contents | Used by |
|---|---|---|---|
| **IG RDS** | `DB_*` | `fashion_items` (IG garments), `ingest_jobs`, `style_tags` | written by the pipeline; read by the site's favorites, style compass and **user preferences** |
| **Products RDS** | `PRODUCTS_DB_*` | `products` (e-commerce products + vectors) | read only by recommendation ranking, read-only |

Vectors in both are encoded with `BAAI/bge-m3` and L2-normalized, so they live in the
same semantic space — recommendation is just a cosine between "IG garments you saved"
and "products".

Leave `PRODUCTS_DB_HOST` empty and products fall back to the IG connection (only do
that when both datasets live on the same instance).

## What the table looks like

`fashion_items` is a single table shared by Instagram garments and products,
distinguished by `source`:

| Column | instagram | product |
|--------|-----------|---------|
| `source_item_id` | `<shortcode>_<position>_<index>_<category>` | `product_id` |
| `category` | `top` / `pants` | same |
| `text_description` | semantic description written by Claude Vision | same |
| `embedding` | BGE-M3, 1024 dims (L2-normalized) | same |
| `image_data` / `image_mime` | post image / Reel frame | product image |
| `display_tags` / `outfit_tags` | ✓ | NULL |
| `title` / `price_twd` / `product_url` | NULL | ✓ |
| `instagram_url` / `instagram_type` / `shortcode` / `timestamp` | ✓ | NULL |

## What are the semantic vectors for?

Both sides are encoded with the same model (`BAAI/bge-m3`) and L2-normalized, so
they share one semantic space, and matching products later is a single query —
since the vectors are normalized, cosine similarity equals the dot product:

```sql
-- take one IG top, find the most similar products
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

`embedding` is currently `DOUBLE PRECISION[]` with no vector index, so this query is
a full table scan. Once the dataset grows, add a pgvector column (the how-to is at
the bottom of the migration file); `db_writer.py` detects the column type
automatically, so nothing changes on the Python side.

## Known limitations

- **Private accounts, removed or restricted posts**: Apify can't fetch them, the job
  is recorded as `failed`, and the error message shows above the favorites list.
- `fashion_items` has no "who shared it" column — the LINE sharer is recorded on
  `ingest_jobs`.
- Only **top** and **pants** (including shorts) are recognised right now;
  skirts/dresses/outerwear/shoes/bags/accessories are ignored.
- Duplicate Reel frames are removed with dHash, and garment-level duplicates are
  removed once more by comparing description text
  (`GARMENT_DEDUP_THRESHOLD`, default 0.82). Two rows of the same outfit can still
  slip through.
- One Reel can trigger a dozen-plus Claude Vision calls — watch your API usage.
