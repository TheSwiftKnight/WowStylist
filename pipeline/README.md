# pipeline — Instagram → garments → RDS

WowStylist's analysis backend. It used to be a separate repo (HachThon); the whole
thing now lives in here, in the same project as Next.js and sharing one `.env`
(`../.env` — python-dotenv walks up and finds it).

Next.js can't run Python, so this is a standalone HTTP service, called by
`src/lib/pipeline.ts` via `POST /ingest`.

```text
LINE  ──post link──>  Next.js /api/line/webhook
                          │ instant reply, submits in the background with after()
                          ▼
                    POST localhost:8000/ingest
                          │ inserts a row into ingest_jobs, returns job_id immediately
                          ▼
              fashion_retrieval/pipeline.py
                  Apify           fetches raw post / Reel JSON
                  Parser          downloads images; grabs one Reel frame every 2 s
                  Image Filter    Claude drops images with no clothes + dHash drops duplicate frames
                  Analyzer        Claude Vision → one description + tags per garment
                  Encoder         BGE-M3 → 1024-dim vector
                  DB Writer       upserts into fashion_items
                          │ every stage writes back ingest_jobs.status / stage
                          ▼
                    Amazon RDS (PostgreSQL)
```

## Files

| File | What it does |
|------|--------------|
| `api/main.py` | FastAPI: `POST /ingest`, `GET /jobs/:id`, `GET /health` |
| `fashion_retrieval/pipeline.py` | Orchestrator: one URL all the way to RDS |
| `fashion_retrieval/apify_client.py` | IG URL → raw Apify JSON |
| `fashion_retrieval/post_parser.py` | Post / carousel → local images + caption |
| `fashion_retrieval/reel_parser.py` | Reel → downloads the mp4, grabs a frame every 2 s |
| `fashion_retrieval/image_filter.py` | Claude semantic filtering + dHash near-duplicate frame removal |
| `fashion_retrieval/fashion_analyzer.py` | Claude Vision → garment description + display/outfit tags |
| `fashion_retrieval/fashion_encoder.py` | BGE-M3 (Hugging Face Inference API) |
| `fashion_retrieval/fashion_formatter.py` | Builds the unified item format and encodes it |
| `fashion_retrieval/db_writer.py` | Writes into `fashion_items`: auto column detection, NOT NULL pre-checks, `(source, source_item_id)` upsert |
| `fashion_retrieval/db_reader.py` | Reads the products RDS (for product matching later) |
| `migrations/001_fashion_items.sql` | Creates tables / adds columns (run once) |

## Running it

All of the commands below run **from the project root** (not inside `pipeline/`).

```bash
npm run pipeline:install   # creates pipeline/.venv + installs packages (no activate needed)
npm run db:doctor          # checks env vars / packages / RDS reachability / tables
npm run db:migrate         # creates tables (only works once RDS is reachable)
npm run pipeline           # starts the service on port 8000
npm run pipeline:health    # should return "ok": true
```

### Why there's no activate

The little shell script `pipeline/py` always uses `pipeline/.venv/bin/python`, and
every npm command goes through it. That way "which python the packages went into"
and "which python runs them" are always the same, whether or not you have anything
activated, and whether or not you use conda.

The first `pipeline:install` run creates the venv for you. You can use your own
environment instead — activate it and replace `./py` with `python`.

**A venv can't be shared across machines** (it stores absolute paths). If the same
folder has been opened on another machine, `rm -rf pipeline/.venv` and rebuild with
`npm run pipeline:install`. When `py` detects a broken venv it tells you so directly
rather than letting you debug inside a half-working environment.

```bash
npm run db:show            # shows what's actually in RDS (read-only)
npm run db:show -- --full  # don't truncate descriptions
npm run db:show -- --id 42 # every column of one row
```

`npm run db:doctor` is the first stop whenever you're stuck — it walks the gates one
by one and tells you what's wrong and how to fix it, including whether an
unreachable RDS is a "Publicly accessible" or a security-group problem.

