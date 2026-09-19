#!/usr/bin/env node
// 預熱快取：每個風格湊滿 N 套穿搭，寫進 data/style-kb/style_kb.jsonl
//
//   node scripts/style-kb/crawl.mjs                      # 全部 50 個風格詞
//   node scripts/style-kb/crawl.mjs --limit 5
//   node scripts/style-kb/crawl.mjs --style balletcore,y2k
//   node scripts/style-kb/crawl.mjs --lang zh
//   node scripts/style-kb/crawl.mjs --dry               # 只做搜尋層，看命中率
//   node scripts/style-kb/crawl.mjs --outfits 3         # 每個風格只要 3 套
//   node scripts/style-kb/crawl.mjs --concurrency 5     # 同時處理幾個風格
//   node scripts/style-kb/crawl.mjs --refetch           # 不用 Exa 內文，強制抓原頁
//   node scripts/style-kb/crawl.mjs --llm openai
import "./lib/env.mjs";
import fs from "node:fs/promises";
import path from "node:path";
import { PATHS, CRAWL } from "./config.mjs";
import { searchStyle } from "./lib/search.mjs";
import { getHtml } from "./lib/http.mjs";
import { parseArticle } from "./lib/article.mjs";
import { extractOutfits, buildRecord, validateOutfit, outfitKey, pickProvider } from "./lib/extract.mjs";
import { loadKb, appendRecord, appendMiss, append } from "./lib/store.mjs";

const argv = process.argv.slice(2);
const flag = (n, d = null) => {
  const i = argv.indexOf(`--${n}`);
  if (i === -1) return d;
  const v = argv[i + 1];
  return v === undefined || v.startsWith("--") ? true : v;
};
const has = (n) => argv.includes(`--${n}`);

const provider = flag("provider", "exa");          // 搜尋層
const llm = flag("llm", null);                     // 抽取層
const dry = has("dry");
const refetch = has("refetch");
const WANT = Number(flag("outfits", CRAWL.outfitsPerStyle));
const CONC = Number(flag("concurrency", CRAWL.styleConcurrency));
const today = new Date().toISOString().slice(0, 10);
const DRY_PATH = path.join(PATHS.outDir, "dry_hits.jsonl");

const all = JSON.parse(await fs.readFile(PATHS.styles, "utf8"));
let styles = all;
if (flag("lang")) styles = styles.filter((s) => s.lang === flag("lang"));
if (flag("style")) {
  const want = String(flag("style")).split(",").map((x) => x.trim());
  styles = styles.filter((s) => want.includes(s.key));
}
if (flag("limit")) styles = styles.slice(0, Number(flag("limit")));

if (!dry) {
  try { console.log(`抽取層 provider：${pickProvider(llm)}｜每個風格目標 ${WANT} 套｜同時 ${CONC} 個風格`); }
  catch (e) { console.error(e.message); process.exit(1); }
}
if (dry) {
  await fs.mkdir(PATHS.outDir, { recursive: true });
  await fs.rm(DRY_PATH, { force: true }).catch(() => fs.writeFile(DRY_PATH, ""));
}

// 既有 KB：算出每個風格已經有幾套、哪些文章讀過、哪些搭配已存在（續跑用）
const kb = await loadKb();
const haveCount = new Map();
const readUrls = new Set();
const seenOutfits = new Set();
for (const r of kb) {
  haveCount.set(r.style, (haveCount.get(r.style) || 0) + 1);
  readUrls.add(`${r.style}\u0000${r.source_url}`);
  try { seenOutfits.add(outfitKey(r)); } catch {}
}

const stats = { styles: styles.length, llmCalls: 0, articles: 0, fromSearchText: 0, fetched: 0, cached: 0,
                kept: 0, dupes: 0, rejected: 0, tokensIn: 0, tokensOut: 0 };

