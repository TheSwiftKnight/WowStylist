#!/usr/bin/env node
// 用同一篇文章比較不同模型的速度與產出品質，再決定預設用哪個。
//
//   node scripts/style-kb/bench.mjs balletcore                     # 用 KB 裡該風格的第一篇來源
//   node scripts/style-kb/bench.mjs balletcore "https://..."       # 指定文章
//   node scripts/style-kb/bench.mjs balletcore --models a:free,b:free
//
// 每個模型各打一次，依序跑（避免互相排隊干擾）。一輪 = 候選數 × 1 次配額。
import "./lib/env.mjs";
import fs from "node:fs/promises";
import { PATHS, EXTRACT, CRAWL } from "./config.mjs";
import { getHtml } from "./lib/http.mjs";
import { parseArticle } from "./lib/article.mjs";
import { extractOutfits, buildRecord, validateOutfit, setModel } from "./lib/extract.mjs";
import { loadKb } from "./lib/store.mjs";

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(`--${n}`); return i === -1 ? d : args[i + 1]; };
const positional = args.filter((a, i) => !a.startsWith("--") && !(i > 0 && args[i - 1].startsWith("--")));
const [styleKey, urlArg] = positional;

if (!styleKey) { console.error("用法：node scripts/style-kb/bench.mjs <style_key> [url] [--models a,b]"); process.exit(1); }
if (!process.env.OPENROUTER_API_KEY) { console.error("需要 OPENROUTER_API_KEY"); process.exit(1); }

const styles = JSON.parse(await fs.readFile(PATHS.styles, "utf8"));
const style = styles.find((s) => s.key === styleKey);
if (!style) { console.error(`styles.json 裡沒有 ${styleKey}`); process.exit(1); }

let url = urlArg;
if (!url) {
  const kb = await loadKb();
  url = kb.find((r) => r.style === styleKey)?.source_url;
  if (!url) { console.error(`KB 裡沒有 ${styleKey} 的紀錄，請直接給一個網址`); process.exit(1); }
  console.log(`（用 KB 裡的來源）${url}`);
}

const got = await getHtml(url);
if (!got.html) { console.error("抓不到文章：", got.skipped); process.exit(1); }
const article = { ...parseArticle(got.html, url), url };
console.log(`文章：${article.title}`);
console.log(`內文 ${article.text.length} 字，送進 LLM 的上限 ${EXTRACT.maxArticleChars} 字`);
console.log(`目標 ${CRAWL.outfitsPerStyle} 套 / reasoning=${EXTRACT.reasoningEffort || "(不帶)"} / timeout=${EXTRACT.timeoutMs / 1000}s\n`);

const models = (opt("models") || "").split(",").filter(Boolean);
const list = models.length ? models : EXTRACT.benchModels;

const rows = [];
for (const m of list) {
  setModel(m);
  process.stdout.write(`${m.padEnd(46)} `);
  const t0 = Date.now();
  try {
    const out = await extractOutfits({ style, article, provider: "openrouter", want: CRAWL.outfitsPerStyle });
    const secs = (Date.now() - t0) / 1000;
    const outfits = out.data?.outfits || [];
    const valid = outfits.filter((o) => validateOutfit(buildRecord(o, style, out.data)).ok);
    const descLens = valid.flatMap((o) => Object.values(buildRecord(o, style, out.data).items).map((i) => i.description.length));
    rows.push({
      model: m, 秒: secs.toFixed(1), 回幾套: outfits.length, 合格: valid.length,
      每秒產出: (valid.length / secs).toFixed(3),
      平均描述字數: descLens.length ? Math.round(descLens.reduce((a, b) => a + b, 0) / descLens.length) : 0,
      out_tokens: out.usage?.completion_tokens ?? out.usage?.output_tokens ?? "?",
    });
    console.log(`${secs.toFixed(1)}s  回 ${outfits.length} 套，合格 ${valid.length}`);
    if (valid[0]) {
      const r = buildRecord(valid[0], style, out.data);
      console.log(`   ↳ ${r.items.top?.category} / ${r.items.bottom?.category} — ${r.items.top?.description?.slice(0, 80)}`);
    }
  } catch (e) {
    rows.push({ model: m, 秒: ((Date.now() - t0) / 1000).toFixed(1), 回幾套: "—", 合格: 0, 每秒產出: "0", 平均描述字數: 0, out_tokens: "—" });
    console.log(`✗ ${e.message.slice(0, 110)}`);
  }
}

console.log("\n── 比較（每秒產出越高越好）──");
console.table(rows.sort((a, b) => Number(b.每秒產出) - Number(a.每秒產出)));
console.log(`\n選好之後寫進 .env：KB_EXTRACT_MODEL=<slug>`);
console.log(`或單次覆寫：node scripts/style-kb/crawl.mjs --llm-model <slug>`);
