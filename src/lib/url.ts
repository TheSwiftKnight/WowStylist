// 通用 URL 偵測工具（非 IG 專屬）
//
// 使用時機：
//   1. 先用 ig.ts 的 extractIgLinks() 抓 IG 連結
//   2. 沒有 IG 連結時，用這裡的 extractAnyUrls() 判斷「是否還有其他網址」
//   3. 完全沒有網址才當純文字送 LLM

/** 從任意文字中抓出所有 http/https 網址 */
export function extractAnyUrls(text: string): string[] {
  const URL_RE = /https?:\/\/[^\s　，、！？）\]>「」"']+/g;
  return [...new Set(text.match(URL_RE) ?? [])];
}

/** 判斷文字裡是否含有任何 URL（快速版，不需要完整清單時用） */
export function containsUrl(text: string): boolean {
  return /https?:\/\/\S+/.test(text);
}
