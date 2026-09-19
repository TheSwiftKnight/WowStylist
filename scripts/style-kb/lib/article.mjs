// HTML -> { title, text, published, sourceDomain }
// 優先吃 JSON-LD（Condé Nast / Future plc / 多數 CMS 都有），沒有再退回 DOM 啟發式。
import * as cheerio from "cheerio";

function fromJsonLd($) {
  const out = {};
  $('script[type="application/ld+json"]').each((_, el) => {
    let json;
    try { json = JSON.parse($(el).contents().text()); } catch { return; }
    const nodes = Array.isArray(json) ? json : json["@graph"] ? json["@graph"] : [json];
    for (const n of nodes) {
      const t = [].concat(n?.["@type"] || []);
      if (t.some((x) => /Article|BlogPosting|NewsArticle/i.test(x))) {
        out.title ||= n.headline || n.name;
        out.published ||= (n.datePublished || n.dateCreated || "").slice(0, 10) || null;
        if (n.articleBody && n.articleBody.length > (out.text?.length || 0)) out.text = n.articleBody;
      }
    }
  });
  return out;
}

function fromDom($) {
  $("script,style,noscript,nav,footer,header,aside,form,iframe").remove();
  // 挑 <p> 文字量最多的容器
  let best = null, bestLen = 0;
  $("article, main, [class*=article], [class*=content], [class*=post], body").each((_, el) => {
    const len = $(el).find("p").text().trim().length;
    if (len > bestLen) { bestLen = len; best = el; }
  });
  const scope = best ? $(best) : $("body");
  const text = scope.find("p, h2, h3, li")
    .map((_, el) => $(el).text().replace(/\s+/g, " ").trim())
    .get().filter((s) => s.length > 20).join("\n");
  return { text };
}

export function parseArticle(html, url) {
  const $ = cheerio.load(html);
  const ld = fromJsonLd($);
  const dom = fromDom($);

  const title =
    ld.title ||
    $('meta[property="og:title"]').attr("content") ||
    $("h1").first().text().trim() ||
    null;

  const published =
    ld.published ||
    ($('meta[property="article:published_time"]').attr("content") || "").slice(0, 10) ||
    ($("time[datetime]").first().attr("datetime") || "").slice(0, 10) ||
    null;

  const text = (ld.text && ld.text.length > dom.text.length ? ld.text : dom.text) || "";

  return {
    title,
    published: published || null,
    text: text.replace(/\n{3,}/g, "\n\n").trim(),
    sourceDomain: new URL(url).hostname.replace(/^www\./, ""),
  };
}
