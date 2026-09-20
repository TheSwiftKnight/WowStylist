# Style KB — outfit-formula cache

Turns "style keyword → article → structured outfit" into an offline cache.
During the demo: cache hit = instant answer; cache miss = the same pipeline runs live.

```
50 style keywords ──▶ Exa search (with text) ──▶ extract N outfits (LLM) ──▶ style_kb.jsonl
                      whitelisted domains only    one article can yield several    one outfit = one line
                                                  stops once 5 outfits are collected
```

**One JSONL line = one outfit**, not one article. Once a style has collected
`outfitsPerStyle` outfits (default 5), it stops reading further.

---

## 0. Background: why not Google it ourselves, why not scrape on-site search

`whowhatwear.com/search` and `dappei.com/search` are both Disallow in robots.txt
(confirmed — they return ROBOTS_DISALLOWED). The article pages themselves aren't
blocked. So "finding URLs" is delegated to a search API.

On top of that, a single Exa call **returns the article text as well**, so by default
we never fetch the original page (`CRAWL.preferSearchText`) — that saves one HTTP
round trip, a robots check and a rate-limit wait per article. Add `--refetch` when
you do need the original HTML.

## 1. Install

```bash
npm i cheerio json5
```

## 2. Keys (put them in .env)

```bash
# extraction layer — this is the default
OPENROUTER_API_KEY=sk-or-v1-...
KB_LLM_PROVIDER=openrouter                # default, can be omitted
KB_EXTRACT_MODEL=                         # empty = deepseek/deepseek-v4-flash-0731:free

# search layer (pick one; Exa recommended — search + text in one call)
EXA_API_KEY=...        # $7/1k calls, $20 on signup + $10/month
SERPER_API_KEY=...     # $1.65/1k, URLs only, you fetch the text yourself
BRAVE_API_KEY=...      # free tier, 2000 calls/month
```

## 3. Commands

```bash
# 1) search layer only: check hit rate and how many Exa results carry text
#    (no fetching, no extraction, nothing written to the KB)
node scripts/style-kb/crawl.mjs --dry --limit 10

# 2) small real run
node scripts/style-kb/crawl.mjs --limit 5

# 3) full warm-up
node scripts/style-kb/crawl.mjs

# 4) everything else
node scripts/style-kb/crawl.mjs --lang zh              # only the 15 Chinese styles
node scripts/style-kb/crawl.mjs --style balletcore,y2k
node scripts/style-kb/crawl.mjs --outfits 3            # only 3 outfits per style
node scripts/style-kb/crawl.mjs --concurrency 5        # how many styles run at once
node scripts/style-kb/crawl.mjs --refetch              # ignore Exa text, force-fetch the page
node scripts/style-kb/crawl.mjs --llm openai

# 5) single-article debugging (no search API needed)
node scripts/style-kb/try-one.mjs cottagecore "https://www.whowhatwear.com/..." --outfits 5

# 6) coverage report
node scripts/style-kb/report.mjs

# 7) compare model speed (same article across models, pick the best value)
node scripts/style-kb/bench.mjs balletcore
```

### Resuming

Re-runs resume automatically: styles that already have 5 outfits are skipped,
articles that were already read aren't re-read, and duplicate outfits (same style +
same top/bottom + same outfit_text) are deduped. So if a run is interrupted, just
run it again.

---

## 4. Output format

`data/style-kb/style_kb.jsonl`, one outfit per line:

```json
{
  "style": "cottagecore",
  "style_zh": "田園風",
  "aliases": ["cottage core", "鄉村風"],
  "style_present": true,
  "items": {
    "top": {
      "category": "long_sleeve_tee",
      "description": "A cream long-sleeve crochet top with a soft romantic cottagecore appearance.",
      "category_status": "vocab"
    },
    "bottom": {
      "category": "trousers",
      "description": "Cream cropped trousers with a relaxed lightweight silhouette that complements soft cottagecore styling.",
      "category_status": "vocab"
    }
  },
  "palette": ["#FFFFFF", "#FFFDD0", "#7B3F00", "#D8A7A7"],
  "palette_names": ["white", "cream", "chocolate brown", "dusty pink"],
  "fabrics": ["cotton", "silk", "raffia", "leather"],
  "do": ["搭配同色系鉤針上下身", "配極簡涼鞋平衡質感", "加入鉤針托特包呼應主題"],
  "occasion": ["夏日海邊", "城市漫步", "晚餐約會"],
  "season": ["summer"],
  "confidence": 0.7,
  "category_flags": { "vocab": 2, "generic": 0, "oov": 0 },
  "outfit_text": "cream long sleeve tee + cream cropped trousers + sandals + brown tote bag",
  "embed_text": "田園風 / cottagecore\n<outfit_text>\nwhite, cream, ...\n搭配同色系鉤針上下身；...",
  "source_url": "https://www.whowhatwear.com/fashion/trends/...",
  "source_domain": "whowhatwear.com",
  "source_title": "...",
  "published": "2026-07-29",
  "lang": "en",
  "fetched_at": "2026-09-19"
}
```

