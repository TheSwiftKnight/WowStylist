// 塞幾筆範例資料，讓頁面一打開就有東西看
// 執行：npm run db:seed
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const samples = [
  {
    // 世界紀錄雞蛋（world_record_egg），公開且長青的貼文，適合當範例
    url: "https://www.instagram.com/p/BsOGulcndj-/",
    shortcode: "BsOGulcndj-",
    kind: "post",
    sourceText: "範例資料：world record egg",
    senderName: "範例",
  },
  {
    // Messi 世界盃奪冠貼文
    url: "https://www.instagram.com/p/CmXjgUZLibW/",
    shortcode: "CmXjgUZLibW",
    kind: "post",
    sourceText: "範例資料：Messi World Cup",
    senderName: "範例",
  },
];

for (const s of samples) {
  await prisma.sharedLink.upsert({
    where: { shortcode: s.shortcode },
    update: {},
    create: s,
  });
}

console.log(`Seeded ${samples.length} sample links.`);

// ── style 風向標的起始標籤 ──────────────────────────────────────────────
// 只在資料表是空的時候塞，避免蓋掉使用者自己編過的內容。
const tagCount = await prisma.styleTag.count();
if (tagCount === 0) {
  const tags = [
    { label: "法式復古", kind: "style", weight: 0.95 },
    { label: "極簡侘寂", kind: "style", weight: 0.72 },
    { label: "學院風", kind: "style", weight: 0.58 },
    { label: "中性帥氣", kind: "style", weight: 0.81 },
    { label: "芭蕾風", kind: "style", weight: 0.44 },
    { label: "都會通勤", kind: "style", weight: 0.67 },
    { label: "戶外機能", kind: "style", weight: 0.31 },
    { label: "老錢風", kind: "style", weight: 0.88 },
    { label: "奶油白", kind: "color", weight: 0.9 },
    { label: "灰調莫蘭迪", kind: "color", weight: 0.76 },
    { label: "焦糖棕", kind: "color", weight: 0.63 },
    { label: "墨綠", kind: "color", weight: 0.55 },
    { label: "霧霾藍", kind: "color", weight: 0.49 },
    { label: "燕麥米", kind: "color", weight: 0.7 },
    { label: "鏽紅", kind: "color", weight: 0.27 },
    { label: "鬆弛感", kind: "mood", weight: 0.93 },
    { label: "高級感", kind: "mood", weight: 0.6 },
    { label: "乾淨俐落", kind: "mood", weight: 0.52 },
    { label: "慵懶", kind: "mood", weight: 0.38 },
    { label: "有故事感", kind: "mood", weight: 0.46 },
  ];
  await prisma.styleTag.createMany({ data: tags });
  console.log(`Seeded ${tags.length} style tags.`);
} else {
  console.log(`Style tags already present (${tagCount}), skipped.`);
}

await prisma.$disconnect();
