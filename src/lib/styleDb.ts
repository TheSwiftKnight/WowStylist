// 風格標籤資料庫（Vercel Marketplace 上的 Prisma Postgres）連線池。
//
// 跟 src/lib/rds.ts 是兩台不同的資料庫，故意分開：
//   rds.ts      → IG 那台 RDS，pipeline 寫、網站讀，重跑會被蓋掉
//   styleDb.ts  → 這台，只放「人挑過的」風格標籤，pipeline 碰不到
//
// schema 見 pipeline/migrations/002_garment_style_tags.sql。

import { Pool } from "pg";

const globalForStylePg = globalThis as unknown as { stylePool?: Pool };

/**
 * Prisma Postgres 的連線字串。
 *
 * Marketplace 接上去之後會注入 DATABASE_URL；Prisma 自家的 Accelerate
 * 另外給一條 prisma+postgres:// 的（那條 pg 連不了，只有 Prisma Client 能用），
 * 所以這裡只認一般的 postgres://。
 */
function connectionString(): string {
  const url = process.env.STYLE_DATABASE_URL ?? process.env.DATABASE_URL;

  if (!url) {
    throw new Error(
      "風格標籤資料庫沒設定（需要 DATABASE_URL），跑 `vercel env pull` 拿"
    );
  }

  if (url.startsWith("prisma+postgres://") || url.startsWith("prisma://")) {
    throw new Error(
      "DATABASE_URL 是 Prisma Accelerate 的位址，pg 連不上；" +
        "要 Prisma Postgres 儀表板上那條 postgres:// 開頭的直連字串"
    );
  }

  return url;
}

// 跟 rds.ts 一樣「用到才開」：module 層直接 new 的話，
// next build 會在還沒有環境變數的時候就整個掛掉。
export function getStylePool(): Pool {
  if (!globalForStylePg.stylePool) {
    globalForStylePg.stylePool = new Pool({
      connectionString: connectionString(),
      ssl: { rejectUnauthorized: false },
      max: 3,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
    });
  }
  return globalForStylePg.stylePool;
}

export async function styleQuery<T extends Record<string, unknown>>(
  text: string,
  params: unknown[] = []
): Promise<T[]> {
  const result = await getStylePool().query(text, params);
  return result.rows as T[];
}
