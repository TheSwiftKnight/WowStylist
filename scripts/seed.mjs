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
await prisma.$disconnect();
