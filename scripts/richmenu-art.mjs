// 產生 richmenu/menu.png（2500x843）
//
//   node scripts/richmenu-art.mjs              # 從 SITE_URL 抓線上首頁
//   node scripts/richmenu-art.mjs http://localhost:3000
//
// 三格的圖騰、配色、標題都直接從網站首頁的三個入口（.entry）抓下來，所以改網站視覺
// 之後只要重跑這支就會同步，不用再手動複製一次 SVG。
// 流程：抓首頁 → 取出三個 .entry 的 svg/--plate/標題 → headless Chrome 排版截圖
//      → sharp 壓到 1MB 以下（LINE 的上限）。

import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import sharp from "sharp";

const run = promisify(execFile);

const W = 2500;
const H = 843;

const CHROME =
  process.env.CHROME_BIN ||
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

// ---- 讀 .env 拿 SITE_URL（跟 richmenu.mjs 同一套簡易解析）----
async function loadEnv() {
  try {
    const raw = await fs.readFile(path.join(process.cwd(), ".env"), "utf8");
    for (const line of raw.split("\n")) {
      const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*"?([^"\n]*)"?\s*$/);
      if (m && m[2] && !process.env[m[1]]) process.env[m[1]] = m[2];
    }
  } catch {
    /* 沒有 .env 就靠環境變數 */
  }
}

