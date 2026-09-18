// 從 Instagram 解析貼文內容（不需要官方 API 金鑰）。
// 策略 A：抓 https://www.instagram.com/p/<code>/embed/captioned/（公開 embed 頁）
// 策略 B：抓貼文主頁的 OG meta tags（og:image / og:title / og:description）。
//         LINE、Slack 能顯示 IG 連結預覽就是讀這些 tags，所以對爬蟲 UA 是開放的。
// 兩個都失敗時，會把抓到的 HTML 存到 debug_html/ 方便排查。
// IG 的圖片 CDN 網址帶簽名、幾天後會過期，所以抓到後下載到 public/media/ 保存。

import fs from "node:fs/promises";
import path from "node:path";

const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
// 讓 IG 把我們當成產生連結預覽的爬蟲（跟 LINE/FB 一樣），會拿到帶 OG tags 的頁面
const CRAWLER_UA = "facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)";

export type IgMeta = {
  username: string | null;
  caption: string | null;
  mediaPath: string | null; // 本機路徑，如 /media/xxx.jpg
  isVideo: boolean;
};

function matchFirst(html: string, patterns: RegExp[]): string | null {
  for (const re of patterns) {
    const m = html.match(re);
    if (m?.[1]) return m[1];
  }
  return null;
}

/** 還原 JSON 字串跳脫（\uXXXX、\/、\n …） */
function unescapeJsonString(s: string): string {
  try {
    return JSON.parse(`"${s.replace(/"/g, '\\"')}"`) as string;
  } catch {
    return s.replace(/\\u0026/g, "&").replace(/\\\//g, "/").replace(/\\n/g, "\n");
  }
}

/** 還原 HTML entities */
function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)));
}

async function fetchHtml(url: string, ua: string): Promise<string | null> {
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": ua,
        "Accept-Language": "en-US,en;q=0.9",
        Accept: "text/html,application/xhtml+xml",
      },
      redirect: "follow",
    });
    if (!res.ok) {
      console.error(`[igFetch] ${url} → HTTP ${res.status}`);
      return null;
    }
    return await res.text();
  } catch (e) {
    console.error(`[igFetch] ${url} 抓取失敗:`, e);
    return null;
  }
}

async function dumpDebugHtml(name: string, html: string): Promise<void> {
  try {
    const dir = path.join(process.cwd(), "debug_html");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, `${name}.html`), html);
    console.log(`[igFetch] 解析失敗的 HTML 已存到 debug_html/${name}.html`);
  } catch {
    /* debug 用，失敗就算了 */
  }
}

// ---------- 策略 A：embed 頁 ----------

function parseEmbedImage(html: string): string | null {
  const raw = matchFirst(html, [
    /class="EmbeddedMediaImage"[^>]*\ssrc="([^"]+)"/,
    /"display_url"\s*:\s*"([^"]+)"/,
    /\\"display_url\\":\\"(.*?)\\"/,
  ]);
  return raw ? decodeHtmlEntities(unescapeJsonString(raw)) : null;
}

function parseEmbedUsername(html: string): string | null {
  const raw = matchFirst(html, [
    /class="UsernameText"[^>]*>([^<]+)</,
    /"username"\s*:\s*"([^"]+)"/,
    /\\"username\\":\\"([^"\\]+)/,
  ]);
  return raw ? decodeHtmlEntities(raw.trim()) : null;
}

function parseEmbedCaption(html: string, username: string | null): string | null {
  const jsonCaption = matchFirst(html, [
    /"edge_media_to_caption"\s*:\s*\{\s*"edges"\s*:\s*\[\s*\{\s*"node"\s*:\s*\{\s*"text"\s*:\s*"((?:[^"\\]|\\.)*)"/,
    /\\"edge_media_to_caption\\".*?\\"text\\":\\"((?:[^\\]|\\[^"])*?)\\"/,
  ]);
  if (jsonCaption) {
    const text = unescapeJsonString(jsonCaption).trim();
    if (text) return text;
  }
  const m = html.match(
    /<div[^>]*class="Caption"[^>]*>([\s\S]*?)(?:<div[^>]*class="CaptionComments"|<\/div>\s*<\/div>)/
  );
  if (!m) return null;
  let text = m[1]
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/\r/g, "");
  text = decodeHtmlEntities(text).trim();
  if (username && text.startsWith(username)) {
    text = text.slice(username.length).trim();
  }
  return text || null;
}

// ---------- 策略 B：OG meta tags ----------

function ogContent(html: string, prop: string): string | null {
  const raw = matchFirst(html, [
    new RegExp(`<meta[^>]+property="${prop}"[^>]+content="([^"]*)"`, "i"),
    new RegExp(`<meta[^>]+content="([^"]*)"[^>]+property="${prop}"`, "i"),
  ]);
  return raw ? decodeHtmlEntities(raw) : null;
}

