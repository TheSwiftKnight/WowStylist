// ---------------------------------------------------------------------------
// 示範資料 —— pipeline 還沒跑過、或資料庫連不上時的 fallback。
//   1. 收藏夾：見 src/lib/garments.ts
//   2. style 風向標：style_tags 表還是空的時候的種子，見 src/lib/tags.ts
// 真的有資料之後這兩份就不會被用到了。
// ---------------------------------------------------------------------------

import type { Garment } from "@/lib/garments";

export type StyleTagKind = "style" | "color" | "mood";

export type StyleTag = {
  id: string;
  label: string;
  kind: StyleTagKind;
  /** 0~1，決定標籤在風向標上的大小權重。 */
  weight: number;
};

const day = 86_400_000;
const now = Date.now();

function mock(
  id: number,
  category: "top" | "pants",
  description: string,
  displayTags: string[],
  outfitTags: string[],
  shortcode: string,
  type: "post" | "reel",
  ageDays: number
): Garment {
  return {
    id,
    source: "instagram",
    sourceItemId: `${shortcode}_${type === "reel" ? "t6.0" : "p0"}_0_${category}`,
    category,
    description,
    displayTags,
    outfitTags,
    instagramUrl: `https://www.instagram.com/${
      type === "reel" ? "reel" : "p"
    }/${shortcode}/`,
    instagramType: type,
    shortcode,
    timestamp: type === "reel" ? 6 : null,
    // 商品欄位，IG 來的一律 null
    title: null,
    priceTwd: null,
    productUrl: null,
    hasImage: false,
    createdAt: new Date(now - ageDays * day).toISOString(),
  };
}

/** 收藏夾的示範單品。hasImage=false，所以卡片會顯示紙質留白。 */
export const MOCK_GARMENTS: Garment[] = [
  mock(
    -1,
    "top",
    "A relaxed oatmeal linen shirt with a soft drape, long sleeves rolled to the forearm, and a camp collar.",
    ["Oatmeal", "Linen", "Relaxed-fit", "Long-sleeve"],
    ["Minimal", "Relaxed"],
    "mock-01",
    "post",
    1
  ),
  mock(
    -2,
    "pants",
    "Cream wide-leg trousers with a high rise, full length, and a smooth structured fabric appearance.",
    ["Cream", "Wide-leg", "High-rise"],
    ["Minimal", "Relaxed"],
    "mock-01",
    "post",
    1
  ),
  mock(
    -3,
    "top",
    "A fitted dark brown ribbed tank top with a sleeveless cut and scoop neckline.",
    ["Dark Brown", "Tank Top", "Ribbed", "Fitted"],
    ["Casual", "Monochrome"],
    "mock-02",
    "reel",
    3
  ),
  mock(
    -4,
    "pants",
    "Black relaxed cargo shorts with a loose silhouette and utility pocket details.",
    ["Black", "Cargo", "Relaxed-fit", "Shorts"],
    ["Casual", "Streetwear"],
    "mock-02",
    "reel",
    3
  ),
  mock(
    -5,
    "top",
    "An oversized off-white cotton shirt with dropped shoulders and a classic point collar.",
    ["Off-white", "Oversized", "Cotton"],
    ["Minimal", "Clean"],
    "mock-03",
    "post",
    6
  ),
  mock(
    -6,
    "pants",
    "Olive straight-leg denim-like trousers with a mid rise and full length.",
    ["Olive", "Straight-leg", "Denim-like"],
    ["Casual", "Earthy"],
    "mock-03",
    "post",
    6
  ),
  mock(
    -7,
    "top",
    "A charcoal heavyweight hoodie with a relaxed fit, kangaroo pocket, and soft brushed knit appearance.",
    ["Charcoal", "Hoodie", "Relaxed-fit"],
    ["Streetwear", "Sporty"],
    "mock-04",
    "reel",
    10
  ),
  mock(
    -8,
    "pants",
    "Grey tapered sweatpants with an elasticated waist and cuffed hem.",
    ["Grey", "Sweatpants", "Tapered"],
    ["Sporty", "Relaxed"],
    "mock-04",
    "reel",
    10
  ),
];

/** style 風向標的種子標籤（20 個）。 */
export const MOCK_TAGS: StyleTag[] = [
  { id: "t-01", label: "法式復古", kind: "style", weight: 0.95 },
  { id: "t-02", label: "極簡侘寂", kind: "style", weight: 0.72 },
  { id: "t-03", label: "學院風", kind: "style", weight: 0.58 },
  { id: "t-04", label: "中性帥氣", kind: "style", weight: 0.81 },
  { id: "t-05", label: "芭蕾風", kind: "style", weight: 0.44 },
  { id: "t-06", label: "都會通勤", kind: "style", weight: 0.67 },
  { id: "t-07", label: "戶外機能", kind: "style", weight: 0.31 },
  { id: "t-08", label: "老錢風", kind: "style", weight: 0.88 },
  { id: "t-09", label: "奶油白", kind: "color", weight: 0.9 },
  { id: "t-10", label: "灰調莫蘭迪", kind: "color", weight: 0.76 },
  { id: "t-11", label: "焦糖棕", kind: "color", weight: 0.63 },
  { id: "t-12", label: "墨綠", kind: "color", weight: 0.55 },
  { id: "t-13", label: "霧霾藍", kind: "color", weight: 0.49 },
  { id: "t-14", label: "燕麥米", kind: "color", weight: 0.7 },
  { id: "t-15", label: "鏽紅", kind: "color", weight: 0.27 },
  { id: "t-16", label: "鬆弛感", kind: "mood", weight: 0.93 },
  { id: "t-17", label: "高級感", kind: "mood", weight: 0.6 },
  { id: "t-18", label: "乾淨俐落", kind: "mood", weight: 0.52 },
  { id: "t-19", label: "慵懶", kind: "mood", weight: 0.38 },
  { id: "t-20", label: "有故事感", kind: "mood", weight: 0.46 },
];
