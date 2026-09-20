// 資料庫連線。這個專案有「兩台」PostgreSQL：
//
//   1. IG RDS（DB_*）—— pipeline 寫進來的 IG 單品、ingest_jobs、style_tags
//      網站的收藏夾、風向標、使用者偏好都讀這台。
//
//   2. 商品 RDS（PRODUCTS_DB_*）—— 電商商品和它們的向量。
//      只有推薦排序（src/lib/rank.ts）會讀，而且只讀不寫。
//
// PRODUCTS_DB_HOST 沒設的話，商品那邊會退回用 IG 這條連線 ——
// 兩批資料放同一台的情況（或本機測試）就不用多設一組。
//
// 原本這裡是 Prisma。Prisma 已經拿掉了 —— 資料是 ./pipeline 的 Python 在寫，
// schema 由 pipeline/migrations/001_fashion_items.sql 管，
// 再維護一份會跟 Python 端對不起來的 schema.prisma 沒有意義。

import { Pool } from "pg";

type PoolKind = "ig" | "products";

const globalForPg = globalThis as unknown as {
  pgPool?: Pool;
  pgProductsPool?: Pool;
};

function envOf(kind: PoolKind, key: string): string | undefined {
  const prefix = kind === "products" ? "PRODUCTS_DB_" : "DB_";
  return process.env[`${prefix}${key}`];
}

/** 商品有沒有自己的一台。沒有就跟 IG 共用同一條連線。 */
export const hasSeparateProductsDb = Boolean(process.env.PRODUCTS_DB_HOST);

function createPool(kind: PoolKind): Pool {
  const host = envOf(kind, "HOST");
  const name = envOf(kind, "NAME");
  const user = envOf(kind, "USER");
  const password = envOf(kind, "PASSWORD");

  if (!host || !name || !user || !password) {
    const prefix = kind === "products" ? "PRODUCTS_DB_" : "DB_";
    throw new Error(
      `資料庫環境變數沒設齊（需要 ${prefix}HOST / ${prefix}NAME / ` +
        `${prefix}USER / ${prefix}PASSWORD），看 .env.example`
    );
  }

  return new Pool({
    host,
    port: Number(envOf(kind, "PORT") ?? 5432),
    database: name,
    user,
    password,
    // RDS 用的是 AWS 自己簽的憑證，Node 預設信任鏈裡沒有，
    // 所以 require SSL 但不驗憑證鏈（跟 Python 端的 sslmode=require 一致）。
    ssl:
      (envOf(kind, "SSLMODE") ?? "require") === "disable"
        ? undefined
        : { rejectUnauthorized: false },
    max: 5,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: Number(envOf(kind, "CONNECT_TIMEOUT") ?? 10) * 1000,
  });
}

// 連線池是「用到才開」的。
// 在 module 層直接 new 的話，next build 光是 import 這支就會因為
// 還沒有 .env 而整個 build 掛掉。
// Next.js dev 會熱重載，所以池子掛在 globalThis 上，避免每次重載都開一池新的。
export function getPool(): Pool {
  if (!globalForPg.pgPool) {
    globalForPg.pgPool = createPool("ig");
  }
  return globalForPg.pgPool;
}

/** 商品那台。沒有單獨設定時就是 IG 那條。 */
export function getProductsPool(): Pool {
  if (!hasSeparateProductsDb) return getPool();

  if (!globalForPg.pgProductsPool) {
    globalForPg.pgProductsPool = createPool("products");
  }
  return globalForPg.pgProductsPool;
}

/** IG 單品表。schema 見 pipeline/migrations/001_fashion_items.sql。 */
export const FASHION_TABLE = process.env.FASHION_TABLE ?? "fashion_items";

/** 商品表。 */
export const PRODUCTS_TABLE = process.env.PRODUCTS_TABLE ?? "products";

/** 表名不能用參數化，所以只允許單純的識別字。 */
function assertSafeIdentifier(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new Error(`不合法的表名：${name}`);
  }
  return name;
}

export const fashionTable = assertSafeIdentifier(FASHION_TABLE);
export const productsTable = assertSafeIdentifier(PRODUCTS_TABLE);

/** 對 IG 那台下 SQL。 */
export async function query<T extends Record<string, unknown>>(
  text: string,
  params: unknown[] = []
): Promise<T[]> {
  const result = await getPool().query(text, params);
  return result.rows as T[];
}

/** 對商品那台下 SQL。 */
export async function queryProducts<T extends Record<string, unknown>>(
  text: string,
  params: unknown[] = []
): Promise<T[]> {
  const result = await getProductsPool().query(text, params);
  return result.rows as T[];
}
