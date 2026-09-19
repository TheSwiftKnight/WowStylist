#!/usr/bin/env node
// 快取覆蓋率報告：node scripts/style-kb/report.mjs
import "./lib/env.mjs";
import fs from "node:fs/promises";
import { PATHS, CRAWL } from "./config.mjs";
import { loadKb } from "./lib/store.mjs";
import { GENERIC } from "./lib/vocab.mjs";

const styles = JSON.parse(await fs.readFile(PATHS.styles, "utf8"));
const kb = await loadKb();

if (kb.length === 0) {
  console.log(`KB 是空的：${PATHS.kb} 還沒有任何紀錄。`);
  try {
    const dry = (await fs.readFile(PATHS.outDir + "/dry_hits.jsonl", "utf8")).split("\n").filter(Boolean).map(JSON.parse);
    if (dry.length === 0) throw new Error("empty");
    const byDomain = {};
    for (const d of dry) byDomain[d.domain] = (byDomain[d.domain] || 0) + 1;
    console.log(`\n有 dry-run 結果：${dry.length} 筆網址，${new Set(dry.map((d) => d.style)).size} 個風格，` +
                `其中 ${dry.filter((d) => d.has_text).length} 篇 Exa 已帶內文。`);
    console.log("來源分布：", byDomain);
    console.log(`\n要真的建 KB：node scripts/style-kb/crawl.mjs --limit 5`);
  } catch {
    console.log(`先跑 node scripts/style-kb/crawl.mjs --dry --limit 10 看搜尋命中率。`);
  }
  process.exit(0);
}

const byStyle = new Map();
for (const r of kb) byStyle.set(r.style, [...(byStyle.get(r.style) || []), r]);

const rows = styles.map((s) => {
  const rs = byStyle.get(s.key) || [];
  const descLen = rs.flatMap((r) => Object.values(r.items || {}).map((i) => (i.description || "").length));
  return {
    style: s.key, zh: s.zh, lang: s.lang,
    outfits: rs.length,
    滿額: rs.length >= CRAWL.outfitsPerStyle ? "✓" : "",
    平均描述字數: descLen.length ? Math.round(descLen.reduce((a, b) => a + b, 0) / descLen.length) : "-",
    有do: rs.filter((r) => r.do?.length).length,
    文章數: new Set(rs.map((r) => r.source_url)).size,
    domains: [...new Set(rs.map((r) => r.source_domain))].join(","),
  };
});
console.table(rows);

const covered = rows.filter((r) => r.outfits > 0).length;
const full = rows.filter((r) => r.outfits >= CRAWL.outfitsPerStyle).length;
const domainCount = {}, catCount = {};
let cv = 0, cg = 0, co = 0;
const oovSamples = new Set();
for (const r of kb) {
  domainCount[r.source_domain] = (domainCount[r.source_domain] || 0) + 1;
  for (const it of Object.values(r.items || {})) {
    catCount[it.category] = (catCount[it.category] || 0) + 1;
    if (it.category_status === "vocab") cv++;
    else if (it.category_status === "generic" || GENERIC.has(it.category)) cg++;
    else { co++; oovSamples.add(it.category); }
  }
}
const tot = cv + cg + co || 1;

console.log("\n── 摘要 ──");
console.log(`風格覆蓋：${covered}/${styles.length}　湊滿 ${CRAWL.outfitsPerStyle} 套的：${full}/${styles.length}`);
console.log(`總套數：${kb.length}，來自 ${new Set(kb.map((r) => r.source_url)).size} 篇文章` +
            `（平均一篇 ${(kb.length / Math.max(new Set(kb.map((r) => r.source_url)).size, 1)).toFixed(1)} 套）`);
console.log("來源分布：", domainCount);
console.log(`品類命中受控詞彙表：${cv}/${tot}（${((cv / tot) * 100).toFixed(0)}%）| 太籠統 ${cg} | 詞彙表外 ${co}`);
if (oovSamples.size) console.log("詞彙表外範例：", [...oovSamples].slice(0, 15).join(", "));
console.log("最常出現的品類：", Object.entries(catCount).sort((a, b) => b[1] - a[1]).slice(0, 12)
  .map(([k, v]) => `${k}(${v})`).join(" "));

console.log("\n── 抽樣 ──");
for (const r of kb.slice(0, 5)) {
  console.log(`\n[${r.style}] ${r.outfit_text}`);
  for (const [slot, it] of Object.entries(r.items || {}))
    console.log(`   ${slot.padEnd(7)} ${it.category.padEnd(20)} ${it.description}`);
}

try {
  const misses = (await fs.readFile(PATHS.misses, "utf8")).split("\n").filter(Boolean).map(JSON.parse);
  const byReason = {};
  for (const m of misses) { const k = `${m.stage}:${String(m.reason).slice(0, 40)}`; byReason[k] = (byReason[k] || 0) + 1; }
  console.log("\n未命中原因：", byReason);
} catch {}
