import fs from "node:fs/promises";
import path from "node:path";
import { PATHS } from "../config.mjs";

export async function loadKb() {
  try {
    const txt = await fs.readFile(PATHS.kb, "utf8");
    return txt.split("\n").filter(Boolean).map((l) => JSON.parse(l));
  } catch { return []; }
}

/** 已經抓過的 (style_key, source_url) 就不重跑 */
export async function existingPairs() {
  const rows = await loadKb();
  return new Set(rows.map((r) => `${r.style_key}\u0000${r.source_url}`));
}

export async function append(file, obj) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.appendFile(file, JSON.stringify(obj).replace(/\n/g, " ") + "\n");
}

export async function appendRecord(rec) { await append(PATHS.kb, rec); }
export async function appendMiss(miss)  { await append(PATHS.misses, miss); }
