import { prisma } from "@/lib/db";
import { MOCK_LINKS, type BoardLink } from "@/lib/mock";

export type { BoardLink };

export type LinksResult = {
  links: BoardLink[];
  /** true = 這批是 mock 資料，不是真的資料庫內容 */
  isMock: boolean;
  /** 還沒抓到 IG 內容的筆數（mock 時恆為 0） */
  pendingCount: number;
};

/**
 * 收藏夾的資料來源。
 *
 * 現況：走現有的 Prisma（prisma/dev.db）。
 * 之後上 Amazon RDS：只要把 prisma/schema.prisma 的 datasource 換成
 *   provider = "postgresql"、DATABASE_URL 指到 RDS，再跑 `npx prisma db push`，
 * 這個函式完全不用改。
 *
 * 資料庫連不上、或是一筆都沒有時，回傳 src/lib/mock.ts 的示範資料，
 * 這樣 UI 在 DB 還沒建好之前也看得到完整版面。
 */
export async function getLinks(): Promise<LinksResult> {
  try {
    const rows = await prisma.sharedLink.findMany({
      orderBy: { createdAt: "desc" },
    });

    if (rows.length === 0) {
      return { links: MOCK_LINKS, isMock: true, pendingCount: 0 };
    }

    return {
      links: rows.map((row) => ({
        id: row.id,
        url: row.url,
        kind: row.kind,
        username: row.username,
        caption: row.caption,
        mediaPath: row.mediaPath,
        isVideo: row.isVideo,
        senderName: row.senderName,
        createdAt: row.createdAt.toISOString(),
      })),
      isMock: false,
      pendingCount: rows.filter((row) => row.fetchStatus !== "ok").length,
    };
  } catch (err) {
    console.warn("[links] 讀不到資料庫，改用 mock 資料：", err);
    return { links: MOCK_LINKS, isMock: true, pendingCount: 0 };
  }
}