Removed: `gender`, `avoid`, `brands_mentioned`, `product_links`, and
outer/shoes/bag/accessory from `formula` (that information now folds into
`description` and `outfit_text`).

### Rules

1. `items` only has **top** and **bottom**, and both are required — missing one means
   it isn't an outfit and it's rejected outright.
2. `category` must come from the controlled vocabulary in `lib/vocab.mjs`, snake_case,
   **no colors, materials or brands**. After extraction it goes through
   `normalizeCategory()`: `"long sleeve tee"`→`long_sleeve_tee`,
   `"Trousers"`→`trousers`, `"flats"`→`ballet_flats`. The result is recorded in
   `category_status`:

   | status | Meaning | Handling |
   |---|---|---|
   | `vocab` | matched the vocabulary | accepted normally |
   | `generic` | fell back to a vague value (coat / pants / top…) | accepted, but counted separately in the report |
   | `oov` | outside the vocabulary | more than half → the whole outfit is dropped |

3. `description` is **one natural-language English sentence** that packs in color,
   material, fit and mood. This sentence is the main carrier for vector retrieval, so
   it has to be specific and searchable; anything too short (< 15 words) is rejected.
4. `do` entries are Traditional Chinese imperative sentences of at most 20 characters,
   and must come from advice the article actually gives. At least one is required.
5. Don't invent what the article doesn't describe. Made-up outfits make downstream
   recommendations suggest products with nothing behind them.
6. Acceptance thresholds (`ACCEPT` in `config.mjs`): top+bottom both present,
   description ≥ 15 words, `confidence ≥ 0.5`, at least one `do`, oov ratio ≤ 0.5,
   and `outfit_text` present. Anything that fails goes into `misses.jsonl`.

### The three text layers for vector retrieval

| Field | Granularity | Used for |
|---|---|---|
| `items.<slot>.description` | one garment | querying the product catalog / garment embeddings |
| `outfit_text` | one outfit | overall outfit similarity |
| `embed_text` | style semantics | matched when the user types something like "I want a sportier outdoor look" |

`category` is the structured filter, used alongside the vector score.

---

## 5. Hooking up downstream

```js
// 1) structured filter + vector ranking
for (const [slot, it] of Object.entries(rec.items)) {
  const candidates = await products.findMany({ where: { category: it.category } });
  picks[slot] = (await vectorSearch(it.description, candidates))[0];
}

// 2) fuzzy query: find the style first, then do 1)
const style = await vectorSearch(userQuery, kb.map(r => r.embed_text));
```

---

## 6. Speed

One Nemotron 550B free call takes 1–2 minutes, so **cutting the number of calls
matters more than anything else**. The current design:

| Technique | Where | Effect |
|---|---|---|
| Extract N outfits at once | `extractOutfits(want)` | The big one. 5 outfits from one article = 1 call instead of 5 |
| Stop once full | early exit in `crawl.mjs` | With a good article, a style needs just 1 call |
| Don't fetch the page | `CRAWL.preferSearchText` | Saves one HTTP round trip per article (Exa already carries the text) |
| Parallel across styles | `--concurrency` | Default 3; within a style it stays sequential so the early exit stays accurate |
| Truncate the article | `EXTRACT.maxArticleChars` | Default 9000 chars; input tokens directly drive latency |
| Lower reasoning | `EXTRACT.reasoningEffort` | Default `low`; filling in fields doesn't need deep thought |
| Disk cache | `data/style-kb/cache/` | Only used with `--refetch` |
| A long enough timeout | `EXTRACT.timeoutMs` | **The easiest trap — see below** |

