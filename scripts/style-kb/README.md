# Style KB — 穿搭公式快取

把「風格詞 → 文章 → 結構化穿搭」跑成離線快取。
Demo 當下：命中快取 = 瞬間回答；沒命中 = 同一條 pipeline 即時跑一遍。

```
50 個風格詞 ──▶ Exa 搜尋(含內文) ──▶ 抽 N 套穿搭(LLM) ──▶ style_kb.jsonl
                  只找白名單域名        一篇可出多套        一套 = 一行
                                        湊滿 5 套就停
```

**一行 JSONL = 一套穿搭**，不是一篇文章。每個風格湊滿 `outfitsPerStyle`（預設 5）套就不再往下讀。

---

## 0. 前提：為什麼不自己 Google、不爬站內搜尋

`whowhatwear.com/search` 和 `dappei.com/search` 在 robots.txt 都是 Disallow（實測回
ROBOTS_DISALLOWED）。文章頁本身沒被擋。所以「找網址」交給搜尋 API。

而且 Exa 一個 call 就把**內文一起回來**，所以預設連原頁都不用抓
（`CRAWL.preferSearchText`）—— 這省掉每篇一次 HTTP 往返、robots 檢查和 rate limit 等待。
需要原頁 HTML 時加 `--refetch`。

## 1. 安裝

```bash
npm i cheerio json5
```

## 2. 金鑰（寫進 .env）

```bash
# 抽取層 — 預設就是這個
OPENROUTER_API_KEY=sk-or-v1-...
KB_LLM_PROVIDER=openrouter                # 預設值，可省略
KB_EXTRACT_MODEL=                         # 空 = deepseek/deepseek-v4-flash-0731:free

# 搜尋層（三選一，Exa 最推薦：一個 call 搜尋+內文）
EXA_API_KEY=...        # $7/1k 次，註冊送 $20 + 每月 $10
SERPER_API_KEY=...     # $1.65/1k，只回網址，內文要自己抓
BRAVE_API_KEY=...      # 免費層 2000 次/月
```

## 3. 指令

```bash
# ① 只跑搜尋層：看命中率、看幾篇 Exa 有帶內文（不抓不抽不寫 KB）
node scripts/style-kb/crawl.mjs --dry --limit 10

# ② 小規模實跑
node scripts/style-kb/crawl.mjs --limit 5

# ③ 全量預熱
node scripts/style-kb/crawl.mjs

# ④ 其他
node scripts/style-kb/crawl.mjs --lang zh              # 只跑中文那 15 個
node scripts/style-kb/crawl.mjs --style balletcore,y2k
node scripts/style-kb/crawl.mjs --outfits 3            # 每個風格只要 3 套
node scripts/style-kb/crawl.mjs --concurrency 5        # 同時跑幾個風格
node scripts/style-kb/crawl.mjs --refetch              # 不用 Exa 內文，強制抓原頁
node scripts/style-kb/crawl.mjs --llm openai

# ⑤ 單篇除錯（不用搜尋 API）
node scripts/style-kb/try-one.mjs cottagecore "https://www.whowhatwear.com/..." --outfits 5

# ⑥ 覆蓋率報告
node scripts/style-kb/report.mjs

# ⑦ 比較模型速度（同一篇文章打不同模型，選出最划算的）
node scripts/style-kb/bench.mjs balletcore
```

### 續跑

重跑會自動接續：已經滿 5 套的風格直接跳過，讀過的文章不重讀，重複的搭配（同 style +
同 top/bottom + 同 outfit_text）會被 dedup。所以中斷了直接再跑一次就好。

---

## 4. 產出格式

`data/style-kb/style_kb.jsonl`，一行一套：

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

已移除：`gender`、`avoid`、`brands_mentioned`、`product_links`、`formula` 的
outer/shoes/bag/accessory（那些資訊現在融進 `description` 和 `outfit_text`）。

### 規則

