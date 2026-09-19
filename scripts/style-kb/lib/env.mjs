// 讓這些 script 直接 `node scripts/style-kb/...` 就能吃到專案根目錄的 .env，
// 不必記得加 --env-file（Node < 20.6 也沒有這個旗標）。
import fs from "node:fs";
import path from "node:path";
import { ROOT } from "../config.mjs";

for (const name of [".env.local", ".env"]) {
  const p = path.join(ROOT, name);
  if (!fs.existsSync(p)) continue;
  for (const line of fs.readFileSync(p, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (!m) continue;
    const key = m[1];
    let val = m[2].trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'")))
      val = val.slice(1, -1);
    if (val && process.env[key] === undefined) process.env[key] = val;
  }
}