/** 一個風格：依序讀文章，湊滿 WANT 套就停 */
async function runStyle(style, idx) {
  const t0 = Date.now();
  const lines = [`[${idx + 1}/${styles.length}] ${style.key} (${style.zh})`];
  const already = haveCount.get(style.key) || 0;
  let kept = 0, rejected = 0, dupes = 0, articles = 0;

  if (already >= WANT) {
    lines.push(`  → KB 已有 ${already} 套，跳過`);
    console.log(lines.join("\n"));
    return { style: style.key, kept: 0, have: already, articles: 0, note: "skipped" };
  }

  let hits;
  try {
    hits = await searchStyle(style, provider);
  } catch (e) {
    lines.push(`  ✗ 搜尋失敗：${e.message}`);
    console.log(lines.join("\n"));
    await appendMiss({ style: style.key, stage: "search", reason: e.message, at: today });
    return { style: style.key, kept: 0, have: already, articles: 0, note: "search_failed" };
  }

  if (dry) {
    for (const h of hits) {
      await append(DRY_PATH, {
        style: style.key, style_zh: style.zh, lang: style.lang, url: h.url, title: h.title || null,
        published: (h.publishedDate || "").slice(0, 10) || null,
        domain: new URL(h.url).hostname.replace(/^www\./, ""),
        has_text: Boolean(h.text), text_chars: (h.text || "").length,
        new: !readUrls.has(`${style.key}\u0000${h.url}`), at: today,
      });
    }
    const withText = hits.filter((h) => h.text).length;
    lines.push(`  → ${hits.length} hits，其中 ${withText} 篇 Exa 已帶內文（可直接抽，免抓原頁）`);
    console.log(lines.join("\n"));
    return { style: style.key, hits: hits.length, withText, kept: 0 };
  }

  let have = already;
  for (const hit of hits) {
    if (have >= WANT) break;                       // ← 湊滿就停，不再讀下一篇
    if (articles >= CRAWL.maxArticlesPerStyle) break;
    if (readUrls.has(`${style.key}\u0000${hit.url}`)) continue;
    readUrls.add(`${style.key}\u0000${hit.url}`);

    const host = new URL(hit.url).hostname.replace(/^www\./, "");
    const ta = Date.now();
    articles++; stats.articles++;

    // 內文來源：優先用 Exa 帶回來的，省掉一次 HTTP 往返
    let article;
    if (!refetch && CRAWL.preferSearchText && hit.text) {
      article = { title: hit.title, text: hit.text, published: (hit.publishedDate || "").slice(0, 10) || null,
                  sourceDomain: host, url: hit.url };
      stats.fromSearchText++;
    } else {
      const got = await getHtml(hit.url, { force: refetch });
      if (!got.html) {
        if (hit.text) {
          article = { title: hit.title, text: hit.text, published: (hit.publishedDate || "").slice(0, 10) || null,
                      sourceDomain: host, url: hit.url };
          stats.fromSearchText++;
        } else {
          lines.push(`  ✗ ${host} fetch: ${got.skipped}`);
          await appendMiss({ style: style.key, url: hit.url, stage: "fetch", reason: got.skipped, at: today });
          continue;
        }
      } else {
        if (got.fromCache) stats.cached++; else stats.fetched++;
        article = { ...parseArticle(got.html, hit.url), url: hit.url };
        article.title ||= hit.title;
        article.published ||= (hit.publishedDate || "").slice(0, 10) || null;
      }
    }

    if ((article.text || "").length < 400) {
      lines.push(`  ✗ ${host} parse: 內文只有 ${(article.text || "").length} 字`);
      await appendMiss({ style: style.key, url: hit.url, stage: "parse", reason: `text_too_short_${(article.text || "").length}`, at: today });
      continue;
    }

    let out;
    try {
      stats.llmCalls++;
      out = await extractOutfits({ style, article, provider: llm, want: WANT - have });
    } catch (e) {
      lines.push(`  ✗ ${host} extract: ${e.message.slice(0, 100)}`);
      await appendMiss({ style: style.key, url: hit.url, stage: "extract", reason: e.message, at: today });
      continue;
    }
    stats.tokensIn += out.usage?.prompt_tokens || out.usage?.input_tokens || 0;
    stats.tokensOut += out.usage?.completion_tokens || out.usage?.output_tokens || 0;

    const outfits = Array.isArray(out.data?.outfits) ? out.data.outfits : [];
    let gotHere = 0;
    for (const o of outfits) {
      if (have >= WANT) break;
      const rec = buildRecord(o, style, out.data);
      const v = validateOutfit(rec);
      if (!v.ok) { rejected++; await appendMiss({ style: style.key, url: hit.url, stage: "validate", reason: v.reason, at: today }); continue; }
      const k = outfitKey(rec);
      if (seenOutfits.has(k)) { dupes++; continue; }
      seenOutfits.add(k);
      await appendRecord({
        ...rec,
        source_url: hit.url, source_domain: article.sourceDomain, source_title: article.title,
        published: article.published, lang: style.lang, fetched_at: today,
      });
      have++; kept++; gotHere++;
    }
    lines.push(`  ✓ ${host.padEnd(20)} 回 ${outfits.length} 套 → 收 ${gotHere}（累計 ${have}/${WANT}）${((Date.now() - ta) / 1000).toFixed(1)}s`);
  }

  stats.kept += kept; stats.rejected += rejected; stats.dupes += dupes;
  lines.push(`  → ${have}/${WANT} 套，讀了 ${articles} 篇，重複 ${dupes}，不合格 ${rejected}（${((Date.now() - t0) / 1000).toFixed(1)}s）`);
  console.log(lines.join("\n"));
  return { style: style.key, kept, have, articles, dupes, rejected };
}

/** 風格之間平行；同一個風格內依序（才停得準） */
async function pool(items, n, fn) {
  const out = new Array(items.length);
  let idx = 0;
  await Promise.all(Array.from({ length: Math.max(1, Math.min(n, items.length)) }, async () => {
    while (true) {
      const i = idx++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  }));
  return out;
}

const T0 = Date.now();
const perStyle = await pool(styles, dry ? 6 : CONC, runStyle);

console.log("\n── 總計 ──");
console.table(perStyle.filter(Boolean));
console.log({ ...stats, 耗時秒: ((Date.now() - T0) / 1000).toFixed(0) });
if (stats.llmCalls) console.log(`平均每次 LLM 呼叫產出 ${(stats.kept / stats.llmCalls).toFixed(2)} 套`);

if (dry) {
  console.log(`\n[dry-run] 只跑了搜尋層，沒有抓文章、沒有呼叫 LLM、沒有寫 KB。`);
  console.log(`找到的網址清單 → ${DRY_PATH}`);
} else {
  console.log(`\nKB → ${PATHS.kb}`);
  console.log(`未命中紀錄 → ${PATHS.misses}`);
}