1. `items` 只有 **top** 和 **bottom**，兩個都必填 —— 缺一個就不算一套，直接拒收。
2. `category` 必須來自 `lib/vocab.mjs` 的受控詞彙表，snake_case，**不帶顏色材質品牌**。
   抽完會過 `normalizeCategory()`：`"long sleeve tee"`→`long_sleeve_tee`、
   `"Trousers"`→`trousers`、`"flats"`→`ballet_flats`。結果記在 `category_status`：

   | status | 意思 | 處理 |
   |---|---|---|
   | `vocab` | 命中詞彙表 | 正常收 |
   | `generic` | 退回籠統值（coat / pants / top…） | 收，但 report 單獨統計 |
   | `oov` | 詞彙表外 | 超過一半就整套丟掉 |

3. `description` 是**一句英文自然語言**，把顏色、材質、版型、氛圍全寫進去。
   這句是向量檢索的主要載體，所以要具體可檢索，太短（< 15 字）會被拒收。
4. `do` 繁體中文祈使句、每條 20 字內，必須來自文章真的有給的建議。至少一條。
5. 文章沒描述的不要編造。腦補的搭配會讓下游推薦出沒根據的商品。
6. 收錄門檻（`config.mjs` 的 `ACCEPT`）：top+bottom 齊全、description ≥ 15 字、
   `confidence ≥ 0.5`、至少一條 `do`、oov 比例 ≤ 0.5、有 `outfit_text`。
   不過就丟進 `misses.jsonl`。

### 向量檢索的三層文字

| 欄位 | 粒度 | 用途 |
|---|---|---|
| `items.<slot>.description` | 單品 | 查商品庫 / 單品 embedding |
| `outfit_text` | 一套 | 整體搭配相似度 |
| `embed_text` | 風格語意 | 使用者打「想要帥一點的戶外感」時比對這個 |

`category` 則是結構化過濾條件，跟向量分數搭配用。

---

## 5. 接下游

```js
// 1) 結構化過濾 + 向量排序
for (const [slot, it] of Object.entries(rec.items)) {
  const candidates = await products.findMany({ where: { category: it.category } });
  picks[slot] = (await vectorSearch(it.description, candidates))[0];
}

// 2) 模糊查詢先找風格，再走 1)
const style = await vectorSearch(userQuery, kb.map(r => r.embed_text));
```

---

## 6. 速度

Nemotron 550B free 一次呼叫 1–2 分鐘，所以**減少呼叫次數比什麼都重要**。目前的設計：

| 手段 | 在哪 | 效果 |
|---|---|---|
| 一次抽 N 套 | `extractOutfits(want)` | 最有效。一篇出 5 套 = 1 次呼叫抵 5 次 |
| 湊滿就停 | `crawl.mjs` 早退 | 好文章命中時，一個風格只要 1 次呼叫 |
| 不抓原頁 | `CRAWL.preferSearchText` | 每篇省一次 HTTP 往返（Exa 已帶內文） |
| 風格之間平行 | `--concurrency` | 預設 3；同風格內仍依序，早退才停得準 |
| 砍短內文 | `EXTRACT.maxArticleChars` | 預設 9000 字，input token 直接影響延遲 |
| 降 reasoning | `EXTRACT.reasoningEffort` | 預設 `low`；填欄位不需要長考 |
| 磁碟快取 | `data/style-kb/cache/` | 只在 `--refetch` 時才用得到 |
| 足夠的 timeout | `EXTRACT.timeoutMs` | **最容易踩的坑，見下** |

### ⚠️ timeout 設太小會變成三倍慢

原本 timeout 是 120 秒，但 Nemotron free 單次呼叫 1–3 分鐘很正常。超過就被 abort →
自動重打 → 再等一輪。實測日誌裡的 `342.1s` 其實是
`120(abort) + 2 + 120(abort) + 4 + 96(成功)`：**打了 3 次 API、燒 3 倍配額、白等 240 秒**。

現在 timeout 拉到 300 秒，而且**逾時預設不重試**（重打只會再等一輪，配額照算）。
同一批工作應該會從「動輒 180–340 秒」收斂到「一次 60–120 秒」。

