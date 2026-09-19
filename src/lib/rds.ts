// Instagram RDS（PostgreSQL）連線池。
//
// 原本這裡是 Prisma。Prisma 已經拿掉了 —— 資料是 ./pipeline 的 Python 在寫，
// schema 由 pipeline/migrations/001_fashion_items.sql 管，
// Next.js 這側只負責「讀」，所以直接用 pg 下 SQL 最單純，
// 也不用再維護一份會跟 Python 端對不起來的 schema.prisma。

import { Pool } from "pg";

const globalForPg = globalThis as unknown as { pgPool?: Pool };

function createPool(): Pool {
  const { DB_HOST, DB_PORT, DB_NAME, DB_USER, DB_PASSWORD, DB_SSLMODE } =
    process.env;

  if (!DB_HOST || !DB_NAME || !DB_USER || !DB_PASSWORD) {
    throw new Error(
      "資料庫環境變數沒設齊（需要 DB_HOST / DB_NAME / DB_USER / DB_PASSWORD），看 .env.example"
    );
  }

  return new Pool({
    host: DB_HOST,
    port: Number(DB_PORT ?? 5432),
    database: DB_NAME,
    user: DB_USER,
    password: DB_PASSWORD,
    // RDS 用的是 AWS 自己簽的憑證，Node 預設信任鏈裡沒有，
    // 所以 require SSL 但不驗憑證鏈（跟 Python 端的 sslmode=require 一致）。
    ssl:
      (DB_SSLMODE ?? "require") === "disable"
        ? undefined
        : { rejectUnauthorized: false },
    max: 5,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  });
}

// 連線池是「用到才開」的。
// 在 module 層直接 new 的話，next build 光是 import 這支就會因為
// 還沒有 .env 而整個 build 掛掉。
// Next.js dev 會熱重載，所以池子掛在 globalThis 上，避免每次重載都開一池新的。
export function getPool(): Pool {
  if (!globalForPg.pgPool) {
    globalForPg.pgPool = createPool();
  }
  return globalForPg.pgPool;
}

/** 統一的單品表。schema 見 pipeline/migrations/001_fashion_items.sql。 */
export const FASHION_TABLE = process.env.FASHION_TABLE ?? "fashion_items";

/** 表名不能用參數化，所以只允許單純的識別字。 */
function assertSafeIdentifier(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new Error(`不合法的表名：${name}`);
  }
  return name;
}

export const fashionTable = assertSafeIdentifier(FASHION_TABLE);

export async function query<T extends Record<string, unknown>>(
  text: string,
  params: unknown[] = []
): Promise<T[]> {
  const result = await getPool().query(text, params);
  return result.rows as T[];
}