What `/health` returns: which env vars are missing, whether the DB is reachable,
which columns exist on `fashion_items`, whether `missing_columns` is empty
(non-empty = the migration hasn't fully run) and whether `can_upsert` is `true`
(false = the unique index is missing, so re-runs will grow duplicate rows).

### Common situations

| Symptom | Cause | Fix |
|---------|-------|-----|
| `sh: uvicorn: command not found` | packages not installed | `npm run pipeline:install` |
| `error: externally-managed-environment` | installed into macOS system / Homebrew python | `npm run pipeline:install` (uses the venv, never touches system python) |
| `ModuleNotFoundError: No module named 'apify_client'` | packages not installed, or installed into a different Python | `npm run pipeline:install`; `npm run db:doctor` prints which python it uses |
| `.venv is broken or was built on another machine` | the venv moved machines, or the python underneath was upgraded/removed | `rm -rf pipeline/.venv && npm run pipeline:install` |
| `psql: connection ... Operation timed out`, IP is `172.31.x.x` | RDS "Publicly accessible" = No, unreachable from outside the VPC | see below |
| `Table 'fashion_items' not found` | migration hasn't run | `npm run db:migrate` |

### Can't reach RDS

`172.31.x.x` / `10.x.x.x` / `192.168.x.x` are all VPC-internal addresses — if the RDS
endpoint resolves to one of these from outside, that instance has
**Publicly accessible = No** and no password will get you in. Three options:

1. **Turn on public access**: AWS Console → RDS → the instance → Modify →
   Connectivity → Public access → Publicly accessible → apply.
   Then Connectivity & security → VPC security groups → Inbound rules →
   Add rule: PostgreSQL / 5432 / My IP.
2. **SSH bastion**: if there's an EC2 box inside the VPC,
   `ssh -N -L 5432:<rds-endpoint>:5432 ec2-user@<bastion>`,
   then change `DB_HOST` in `.env` to `127.0.0.1`.
3. **Ask whoever owns the instance to run the migration**, or ask how they connect.

If it resolves to a public IP and still times out, the security group doesn't allow
your IP — do the second half of option 1.

## Deployment (for when you don't want a local server running)

The `Dockerfile` is in this folder, and `render.yaml` (project root) and
`railway.json` are both written already.
**Render is the current first choice** — no credit card, takes a Dockerfile,
750 hours a month. Railway now only gives $1/month of credit and stops once the
trial is up.

### Render

1. [render.com](https://render.com) → sign in with GitHub → **New → Blueprint**
   → pick `WowStylist` → it reads `render.yaml` from the root.
   (Manual works too: **New → Web Service**, Runtime = **Docker**,
   **Root Directory** = `pipeline` ← this is the critical step; without it Render
   assumes the whole repo is Next.js.)
2. It asks you to fill in the env vars marked `sync: false` (see the next section).
3. Deploy. The first build takes five to ten minutes (opencv and ffmpeg).
4. You get `https://wowstylist-pipeline.onrender.com`.

`PORT` is provided by Render and the Dockerfile already reads it — don't set it yourself.

### Env vars to fill in

Use the same values as your local `.env`:

```
APIFY_TOKEN            ANTHROPIC_API_KEY       HF_TOKEN
DB_HOST                DB_USER                 DB_PASSWORD
PRODUCTS_DB_HOST       PRODUCTS_DB_USER        PRODUCTS_DB_PASSWORD
PIPELINE_TOKEN         ALLOWED_ORIGINS
```

The rest (`DB_PORT` / `DB_NAME` / `FASHION_TABLE` / `PRODUCTS_TABLE` …) already have
defaults in `render.yaml`.

Two things:

- **`PIPELINE_TOKEN` is mandatory this time.** Leaving it empty locally is fine, but
  this URL is public — without it anyone can burn your Apify and Claude credits.
  Generate one with `openssl rand -hex 24` and set the same value on the Next.js side
  (Vercel + local `.env`).
- Set `ALLOWED_ORIGINS` to `https://wow-stylist.vercel.app` (comma-separated for several).

### Letting RDS accept the connection

Render's free plan has no fixed IP, so the security groups of **both** RDS instances
have to be opened:

> EC2 → Security Groups → that RDS's SG → Inbound rules → Add rule
> → PostgreSQL / 5432 / `0.0.0.0/0`

Make sure the password is strong — this exposes the database to the public internet.
Change it once the demo is over.

### Don't let it fall asleep ← this part matters

Render's free plan **reclaims the container after 15 idle minutes**, and the next
request has to wait out a cold start of roughly a minute. For this project that
means: after it falls asleep, the first link you send into LINE will hang on submit.

The code already absorbs one layer of this (`src/lib/pipeline.ts`): the timeout is
relaxed to 60 s, a failure is retried once automatically, and as soon as the webhook
confirms there's an IG link it pings `/health` to wake the service up while we're
still fetching the user's name from LINE. But a one-minute cold start still makes the
user wait.

The real fix is to stop it sleeping — point a free uptime monitor at
`https://your-service.onrender.com/health` every 10 minutes:

- [cron-job.org](https://cron-job.org) (free, no credit card)
- [UptimeRobot](https://uptimerobot.com) (free plan, 5-minute interval)

A month is 744 hours, so the 750-hour allowance is just enough to keep one service up
around the clock — but only one, so don't run a second free service on the same account.

Ping `/health` ten minutes before the demo to confirm it's awake.

### Wiring it to Next.js

Vercel → Project → Settings → Environment Variables:

```
PIPELINE_API_URL = https://wowstylist-pipeline.onrender.com
PIPELINE_TOKEN   = (the same string as on Render)
```

You need a **Redeploy** for the change to take effect. To point your local setup at
Render, change the same two values in `.env`.

### Verifying

```bash
curl https://wowstylist-pipeline.onrender.com/health
```

You want `ok: true`, an empty `database.missing_columns` and `can_upsert: true`.
Then open `https://wow-stylist.vercel.app/api/health` — `checks.pipeline.ok` should
be true. Finally send a post from LINE and run `npm run db:show` to see whether the
job started.

### Things you'll trip over

| Symptom | Cause |
|---|---|
| Build fails and the log shows `npm install` running | Root Directory isn't set to `pipeline` |
| Deploy succeeds but the healthcheck keeps failing | Usually `HF_TOKEN` isn't set — `fashion_encoder.py` raises at import time, so uvicorn never starts. Check the first part of the Logs |
| `/health` returns `database.ok: false` | The RDS security group doesn't allow `0.0.0.0/0` (both instances) |
| `/ingest` returns 401 | `PIPELINE_TOKEN` differs between the two sides |
| The first link takes forever, then everything is fine | Cold start. Set up an uptime monitor so it doesn't sleep |
| A job is stuck in running forever | The running task was killed by a redeploy. On startup the service automatically marks anything older than 30 minutes as failed (`STALE_JOB_MINUTES` is configurable) |

### Other options

| Platform | Credit card | Cold start | Notes |
|---|---|---|---|
| **Render** free | No | ~1 min after 15 idle minutes | 750 h/month, first choice |
| **Hugging Face Spaces** (Docker SDK) | No | Sleeps only after a long idle | 2 vCPU / 16 GB; change the Dockerfile port to 7860 (`app_port`) and push the repo to HF separately; you already have an HF account |
| **Google Cloud Run** | Yes (free tier is more than enough) | Seconds to a dozen seconds | Scales to zero, pay per use, cheapest; more setup steps |
| **Fly.io** | Yes | Can be configured to scale to zero | Free plan no longer offered to new accounts |
| **Railway** | No | Doesn't sleep | Only $1/month of credit left, stops when the trial expires |

### Cost and limits

- One Reel triggers a dozen-plus Claude Vision calls and takes one to several minutes.
  That kind of bursty workload is fine on Render's free plan, but a container that
  stays up all the time eats the full 750 hours — just barely enough.
- The container filesystem is ephemeral. Downloaded images and frames are written to
  `/tmp` and are gone after a restart — which is fine, since the results (images as
  bytea included) all go into RDS.
- Today it's a single instance using FastAPI BackgroundTasks. Throwing many links in
  at once queues them inside the same process. Making that robust means pulling the
  job queue out (Redis + worker), which the demo doesn't need.

## Testing without starting the service

From the project root:

```bash
# run the whole chain and write to RDS
npm run ig -- "https://www.instagram.com/p/XXXX/"

# analysis only — print every row that would go to RDS, without writing to the DB
npm run ig -- "https://www.instagram.com/reel/XXXX/" --no-db
```

(The URL's query string is stripped automatically; no need to clean off `?igsh=` /
`?stkn=` first.)

`--no-db` prints `rows`, where each row looks like this:

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

The keys are the `fashion_items` column names, and `db_writer.write_items()` INSERTs
them as-is. Only two are display stand-ins: `embedding_dim` is really `embedding`
(1024 floats, unreadable when printed) and `image_bytes` is really `image_data` (bytea).

`title` / `price_twd` / `product_url` are product-side columns and are always `null`
for IG items; conversely `display_tags` / `outfit_tags` / `instagram_*` / `shortcode` /
`timestamp` are IG-only and are `null` on the product side.

How `source_item_id` is built (`build_source_item_id` in `pipeline.py`):

```
post: <shortcode>_p<image index>_<garment index>_<category>
reel: <shortcode>_t<second>_<garment index>_<category>
```

Re-running the same post hits the `(source, source_item_id)` unique index and upserts.

## Cost of one post

| Stage | External calls |
|-------|----------------|
| `apify` | Apify × 1 |
| `parse` | IG CDN (downloads images / video) |
| `filter` | Claude × 1 (all images in one call) |
| `analyze` | Claude Vision × N (one per image) |
| `encode` | HF × M (one per garment) |
| `write` | RDS |

One Reel can mean a dozen-plus Claude Vision calls. `GARMENT_DEDUP_THRESHOLD`
(default 0.82) drops garments whose descriptions are too similar before the encode
stage; set it to 0 to turn that off.

## Environment variables

All of them live in `../.env` (shared with Next.js). The pipeline uses:

```
APIFY_TOKEN, ANTHROPIC_API_KEY, HF_TOKEN,
DB_HOST, DB_PORT, DB_NAME, DB_USER, DB_PASSWORD, DB_SSLMODE,
FASHION_TABLE, PIPELINE_TOKEN, ALLOWED_ORIGINS, GARMENT_DEDUP_THRESHOLD
```

`PIPELINE_OUTPUT_DIR` changes where temporary images / videos go; it defaults to
`pipeline/outputs/`.

If products live on a different RDS instance you also need `PRODUCTS_DB_HOST` /
`_PORT` / `_NAME` / `_USER` / `_PASSWORD` / `_SSLMODE` plus `PRODUCTS_TABLE`.
`db_reader.get_connection()` is the IG instance and `get_products_connection()` is the
products one; without `PRODUCTS_DB_HOST` the latter falls back to the former.