### 換模型

Nemotron Ultra 是 550B reasoning model，慢是它的天性。同一把 OpenRouter key 可以直接打
別的免費模型，`bench.mjs` 會用同一篇文章比較速度與合格套數：

```bash
node scripts/style-kb/bench.mjs balletcore
# 選好之後
echo 'KB_EXTRACT_MODEL=<slug>' >> .env
# 或單次
node scripts/style-kb/crawl.mjs --llm-model google/gemma-4-26b-a4b-it:free
```

候選清單在 `config.mjs` 的 `EXTRACT.benchModels`（都支援 tool calling、都是免費層）。

2026-09-20 實測（同一篇 balletcore 文章，目標 5 套）：

| 模型 | 秒 | 回/合格 | 備註 |
|---|---|---|---|
| `deepseek/deepseek-v4-flash-0731:free` | 92.1 | 4 / 4 | **現行預設** |
| `nvidia/nemotron-3.5-lightning:free` | 166.7 | 2 / 2 | |
| `nvidia/nemotron-3-ultra-550b-a55b:free` | 226.4 | 3 / 3 | 舊預設 |
| `google/gemma-4-26b-a4b-it:free` | — | — | provider 回 429 |
| `nvidia/nemotron-3-super-120b-a12b:free` | — | — | provider 直接回錯誤 |
| `inclusionai/ling-3.0-flash-vl:free` | 76.2 | 1 / 0 | 輸出撞 max_tokens |

再更快的話：

```bash
# 加大平行 + 關掉 reasoning + 更短內文
KB_CONCURRENCY=6 KB_REASONING_EFFORT="" KB_ARTICLE_CHARS=6000 node scripts/style-kb/crawl.mjs

# 換更快的模型（Nemotron free 的瓶頸是模型本身，不是我們的程式）
KB_EXTRACT_MODEL=openai/gpt-oss-120b node scripts/style-kb/crawl.mjs
```

⚠️ OpenRouter 免費層 **200 req/day**。改成一次抽 5 套之後，50 個風格大約只要
50–100 次呼叫，配額變得很寬裕。

## 7. 排錯

每讀完一篇會印一行（`✓ whowhatwear.com 回 5 套 → 收 4（累計 4/5）42.1s`）。
失敗原因寫進 `misses.jsonl`，抽取失敗會把**原始回應**丟到 `data/style-kb/debug/`。

| miss reason | 意思 | 怎麼辦 |
|---|---|---|
| `Expected ... in JSON at position N` | 模型吐的不是合法 JSON | 已處理：`lib/json.mjs` 用 JSON5 + 括號平衡掃描硬解 |
| `output_truncated` | `finish_reason=length`，JSON 被砍斷 | 調高 `EXTRACT.maxTokens`，或 `--outfits 3` 讓輸出短一點 |
| `missing_bottom` / `missing_top` | 只抽到半套 | 正常拒收，多半是單品清單型文章 |
| `top_description_too_short` | 模型敷衍 | 累積很多的話把 prompt 的範例句再寫具體 |
| `oov_categories` | 品類不在詞彙表 | 看 report 的 OOV 範例，補進 `lib/vocab.mjs` 的 `SYNONYMS` |
| `text_too_short_N` | 內文沒抓到 | Exa 沒帶 text 且原頁是 JS 渲染；反覆失敗的網域考慮移出 `DOMAINS` |
| `HTTP 429` | 撞到日限 | 自動退避重試；滿了隔天再跑，已抓的會跳過 |

## 8. Demo 當天

- 事前：`node scripts/style-kb/crawl.mjs` 全量預熱
- 現場：沒命中的詞走同一條 pipeline 即時跑（Exa ~2s + 一次 LLM ~60s）
- 建議把 `runStyle()` 抽成可匯入的函式給 API route 用，cache miss 時呼叫它並寫回 KB ——
  用一次就多一筆快取
