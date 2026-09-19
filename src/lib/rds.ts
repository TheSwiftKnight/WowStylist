// Instagram RDS（PostgreSQL）連線池。
//
// 原本這裡是 Prisma。Prisma 已經拿掉了 —— 資料是 ./pipeline 的 Python 在寫，
// schema 由 pipeline/migrations/001_fashion_items.sql 管，
// Next.js 這側只負責「讀」，所以直接用 pg 下 SQL 最單純，
// 也不用再維護一份會跟 Python 端對不起來的 schema.prisma。

import { Pool } from "pg";
import { isIP } from "node:net";

const globalForPg = globalThis as unknown as {
  pgPool?: Pool;
  pgFallbackPromise?: Promise<Pool | null>;
};

const PUBLIC_DNS_URL = "https://dns.google/resolve";

function isRdsHostname(host: string): boolean {
  return (
    host.includes(".rds.") &&
    (host.endsWith(".amazonaws.com") || host.endsWith(".amazonaws.com.cn"))
  );
}

function isPublicIpv4(value: string): boolean {
  if (isIP(value) !== 4) return false;

  const [a, b] = value.split(".").map(Number);

  return !(
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    a >= 224
  );
}

async function resolvePublicHost(host: string): Promise<string | null> {
  if (!isRdsHostname(host)) return null;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 4_000);

  try {
    const url = new URL(PUBLIC_DNS_URL);
    url.searchParams.set("name", host);
    url.searchParams.set("type", "A");

    const response = await fetch(url, {
      headers: { accept: "application/dns-json" },
      signal: controller.signal,
      cache: "no-store",
    });

    if (!response.ok) return null;

    const payload = (await response.json()) as {
      Answer?: Array<{ data?: string }>;
    };

    for (const answer of payload.Answer ?? []) {
      const value = (answer.data ?? "").replace(/\.$/, "");
      if (isPublicIpv4(value)) return value;
    }

    return null;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function isNetworkError(error: unknown): boolean {
  const candidate = error as { code?: string; message?: string };
  const code = candidate?.code ?? "";
  const message = (candidate?.message ?? String(error)).toLowerCase();

  return (
    ["ETIMEDOUT", "EHOSTUNREACH", "ENETUNREACH", "EAI_AGAIN"].includes(
      code
    ) ||
    message.includes("timeout") ||
    message.includes("timed out") ||
    message.includes("no route to host") ||
    message.includes("network is unreachable")
  );
}

function createPool(connectHost?: string): Pool {
  const { DB_HOST, DB_PORT, DB_NAME, DB_USER, DB_PASSWORD, DB_SSLMODE } =
    process.env;

  if (!DB_HOST || !DB_NAME || !DB_USER || !DB_PASSWORD) {
    throw new Error(
      "資料庫環境變數沒設齊（需要 DB_HOST / DB_NAME / DB_USER / DB_PASSWORD），看 .env.example"
    );
  }

  return new Pool({
    host: connectHost ?? DB_HOST,
    port: Number(DB_PORT ?? 5432),
    database: DB_NAME,
    user: DB_USER,
    password: DB_PASSWORD,
    // RDS 用的是 AWS 自己簽的憑證，Node 預設信任鏈裡沒有，
    // 所以 require SSL 但不驗憑證鏈（跟 Python 端的 sslmode=require 一致）。
    ssl:
      (DB_SSLMODE ?? "require") === "disable"
        ? undefined
        : {
            rejectUnauthorized: false,
            // 公開 DNS fallback 會直接連 IP；仍保留原 hostname 給 TLS SNI。
            servername: DB_HOST,
          },
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

async function getPublicFallbackPool(error: unknown): Promise<Pool | null> {
  const host = process.env.DB_HOST;

  if (!host || !isNetworkError(error) || !isRdsHostname(host)) {
    return null;
  }

  if (!globalForPg.pgFallbackPromise) {
    globalForPg.pgFallbackPromise = (async () => {
      const publicIp = await resolvePublicHost(host);

      if (!publicIp) return null;

      console.warn(
        `[DB] ${host} 的一般 DNS 連線失敗；改用公共 DNS 位址 ${publicIp} 重試。`
      );

      const oldPool = globalForPg.pgPool;
      const fallbackPool = createPool(publicIp);
      globalForPg.pgPool = fallbackPool;

      if (oldPool) void oldPool.end().catch(() => undefined);

      return fallbackPool;
    })();
  }

  const pending = globalForPg.pgFallbackPromise;

  try {
    return await pending;
  } finally {
    // 只在同一次 fallback 中共用 Promise。RDS failover 後公開 IP 可能會改，
    // 下一次網路錯誤必須重新查 DNS，不能永久記住舊 IP。
    if (globalForPg.pgFallbackPromise === pending) {
      globalForPg.pgFallbackPromise = undefined;
    }
  }
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
  try {
    const result = await getPool().query(text, params);
    return result.rows as T[];
  } catch (error) {
    const fallbackPool = await getPublicFallbackPool(error);

    if (!fallbackPool) throw error;

    const result = await fallbackPool.query(text, params);
    return result.rows as T[];
  }
}
