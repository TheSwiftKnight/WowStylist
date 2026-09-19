// Rich Menu（LINE 圖文選單）管理腳本
//
//   node scripts/richmenu.mjs create          # 用 richmenu/config.json + menu.png 建立並設為預設選單
//   node scripts/richmenu.mjs list            # 列出所有 rich menu（含目前預設）
//   node scripts/richmenu.mjs delete <id>     # 刪除指定選單
//   node scripts/richmenu.mjs clear           # 取消預設選單（聊天室下方就不顯示）
//
// 設定檔：richmenu/config.json
//   - size: 2500x1686（全高）或 2500x843（半高）
//   - areas: 每個可點區塊的 bounds（像素座標）+ action
//       action.type = "uri"     → 點了開網址（{SITE_URL} 會自動代入 .env 的 SITE_URL）
//       action.type = "message" → 點了幫使用者送出這段文字（會走 webhook，可觸發對話/功能）
// 圖片：richmenu/menu.png（尺寸要跟 size 一致、1MB 以下）
// 改版流程：改 config.json / 換 menu.png → 再跑一次 create（會自動刪掉同名舊選單）

import fs from "node:fs/promises";
import path from "node:path";

// ---- 讀 .env（不裝 dotenv，簡單解析）----
async function loadEnv() {
  try {
    const raw = await fs.readFile(path.join(process.cwd(), ".env"), "utf8");
    for (const line of raw.split("\n")) {
      const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*"?([^"\n]*)"?\s*$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
    }
  } catch {
    /* 沒有 .env 就靠環境變數 */
  }
}

const API = "https://api.line.me/v2/bot";
const API_DATA = "https://api-data.line.me/v2/bot";

function authHeaders() {
  const token = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  if (!token) {
    console.error("缺 LINE_CHANNEL_ACCESS_TOKEN（.env）");
    process.exit(1);
  }
  return { Authorization: `Bearer ${token}` };
}

async function api(method, url, body, contentType) {
  const res = await fetch(url, {
    method,
    headers: {
      ...authHeaders(),
      ...(contentType ? { "Content-Type": contentType } : {}),
    },
    body,
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`${method} ${url} → HTTP ${res.status}: ${text}`);
  }
  return text ? JSON.parse(text) : {};
}

async function getDefaultMenuId() {
  try {
    const r = await api("GET", `${API}/user/all/richmenu`);
    return r.richMenuId ?? null;
  } catch {
    return null; // 沒設定預設選單時會 404
  }
}

async function cmdList() {
  const { richmenus } = await api("GET", `${API}/richmenu/list`);
  const def = await getDefaultMenuId();
  if (!richmenus?.length) {
    console.log("目前沒有任何 rich menu");
    return;
  }
  for (const m of richmenus) {
    const mark = m.richMenuId === def ? "  ← 目前預設" : "";
    console.log(`${m.richMenuId}  ${m.name}  (${m.size.width}x${m.size.height})${mark}`);
  }
}

async function cmdCreate() {
  const cfgRaw = await fs.readFile(path.join(process.cwd(), "richmenu/config.json"), "utf8");
  const siteUrl = process.env.SITE_URL || "";
  if (cfgRaw.includes("{SITE_URL}") && !siteUrl) {
    console.error("config.json 用到 {SITE_URL}，但 .env 沒設 SITE_URL");
    process.exit(1);
  }
  const config = JSON.parse(cfgRaw.replaceAll("{SITE_URL}", siteUrl));

  const imgPath = path.join(process.cwd(), "richmenu/menu.png");
  const img = await fs.readFile(imgPath);
  if (img.byteLength > 1024 * 1024) {
    console.error(`menu.png 超過 1MB（${(img.byteLength / 1024).toFixed(0)}KB），LINE 不收`);
    process.exit(1);
  }

  // 同名舊選單先刪掉，避免越積越多
  const { richmenus } = await api("GET", `${API}/richmenu/list`);
  for (const m of richmenus ?? []) {
    if (m.name === config.name) {
      await api("DELETE", `${API}/richmenu/${m.richMenuId}`);
      console.log(`已刪除同名舊選單 ${m.richMenuId}`);
    }
  }

  // 1. 建立選單（送 JSON 定義）
  const { richMenuId } = await api(
    "POST",
    `${API}/richmenu`,
    JSON.stringify(config),
    "application/json"
  );
  console.log(`已建立 rich menu: ${richMenuId}`);

  // 2. 上傳選單圖片
  await api("POST", `${API_DATA}/richmenu/${richMenuId}/content`, img, "image/png");
  console.log("已上傳選單圖片");

  // 3. 設為所有使用者的預設選單
  await api("POST", `${API}/user/all/richmenu/${richMenuId}`);
  console.log("已設為預設選單 ✅ 手機上把聊天室關掉重開就會看到");
}

async function cmdDelete(id) {
  if (!id) {
    console.error("用法：node scripts/richmenu.mjs delete <richMenuId>");
    process.exit(1);
  }
  await api("DELETE", `${API}/richmenu/${id}`);
  console.log(`已刪除 ${id}`);
}

async function cmdClear() {
  await api("DELETE", `${API}/user/all/richmenu`);
  console.log("已取消預設選單");
}

await loadEnv();
const [cmd, arg] = process.argv.slice(2);
try {
  if (cmd === "create") await cmdCreate();
  else if (cmd === "list") await cmdList();
  else if (cmd === "delete") await cmdDelete(arg);
  else if (cmd === "clear") await cmdClear();
  else {
    console.log("用法：node scripts/richmenu.mjs <create|list|delete <id>|clear>");
  }
} catch (e) {
  console.error(String(e));
  process.exit(1);
}
