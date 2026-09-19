// 帶 robots.txt 檢查、rate limit、磁碟快取的 fetch。
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { CRAWL, PATHS } from "../config.mjs";

const hostQueue = new Map(); // host -> Promise 鏈（真的序列化，並行時才擋得住）
const robotsCache = new Map(); // host -> string[] (disallow prefixes)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 同一個 host 的請求排成一列，間隔 perHostDelayMs。並行抓不同站不受影響。 */
function throttle(host) {
  const prev = hostQueue.get(host) || Promise.resolve();
  const next = prev.then(() => sleep(CRAWL.perHostDelayMs));
  hostQueue.set(host, next.catch(() => {}));
  return prev;
}

async function rawFetch(url, { timeoutMs = CRAWL.fetchTimeoutMs, ...init } = {}) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    return await fetch(url, {
      ...init,
      signal: ac.signal,
      headers: {
        "user-agent": CRAWL.userAgent,
        accept: "text/html,application/xhtml+xml",
        "accept-language": "zh-TW,zh;q=0.9,en;q=0.8",
        ...(init.headers || {}),
      },
    });
  } finally {
    clearTimeout(t);
  }
}

/** 極簡 robots.txt 解析：只看 User-agent: * 區塊的 Disallow 前綴。 */
async function disallowList(origin) {
  if (robotsCache.has(origin)) return robotsCache.get(origin);
  let rules = [];
  try {
    const res = await rawFetch(`${origin}/robots.txt`, { timeoutMs: 8000 });
    if (res.ok) {
      const txt = await res.text();
      let inStar = false;
      for (const line of txt.split(/\r?\n/)) {
        const l = line.replace(/#.*/, "").trim();
        if (!l) continue;
        const m = l.match(/^([A-Za-z-]+)\s*:\s*(.*)$/);
        if (!m) continue;
        const [, k, v] = [m[0], m[1].toLowerCase(), m[2].trim()];
        if (k === "user-agent") inStar = v === "*";
        else if (k === "disallow" && inStar && v) rules.push(v);
      }
    }
  } catch {
    /* 拿不到 robots.txt 就當作沒有限制，但仍然只抓文章頁 */
  }
  robotsCache.set(origin, rules);
  return rules;
}

export async function allowedByRobots(url) {
  if (!CRAWL.respectRobots) return true;
  const u = new URL(url);
  const rules = await disallowList(u.origin);
  return !rules.some((r) => u.pathname.startsWith(r));
}

function cachePath(url) {
  const h = crypto.createHash("sha1").update(url).digest("hex");
  return path.join(PATHS.cache, `${h}.html`);
}

/**
 * 抓一個網址的 HTML。
 * - 先查磁碟快取（重跑不重抓，demo 前預熱就是靠這個）
 * - robots.txt 擋掉的直接回 {skipped:"robots"}
 */
export async function getHtml(url, { force = false } = {}) {
  const cp = cachePath(url);
  if (!force) {
    try {
      const cached = await fs.readFile(cp, "utf8");
      return { html: cached, fromCache: true };
    } catch {}
  }
  if (!(await allowedByRobots(url))) return { skipped: "robots" };

  const host = new URL(url).host;
  let lastErr;
  for (let i = 0; i <= CRAWL.maxRetries; i++) {
    await throttle(host);
    try {
      const res = await rawFetch(url);
      if (res.status === 403 || res.status === 401) return { skipped: `http_${res.status}` };
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const html = await res.text();
      await fs.mkdir(PATHS.cache, { recursive: true });
      await fs.writeFile(cp, html);
      return { html, fromCache: false };
    } catch (e) {
      lastErr = e;
      await sleep(800 * (i + 1));
    }
  }
  return { skipped: `fetch_failed:${lastErr?.message || "unknown"}` };
}

export async function postJson(url, body, headers = {}, { retries = 4, timeoutMs = 120000, retryOnTimeout = false } = {}) {
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    const res = await rawFetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
      timeoutMs,
    }).catch((e) => { lastErr = e; return null; });

    if (!res) {
      // 逾時或連線中斷。重打一次 = 再等一整輪 timeout，而且配額照算 —— 預設不重試。
      if (!retryOnTimeout || i >= 1) {
        lastErr = new Error(`請求中斷：${Math.round(timeoutMs / 1000)}s 內沒回應（${lastErr?.message || "aborted"}）`);
        break;
      }
      await sleep(2000);
      continue;
    }
    const text = await res.text();

    // 429 / 5xx 退避重試。免費層（OpenRouter 200 req/day）很容易撞到。
    if (res.status === 429 || res.status >= 500) {
      const ra = Number(res.headers.get("retry-after"));
      const wait = Number.isFinite(ra) && ra > 0 ? ra * 1000 : Math.min(60000, 3000 * 2 ** i);
      lastErr = new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
      if (i === retries) break;
      console.warn(`    ↻ ${res.status}，${Math.round(wait / 1000)}s 後重試`);
      await sleep(wait);
      continue;
    }
    if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}: ${text.slice(0, 300)}`);
    return JSON.parse(text);
  }
  throw lastErr || new Error("postJson 失敗");
}
