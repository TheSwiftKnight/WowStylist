// 從 LLM 回應裡挖出 JSON。
//
// Nemotron 3 Ultra 在 OpenRouter 上不支援 response_format / structured_outputs
// （只有 tools / tool_choice / reasoning），所以沒辦法用 schema 強制輸出格式，
// tool_call 的 arguments 常常是「寬鬆 JSON」：key 沒加引號、單引號字串、尾逗號，
// 有時還混在 reasoning 文字裡。這支就是專門吃這些髒東西。
import JSON5 from "json5";

/** 掃出所有「括號平衡」的 {...} 區段（會跳過字串內的括號），長的排前面 */
function balancedCandidates(text) {
  const out = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== "{") continue;
    let depth = 0, inStr = false, quote = "", esc = false;
    for (let j = i; j < text.length; j++) {
      const c = text[j];
      if (esc) { esc = false; continue; }
      if (inStr) {
        if (c === "\\") esc = true;
        else if (c === quote) inStr = false;
        continue;
      }
      if (c === '"' || c === "'") { inStr = true; quote = c; continue; }
      if (c === "{") depth++;
      else if (c === "}") {
        depth--;
        if (depth === 0) { out.push(text.slice(i, j + 1)); i = j; break; }
      }
    }
  }
  return out.sort((a, b) => b.length - a.length);
}

function tryParse(s) {
  try {
    return { ok: true, value: JSON.parse(s) };
  } catch {}
  try {
    return { ok: true, value: JSON5.parse(s) };
  } catch {}
  try {
    // 最後手段：把尾逗號補掉再試一次
    return { ok: true, value: JSON5.parse(s.replace(/,(\s*[}\]])/g, "$1")) };
  } catch {}
  return { ok: false };
}

/**
 * @param {string|object} input tool_call 的 arguments（字串或已是物件）、或整段 content
 * @returns {{ value:any, how:string }}
 * @throws 解不出來就丟，訊息含前 300 字供 debug
 */
export function parseLooseJson(input) {
  if (input && typeof input === "object") return { value: input, how: "object" };
  let txt = String(input ?? "");
  if (!txt.trim()) throw new Error("空回應");

  // reasoning model 會吐 <think>…</think>
  txt = txt.replace(/<think>[\s\S]*?<\/think>/gi, "")
           .replace(/<\|[^|]*\|>/g, "")
           .trim();

  // 整串直接是 JSON 的快路徑
  const direct = tryParse(txt);
  if (direct.ok && direct.value && typeof direct.value === "object") return { value: direct.value, how: "direct" };

  // ```json 圍欄優先
  for (const m of txt.matchAll(/```(?:json5?)?\s*([\s\S]*?)```/gi)) {
    const r = tryParse(m[1].trim());
    if (r.ok && r.value && typeof r.value === "object") return { value: r.value, how: "fence" };
  }

  // 括號平衡掃描，挑第一個解得開、而且看起來像我們要的東西
  for (const cand of balancedCandidates(txt)) {
    const r = tryParse(cand);
    if (!r.ok || !r.value || typeof r.value !== "object") continue;
    if ("formula" in r.value || "style_present" in r.value) return { value: r.value, how: "balanced" };
  }
  // 沒有 formula 也認了，至少是個物件
  for (const cand of balancedCandidates(txt)) {
    const r = tryParse(cand);
    if (r.ok && r.value && typeof r.value === "object") return { value: r.value, how: "balanced_any" };
  }

  throw new Error(`解不出 JSON：${txt.slice(0, 300)}`);
}