function parseOgMeta(html: string): {
  username: string | null;
  caption: string | null;
  imageUrl: string | null;
  isVideo: boolean;
} {
  const imageUrl = ogContent(html, "og:image");
  const title = ogContent(html, "og:title"); // 通常是：Username on Instagram: "caption…"
  const desc = ogContent(html, "og:description"); // 通常是：N likes, M comments - username on Date: "caption"

  let username: string | null = null;
  let caption: string | null = null;

  if (title) {
    const m = title.match(/^@?([\w.]+)\s+on Instagram/i);
    if (m) username = m[1];
    const c = title.match(/on Instagram:\s*"([\s\S]*)"?\s*$/i);
    if (c) caption = c[1].replace(/"$/, "").trim();
  }
  if (!username && desc) {
    const m = desc.match(/-\s*@?([\w.]+)\s+on\s/i) ?? desc.match(/^@?([\w.]+)\s+on Instagram/i);
    if (m) username = m[1];
  }
  if (!caption && desc) {
    const c = desc.match(/:\s*"([\s\S]*)"\s*$/);
    caption = c ? c[1].trim() : desc.trim();
  }

  const isVideo = Boolean(
    ogContent(html, "og:video") || /property="og:type"[^>]*content="video/i.test(html)
  );

  return { username, caption: caption || null, imageUrl, isVideo };
}

// ---------- 圖片下載 ----------

async function downloadImage(imageUrl: string, shortcode: string): Promise<string | null> {
  try {
    const res = await fetch(imageUrl, {
      headers: { "User-Agent": BROWSER_UA, Referer: "https://www.instagram.com/" },
    });
    if (!res.ok) {
      console.error(`[igFetch] 下載圖片失敗 HTTP ${res.status}`);
      return null;
    }
    const buf = Buffer.from(await res.arrayBuffer());
    const dir = path.join(process.cwd(), "public", "media");
    await fs.mkdir(dir, { recursive: true });
    const filename = `${shortcode}.jpg`;
    await fs.writeFile(path.join(dir, filename), buf);
    return `/media/${filename}`;
  } catch (e) {
    console.error("[igFetch] 下載圖片失敗:", e);
    return null;
  }
}

// ---------- 主流程 ----------

export async function fetchIgMeta(shortcode: string, kind: string): Promise<IgMeta | null> {
  const pathKind = kind === "reel" ? "reel" : kind === "tv" ? "tv" : "p";

  // 策略 A：embed 頁
  const embedUrl = `https://www.instagram.com/${pathKind}/${shortcode}/embed/captioned/`;
  const embedHtml = await fetchHtml(embedUrl, BROWSER_UA);

  let username: string | null = null;
  let caption: string | null = null;
  let imageUrl: string | null = null;
  let isVideo = kind === "reel" || kind === "tv";

  if (embedHtml) {
    username = parseEmbedUsername(embedHtml);
    caption = parseEmbedCaption(embedHtml, username);
    imageUrl = parseEmbedImage(embedHtml);
    isVideo =
      isVideo || /"is_video"\s*:\s*true/.test(embedHtml) || /\\"is_video\\":true/.test(embedHtml);
  }

  // 策略 B：embed 頁沒挖到東西 → 抓主頁的 OG tags（用爬蟲 UA）
  if (!username && !caption && !imageUrl) {
    console.log(`[igFetch] ${shortcode} embed 頁解析不出內容，改用 OG tags`);
    const pageUrl = `https://www.instagram.com/${pathKind}/${shortcode}/`;
    const pageHtml = await fetchHtml(pageUrl, CRAWLER_UA);
    if (pageHtml) {
      const og = parseOgMeta(pageHtml);
      username = og.username;
      caption = og.caption;
      imageUrl = og.imageUrl;
      isVideo = isVideo || og.isVideo;
      if (!og.username && !og.caption && !og.imageUrl) {
        await dumpDebugHtml(`${shortcode}-page`, pageHtml);
        if (embedHtml) await dumpDebugHtml(`${shortcode}-embed`, embedHtml);
      }
    } else if (embedHtml) {
      await dumpDebugHtml(`${shortcode}-embed`, embedHtml);
    }
  }

  const mediaPath = imageUrl ? await downloadImage(imageUrl, shortcode) : null;

  if (!username && !caption && !mediaPath) {
    console.error(`[igFetch] ${shortcode} 兩種方式都解析不出內容（HTML 已存 debug_html/）`);
    return null;
  }

  console.log(
    `[igFetch] ${shortcode} → user=${username ?? "-"} caption=${
      caption ? caption.slice(0, 30) + "…" : "-"
    } img=${mediaPath ?? "-"} video=${isVideo}`
  );
  return { username, caption, mediaPath, isVideo };
}
