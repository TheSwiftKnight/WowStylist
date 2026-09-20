// 把色系標籤（「霧灰」「中藍丹寧」「鼠尾草綠」…）換成一塊真的顏色。
//
// 標籤是 Claude 寫的自由中文（見 src/lib/styleTagger.ts 的 palette 欄），
// 沒有 hex 可撈，所以這裡用關鍵字對一個底色，再讓修飾詞調亮調暗。
// 兩層都沒中的話退回「由字串算出來的低彩度色」——不會好看到哪去，
// 但至少同一個標籤每次都是同一塊顏色，不會每次 render 都在跳。

/** 底色表。順序有意義：specific 在前，generic 在後（軍綠 要先於 綠）。 */
const BASES: [RegExp, string][] = [
  [/炭黑|純黑|墨黑|黑/, "#2b2723"],
  [/米白|象牙|乳白|奶白|白/, "#f2ece0"],
  [/霧灰|炭灰|鐵灰|灰/, "#9b958c"],
  [/銀/, "#b7bbbf"],
  [/香檳|金/, "#bb9c5f"],
  [/奶茶|焦糖|駝|卡其|棕|咖|褐|巧克力|可可/, "#a87f55"],
  [/燕麥|米色|米|杏|奶油|裸/, "#e3d6ba"],
  [/海軍|藏青|靛/, "#31415d"],
  [/丹寧|牛仔/, "#5c7fa4"],
  [/天空|水藍|湖水|藍/, "#7092b3"],
  [/軍綠|橄欖|鼠尾草|抹茶|墨綠|草綠|綠/, "#7d8a5c"],
  [/酒紅|勃根地|磚紅|正紅|紅/, "#9c3b35"],
  [/櫻花|玫瑰|藕|粉/, "#ddb2ac"],
  [/焦橘|橘|橙|磚/, "#b8642f"],
  [/芥末|鵝黃|黃/, "#c3a04a"],
  [/薰衣草|丁香|紫/, "#8b7ca3"],
];

/** 修飾詞 → 亮度位移（正數變亮）。 */
const SHIFTS: [RegExp, number][] = [
  [/淺|淡|粉嫩|柔|亮/, 14],
  [/霧|灰調|煙燻|柔霧/, 6],
  [/深|暗|濃|墨|炭|沉/, -14],
];

function hexToHsl(hex: string): [number, number, number] {
  const n = Number.parseInt(hex.slice(1), 16);
  const r = ((n >> 16) & 255) / 255;
  const g = ((n >> 8) & 255) / 255;
  const b = (n & 255) / 255;

  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;

  if (d === 0) return [0, 0, l * 100];

  const s = d / (1 - Math.abs(2 * l - 1));
  let h: number;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;

  return [((h * 60) + 360) % 360, s * 100, l * 100];
}

/** 由標籤字串算一個固定的低彩度色，當作對不到關鍵字時的保底。 */
function fallback(label: string): [number, number, number] {
  let hash = 0;
  for (const ch of label) hash = (hash * 31 + ch.codePointAt(0)!) % 360;
  // 彩度壓低、亮度中間，才不會在一整片紙色裡跳出來
  return [hash, 22, 58];
}

/**
 * 色系標籤 → CSS 顏色。
 *
 * 回 hsl() 而不是 hex，是因為亮度位移要在 HSL 上做才不會把顏色洗成灰。
 */
export function swatchColor(label: string): string {
  const base = BASES.find(([re]) => re.test(label));
  let [h, s, l] = base ? hexToHsl(base[1]) : fallback(label);

  const shift = SHIFTS.find(([re]) => re.test(label));
  if (shift) l = Math.min(92, Math.max(10, l + shift[1]));

  return `hsl(${h.toFixed(0)} ${s.toFixed(0)}% ${l.toFixed(0)}%)`;
}

/** 深色底要配淺色字。純粹看亮度。 */
export function swatchInk(label: string): string {
  const base = BASES.find(([re]) => re.test(label));
  let [, , l] = base ? hexToHsl(base[1]) : fallback(label);

  const shift = SHIFTS.find(([re]) => re.test(label));
  if (shift) l = Math.min(92, Math.max(10, l + shift[1]));

  return l > 62 ? "#241f1a" : "#fbf7ee";
}