/** 從首頁 HTML 撈出三個入口的圖騰與文字。抓不到就直接報錯，不要默默產出空圖。 */
function parseEntries(html) {
  const entries = [];
  const re = /<a[^>]*class="entry"[^>]*href="([^"]+)"[\s\S]*?<\/a>/g;
  let m;
  while ((m = re.exec(html))) {
    const block = m[0];
    const art = (block.match(/<svg[\s\S]*?<\/svg>/) || [])[0];
    const plate = (block.match(/--plate:\s*([^;"]+)/) || [])[1];
    const name = (block.match(/class="entry__name"[^>]*>([^<]*)/) || [])[1];
    const sub = (block.match(/class="entry__sub"[^>]*>([^<]*)/) || [])[1];
    // .pin / .pin--slate / .pin--rust → 決定圖釘顏色
    const pinCls = (block.match(/class="pin(?:\s+pin--(\w+))?"/) || [])[1];
    if (!art || !plate || !name) {
      throw new Error(`入口 ${m[1]} 解析不完整（首頁結構改了？）`);
    }
    entries.push({ href: m[1], art, plate, name, sub: sub || "", pin: pinCls || "brass" });
  }
  if (entries.length !== 3) {
    throw new Error(`首頁只找到 ${entries.length} 個 .entry，預期 3 個`);
  }
  return entries;
}

const PINS = {
  brass:
    "radial-gradient(circle at 34% 30%, #fdfaf3 0 12%, rgba(253,250,243,0) 45%)," +
    "radial-gradient(circle at 60% 68%, #7e5c2c 0 40%, transparent 42%)," +
    "linear-gradient(145deg, #d8ac5e, #9a6f2e 70%)",
  slate:
    "radial-gradient(circle at 34% 30%, #f4f8fa 0 12%, rgba(244,248,250,0) 45%)," +
    "linear-gradient(145deg, #9fb4c2, #4e6273 72%)",
  rust:
    "radial-gradient(circle at 34% 30%, #fdf3ec 0 12%, rgba(253,243,236,0) 45%)," +
    "linear-gradient(145deg, #c97e53, #8b4522 72%)",
};

const GRAIN =
  "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='220' height='220'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='3' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='220' height='220' filter='url(%23n)' opacity='0.5'/%3E%3C/svg%3E\")";

function html(entries) {
  const tiles = entries
    .map(
      (t) => `
    <div class="tile">
      <span class="pin" style="background:${PINS[t.pin] ?? PINS.brass}"></span>
      <div class="plate" style="--plate:${t.plate}">${t.art}</div>
      <h2 class="name">${t.name}</h2>
      <p class="sub">${t.sub}</p>
    </div>`
    )
    .join("");

  return `<!doctype html>
<html lang="zh-Hant"><head><meta charset="utf-8">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@300;400;500&family=Noto+Serif+TC:wght@300;400;500&family=Special+Elite&display=swap">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    width: ${W}px; height: ${H}px; display: grid;
    grid-template-columns: repeat(3, 1fr);
    background: linear-gradient(168deg, #fdfbf6, #f2ead9);
    -webkit-font-smoothing: antialiased;
  }
  .tile {
    position: relative; display: flex; flex-direction: column;
    align-items: center; justify-content: flex-start;
    padding: 118px 60px 0;
  }
  /* 格與格之間的縫線，對應網站上相框並排的感覺 */
  .tile + .tile::before {
    content: ""; position: absolute; left: 0; top: 104px; bottom: 104px;
    width: 1px;
    background: linear-gradient(180deg, transparent, #c7bda6, transparent);
  }
  .pin {
    position: absolute; top: 66px; left: 50%; margin-left: -19px;
    width: 38px; height: 38px; border-radius: 50%;
    box-shadow: 0 4px 6px rgba(36,31,26,.35), inset 0 -2px 4px rgba(0,0,0,.3);
  }
  .plate {
    position: relative; width: 340px; height: 425px;
    display: grid; place-items: center;
    background: radial-gradient(80% 70% at 50% 35%, rgba(255,255,255,.85), transparent 70%), var(--plate);
    border: 1px solid rgba(190,178,154,.55);
    box-shadow: 0 1px 1px rgba(36,31,26,.08), 0 10px 22px -12px rgba(36,31,26,.32);
    overflow: hidden;
  }
  .plate svg { width: 74%; height: 74%; }
  .plate::after {
    content: ""; position: absolute; inset: 0;
    background-image: ${GRAIN}; opacity: .2; mix-blend-mode: multiply;
  }
  .name {
    font-family: "Cormorant Garamond", "Noto Serif TC", Georgia, serif;
    font-size: 66px; font-weight: 400; letter-spacing: .06em;
    color: #241f1a; margin-top: 48px; white-space: nowrap;
  }
  .sub {
    font-family: "Special Elite", "Noto Serif TC", Courier, monospace;
    font-size: 25px; letter-spacing: .2em; text-transform: uppercase;
    color: #8c8072; margin-top: 18px;
  }
</style></head><body>${tiles}</body></html>`;
}

await loadEnv();

const site = (process.argv[2] || process.env.SITE_URL || "").replace(/\/$/, "");
if (!site) {
  console.error("沒有網站網址：設 .env 的 SITE_URL，或 node scripts/richmenu-art.mjs <url>");
  process.exit(1);
}

const res = await fetch(site, { headers: { "cache-control": "no-cache" } });
if (!res.ok) {
  console.error(`抓 ${site} 失敗：HTTP ${res.status}`);
  process.exit(1);
}
const entries = parseEntries(await res.text());
console.log(`從 ${site} 取得三個入口：` + entries.map((e) => `${e.name}(${e.href})`).join("、"));

const outPng = path.join(process.cwd(), "richmenu/menu.png");
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "richmenu-"));
const htmlPath = path.join(tmp, "menu.html");
const shotPath = path.join(tmp, "shot.png");

await fs.writeFile(htmlPath, html(entries), "utf8");

await run(CHROME, [
  "--headless=new",
  "--disable-gpu",
  "--hide-scrollbars",
  "--force-device-scale-factor=1",
  `--window-size=${W},${H}`,
  "--virtual-time-budget=8000",
  `--screenshot=${shotPath}`,
  `file://${htmlPath}`,
]);

// LINE 只收 1MB 以下的 PNG；線稿＋平塗用 palette 壓縮綽綽有餘
await sharp(shotPath)
  .resize(W, H, { fit: "fill" })
  .png({ palette: true, quality: 90, effort: 10 })
  .toFile(outPng);

const { size } = await fs.stat(outPng);
const meta = await sharp(outPng).metadata();
console.log(
  `richmenu/menu.png  ${meta.width}x${meta.height}  ${(size / 1024).toFixed(0)}KB` +
    (size > 1024 * 1024 ? "  ⚠️ 超過 1MB，LINE 不收" : "")
);
await fs.rm(tmp, { recursive: true, force: true });
