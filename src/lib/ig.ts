// Instagram 連結解析工具

export type IgLink = {
  url: string; // 正規化後的網址
  shortcode: string;
  kind: "post" | "reel" | "tv" | "unknown";
};

// 支援 instagram.com/p/、/reel/、/reels/、/tv/，
// 也支援 /{username}/p/{code} 和 /{username}/reel/{code} 這種帶帳號的路徑
const IG_URL_RE =
  /https?:\/\/(?:www\.)?instagram\.com\/(?:[A-Za-z0-9_.]+\/)?(p|reel|reels|tv)\/([A-Za-z0-9_-]+)/g;

const KIND_MAP: Record<string, IgLink["kind"]> = {
  p: "post",
  reel: "reel",
  reels: "reel",
  tv: "tv",
};

/** 從任意文字中抓出所有 Instagram 貼文/Reels 連結 */
export function extractIgLinks(text: string): IgLink[] {
  const seen = new Set<string>();
  const out: IgLink[] = [];
  for (const m of text.matchAll(IG_URL_RE)) {
    const kind = KIND_MAP[m[1]] ?? "unknown";
    const shortcode = m[2];
    if (seen.has(shortcode)) continue;
    seen.add(shortcode);
    const pathKind = kind === "reel" ? "reel" : kind === "tv" ? "tv" : "p";
    out.push({
      url: `https://www.instagram.com/${pathKind}/${shortcode}/`,
      shortcode,
      kind,
    });
  }
  return out;
}

/** 產生 IG 官方 embed 頁的網址（前端 iframe 用） */
export function igEmbedUrl(link: { shortcode: string; kind: string }): string {
  const pathKind = link.kind === "reel" ? "reel" : link.kind === "tv" ? "tv" : "p";
  return `https://www.instagram.com/${pathKind}/${link.shortcode}/embed/captioned/`;
}
