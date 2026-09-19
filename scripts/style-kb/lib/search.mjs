// 搜尋層。三種 provider，介面一樣：searchStyle(style) -> [{url,title,publishedDate,text?}]
//
// 為什麼不自己 google / 爬站內搜尋：
//   whowhatwear.com/search 和 dappei.com/search 在 robots.txt 都是 Disallow，
//   繞過去等於明知故犯。文章頁本身是允許抓的，所以「找網址」交給搜尋 API，
//   「抓內文」自己來。
import { postJson } from "./http.mjs";
import { DOMAINS, QUERY, CRAWL, EXTRACT } from "../config.mjs";

// 比送進 LLM 的上限多留一點餘裕，讓截斷發生在我們這邊而不是 Exa
const EXA_TEXT_CHARS = Math.round(EXTRACT.maxArticleChars * 1.5);

function sinceISO() {
  const d = new Date();
  d.setMonth(d.getMonth() - CRAWL.sinceMonths);
  return d.toISOString().slice(0, 19) + "Z";
}

async function exa(style) {
  const key = process.env.EXA_API_KEY;
  if (!key) throw new Error("缺 EXA_API_KEY");
  const data = await postJson(
    "https://api.exa.ai/search",
    {
      query: QUERY[style.lang](style),
      type: "auto",
      numResults: CRAWL.resultsPerStyle,
      includeDomains: DOMAINS[style.lang],
      startPublishedDate: sinceISO(),
      // 直接跟 Exa 要內文，而且限長 —— 抓回來就能餵 LLM，省掉每篇一次 HTTP 往返。
      // livecrawl "fallback" = 優先吃 Exa 的快取（快很多），沒有才現爬。
      livecrawl: "fallback",
      contents: { text: { maxCharacters: EXA_TEXT_CHARS } },
    },
    { "x-api-key": key },
  );
  return (data.results || []).map((r) => ({
    url: r.url,
    title: r.title,
    publishedDate: r.publishedDate || null,
    text: r.text || null, // Exa 已經給內文，抓不到原頁時可以當 fallback
  }));
}

async function serper(style) {
  const key = process.env.SERPER_API_KEY;
  if (!key) throw new Error("缺 SERPER_API_KEY");
  const sites = DOMAINS[style.lang].map((d) => `site:${d}`).join(" OR ");
  const data = await postJson(
    "https://google.serper.dev/search",
    { q: `${QUERY[style.lang](style)} (${sites})`, num: CRAWL.resultsPerStyle,
      gl: style.lang === "zh" ? "tw" : "us", hl: style.lang === "zh" ? "zh-tw" : "en" },
    { "X-API-KEY": key },
  );
  return (data.organic || []).map((r) => ({
    url: r.link, title: r.title, publishedDate: r.date || null, text: null,
  }));
}

async function brave(style) {
  const key = process.env.BRAVE_API_KEY;
  if (!key) throw new Error("缺 BRAVE_API_KEY");
  const sites = DOMAINS[style.lang].map((d) => `site:${d}`).join(" OR ");
  const q = encodeURIComponent(`${QUERY[style.lang](style)} (${sites})`);
  const res = await fetch(
    `https://api.search.brave.com/res/v1/web/search?q=${q}&count=${CRAWL.resultsPerStyle}`,
    { headers: { "X-Subscription-Token": key, accept: "application/json" } },
  );
  if (!res.ok) throw new Error(`brave HTTP ${res.status}`);
  const data = await res.json();
  return (data.web?.results || []).map((r) => ({
    url: r.url, title: r.title, publishedDate: r.age || null, text: null,
  }));
}

const PROVIDERS = { exa, serper, brave };

export async function searchStyle(style, provider = "exa") {
  const fn = PROVIDERS[provider];
  if (!fn) throw new Error(`未知的 provider: ${provider}`);
  const results = await fn(style);
  const allow = new Set(DOMAINS[style.lang]);
  const seen = new Set();
  return results.filter((r) => {
    if (!r.url) return false;
    let h;
    try { h = new URL(r.url).hostname.replace(/^www\./, ""); } catch { return false; }
    if (![...allow].some((d) => h === d || h.endsWith(`.${d}`))) return false;
    if (seen.has(r.url)) return false;
    seen.add(r.url);
    return !/\/(tag|tags|category|search|author|topic)\//.test(r.url); // 濾掉列表頁
  });
}
