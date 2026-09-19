#!/usr/bin/env node
// 拿單一網址測 parse + 抽取這半條 pipeline（不用搜尋 API）。
//
//   node scripts/style-kb/try-one.mjs cottagecore "https://www.whowhatwear.com/..."
//   node scripts/style-kb/try-one.mjs cottagecore <url> --save --outfits 5 --llm openai
import "./lib/env.mjs";
import fs from "node:fs/promises";
import { PATHS, CRAWL } from "./config.mjs";
import { getHtml } from "./lib/http.mjs";
import { parseArticle } from "./lib/article.mjs";
import { extractOutfits, buildRecord, validateOutfit } from "./lib/extract.mjs";
import { appendRecord } from "./lib/store.mjs";

const args = process.argv.slice(2);
const VALUED = new Set(["outfits", "llm"]);        // 這些旗標後面跟著值
const BOOL = new Set(["save"]);
const opts = {};
const positional = [];
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (!a.startsWith("--")) { positional.push(a); continue; }
  const name = a.slice(2);
  if (VALUED.has(name)) opts[name] = args[++i];
  else if (BOOL.has(name)) opts[name] = true;
}
const [styleKey, url] = positional;
const opt = (n, d) => opts[n] ?? d;
if (!styleKey || !url) { console.error("用法：node scripts/style-kb/try-one.mjs <style> <url> [--save] [--outfits N] [--llm p]"); process.exit(1); }

const styles = JSON.parse(await fs.readFile(PATHS.styles, "utf8"));
const style = styles.find((s) => s.key === styleKey);
if (!style) { console.error(`styles.json 裡沒有 ${styleKey}`); process.exit(1); }

const got = await getHtml(url);
if (!got.html) { console.error("抓不到：", got.skipped); process.exit(1); }
const article = { ...parseArticle(got.html, url), url };
console.log(`${got.fromCache ? "(磁碟快取)" : "(實際下載)"} ${article.title} | ${article.published} | 內文 ${article.text.length} 字\n`);

const t0 = Date.now();
const out = await extractOutfits({ style, article, provider: opt("llm", null), want: Number(opt("outfits", CRAWL.outfitsPerStyle)) });
console.log(`LLM ${((Date.now() - t0) / 1000).toFixed(1)}s，回了 ${out.data?.outfits?.length ?? 0} 套，用量：`, out.usage, "\n");

let n = 0;
for (const o of out.data?.outfits || []) {
  const rec = buildRecord(o, style, out.data);
  const v = validateOutfit(rec);
  console.log(`── 第 ${++n} 套 ── ${v.ok ? "✓ 通過" : "✗ " + v.reason}`);
  for (const [slot, it] of Object.entries(rec.items))
    console.log(`   ${slot.padEnd(7)} ${it.category.padEnd(20)} [${it.category_status}] ${it.description}`);
  console.log(`   outfit_text: ${rec.outfit_text}`);
  console.log(`   do: ${rec.do.join("／")}`);
  console.log(`   palette: ${rec.palette.join(" ")} | ${rec.palette_names.join(", ")}`);
  if (v.ok && opt("save", false)) {
    await appendRecord({ ...rec, source_url: url, source_domain: article.sourceDomain,
      source_title: article.title, published: article.published, lang: style.lang,
      fetched_at: new Date().toISOString().slice(0, 10) });
    console.log("   → 已寫入 KB");
  }
}
