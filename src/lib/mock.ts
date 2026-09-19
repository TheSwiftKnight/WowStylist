// ---------------------------------------------------------------------------
// Mock data — 之後接上 Amazon RDS 就可以整份移除。
// 目前用途：
//   1. 收藏夾：資料庫連不上或還沒有資料時的 fallback（見 src/lib/links.ts）
//   2. style 風向標：tags table 還沒建，先用這份當種子（見 src/lib/tags.ts）
// ---------------------------------------------------------------------------

export type BoardLink = {
  id: number;
  url: string;
  shortcode: string;
  kind: string;
  username: string | null;
  caption: string | null;
  mediaPath: string | null;
  isVideo: boolean;
  senderName: string | null;
  createdAt: string; // ISO
};

export type StyleTagKind = "style" | "color" | "mood";

export type StyleTag = {
  id: string;
  label: string;
  kind: StyleTagKind;
  /** 0~1，決定標籤在風向標上的大小權重。之後可由 RDS 依收藏次數算出來。 */
  weight: number;
};

const day = 86_400_000;
const now = Date.now();

/** 收藏夾的假資料。mediaPath 指到 public/ 底下，沒有檔案就會顯示紙質留白。 */
export const MOCK_LINKS: BoardLink[] = [
  {
    id: -1,
    url: "https://www.instagram.com/p/DdUXGzZyjeN/",
    shortcode: "DdUXGzZyjeN",
    kind: "post",
    username: "atelier.linen",
    caption: "亞麻襯衫 + 奶油白長裙，初秋的鬆弛感穿搭。",
    mediaPath: "/media/DdUXGzZyjeN.jpg",
    isVideo: false,
    senderName: "示範資料",
    createdAt: new Date(now - 1 * day).toISOString(),
  },
  {
    id: -2,
    url: "https://www.instagram.com/reel/DceqdZ0qzUY/",
    shortcode: "DceqdZ0qzUY",
    kind: "reel",
    username: "quiet.wardrobe",
    caption: "一週五套老錢風通勤穿搭，主色只有燕麥米跟墨綠。",
    mediaPath: "/media/DceqdZ0qzUY.jpg",
    isVideo: true,
    senderName: "示範資料",
    createdAt: new Date(now - 3 * day).toISOString(),
  },
  {
    id: -3,
    url: "https://www.instagram.com/p/Dcn_sFwsWDI/",
    shortcode: "Dcn_sFwsWDI",
    kind: "post",
    username: "morningpaper.co",
    caption: "焦糖棕皮革配件的三種搭法。",
    mediaPath: "/media/Dcn_sFwsWDI.jpg",
    isVideo: false,
    senderName: "示範資料",
    createdAt: new Date(now - 5 * day).toISOString(),
  },
  {
    id: -4,
    url: "https://www.instagram.com/p/DcmYBQDA9bT/",
    shortcode: "DcmYBQDA9bT",
    kind: "post",
    username: "studio.grisaille",
    caption: "灰調莫蘭迪色系的層次疊穿。",
    mediaPath: "/media/DcmYBQDA9bT.jpg",
    isVideo: false,
    senderName: "示範資料",
    createdAt: new Date(now - 8 * day).toISOString(),
  },
  {
    id: -5,
    url: "https://www.instagram.com/reel/DdC3Fytju_R/",
    shortcode: "DdC3Fytju_R",
    kind: "reel",
    username: "the.ballet.diary",
    caption: "芭蕾風針織 + 緞面裙，甜but不膩的版本。",
    mediaPath: "/media/DdC3Fytju_R.jpg",
    isVideo: true,
    senderName: "示範資料",
    createdAt: new Date(now - 11 * day).toISOString(),
  },
  {
    id: -6,
    url: "https://www.instagram.com/p/mock-06/",
    shortcode: "mock-06",
    kind: "post",
    username: "hallway.notes",
    caption: "把西裝外套當襯衫穿，肩線要鬆一個尺寸。",
    mediaPath: null,
    isVideo: false,
    senderName: "示範資料",
    createdAt: new Date(now - 14 * day).toISOString(),
  },
  {
    id: -7,
    url: "https://www.instagram.com/p/mock-07/",
    shortcode: "mock-07",
    kind: "post",
    username: "salt.and.wool",
    caption: "霧霾藍 × 奶油白，冬天最安全的組合。",
    mediaPath: null,
    isVideo: false,
    senderName: "示範資料",
    createdAt: new Date(now - 17 * day).toISOString(),
  },
  {
    id: -8,
    url: "https://www.instagram.com/reel/mock-08/",
    shortcode: "mock-08",
    kind: "reel",
    username: "second.hand.girl",
    caption: "二手店挑外套的四個重點：肩線、內襯、鈕釦、下襬。",
    mediaPath: null,
    isVideo: true,
    senderName: "示範資料",
    createdAt: new Date(now - 21 * day).toISOString(),
  },
  {
    id: -9,
    url: "https://www.instagram.com/p/mock-09/",
    shortcode: "mock-09",
    kind: "post",
    username: "atelier.linen",
    caption: "學院風格紋裙的長度分水嶺。",
    mediaPath: null,
    isVideo: false,
    senderName: "示範資料",
    createdAt: new Date(now - 26 * day).toISOString(),
  },
  {
    id: -10,
    url: "https://www.instagram.com/p/mock-10/",
    shortcode: "mock-10",
    kind: "post",
    username: "quiet.wardrobe",
    caption: "中性帥氣：oversize 白襯衫、直筒褲、樂福鞋。",
    mediaPath: null,
    isVideo: false,
    senderName: "示範資料",
    createdAt: new Date(now - 30 * day).toISOString(),
  },
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