### ⚠️ Too small a timeout makes it three times slower

The timeout used to be 120 seconds, but 1–3 minutes per call is perfectly normal for
Nemotron free. Going over meant an abort → an automatic retry → another full wait.
The `342.1s` in the real logs was actually
`120(abort) + 2 + 120(abort) + 4 + 96(success)`: **3 API calls, 3× the quota burned,
240 seconds wasted**.

The timeout is now 300 seconds, and **a timeout no longer retries by default**
(retrying only means another full wait, and the quota is charged anyway). The same
batch of work should converge from "180–340 seconds routinely" to "60–120 seconds once".

### Switching models

Nemotron Ultra is a 550B reasoning model; being slow is in its nature. The same
OpenRouter key can hit other free models directly, and `bench.mjs` compares speed and
accepted-outfit count on the same article:

```bash
node scripts/style-kb/bench.mjs balletcore
# once you've picked one
echo 'KB_EXTRACT_MODEL=<slug>' >> .env
# or just for one run
node scripts/style-kb/crawl.mjs --llm-model google/gemma-4-26b-a4b-it:free
```

The candidate list is `EXTRACT.benchModels` in `config.mjs` (all support tool calling,
all are free tier).

Measured 2026-09-20 (same balletcore article, target 5 outfits):

| Model | Seconds | Returned/accepted | Notes |
|---|---|---|---|
| `deepseek/deepseek-v4-flash-0731:free` | 92.1 | 4 / 4 | **current default** |
| `nvidia/nemotron-3.5-lightning:free` | 166.7 | 2 / 2 | |
| `nvidia/nemotron-3-ultra-550b-a55b:free` | 226.4 | 3 / 3 | old default |
| `google/gemma-4-26b-a4b-it:free` | — | — | provider returned 429 |
| `nvidia/nemotron-3-super-120b-a12b:free` | — | — | provider returned an error outright |
| `inclusionai/ling-3.0-flash-vl:free` | 76.2 | 1 / 0 | output hit max_tokens |

To go faster still:

```bash
# more parallelism + reasoning off + shorter article text
KB_CONCURRENCY=6 KB_REASONING_EFFORT="" KB_ARTICLE_CHARS=6000 node scripts/style-kb/crawl.mjs

# switch to a faster model (the bottleneck with Nemotron free is the model, not our code)
KB_EXTRACT_MODEL=openai/gpt-oss-120b node scripts/style-kb/crawl.mjs
```

⚠️ The OpenRouter free tier allows **200 req/day**. Now that we extract 5 outfits per
call, 50 styles only take about 50–100 calls, so the quota is comfortable.

## 7. Troubleshooting

Each finished article prints one line
(`✓ whowhatwear.com 回 5 套 → 收 4（累計 4/5）42.1s`).
Failure reasons go into `misses.jsonl`, and a failed extraction dumps the **raw
response** into `data/style-kb/debug/`.

| miss reason | Meaning | What to do |
|---|---|---|
| `Expected ... in JSON at position N` | the model didn't return valid JSON | already handled: `lib/json.mjs` brute-forces it with JSON5 + a bracket-balancing scan |
| `output_truncated` | `finish_reason=length`, the JSON got cut off | raise `EXTRACT.maxTokens`, or use `--outfits 3` for shorter output |
| `missing_bottom` / `missing_top` | only half an outfit was extracted | normal rejection, usually an item-listicle article |
| `top_description_too_short` | the model phoned it in | if these pile up, make the example sentences in the prompt more concrete |
| `oov_categories` | the category isn't in the vocabulary | check the OOV examples in the report and add them to `SYNONYMS` in `lib/vocab.mjs` |
| `text_too_short_N` | no article text was captured | Exa carried no text and the page is JS-rendered; consider removing repeatedly failing domains from `DOMAINS` |
| `HTTP 429` | hit the daily limit | backs off and retries automatically; if the quota is gone, run again tomorrow — what's already fetched is skipped |

## 8. Demo day

- Beforehand: `node scripts/style-kb/crawl.mjs` for a full warm-up
- On the day: keywords that miss the cache run through the same pipeline live
  (Exa ~2 s + one LLM call ~60 s)
- Suggestion: extract `runStyle()` into an importable function for the API route to
  use, calling it on a cache miss and writing the result back into the KB — every use
  adds one more cache entry
