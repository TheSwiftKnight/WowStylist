import { NextResponse } from "next/server";
import { fashionTable, query } from "@/lib/rds";

export const dynamic = "force-dynamic";

// GET /api/health — 一次看完整條鏈路活著沒。
//
// 在瀏覽器直接開 https://<你的網域>/api/health 就好。
// 不回傳任何金鑰，只回「有沒有設」以及連不連得上。

type Check = {
  ok: boolean;
  detail?: string;
  [key: string]: unknown;
};

/** 只露出足夠辨認的部分，不要把完整 endpoint 放在公開頁面上。 */
function maskHost(host: string | undefined): string | null {
  if (!host) return null;
  const parts = host.split(".");
  if (parts.length < 3) return `${parts[0]}.***`;
  return `${parts[0]}.***.${parts.slice(-3).join(".")}`;
}

function isLoopback(url: string): boolean {
  try {
    const { hostname } = new URL(url);
    return (
      hostname === "localhost" ||
      hostname === "127.0.0.1" ||
      hostname === "::1" ||
      hostname === "0.0.0.0"
    );
  } catch {
    return false;
  }
}

// ── 環境變數 ────────────────────────────────────────────────
function checkEnv(): Check {
  const required = [
    "LINE_CHANNEL_SECRET",
    "LINE_CHANNEL_ACCESS_TOKEN",
    "DB_HOST",
    "DB_NAME",
    "DB_USER",
    "DB_PASSWORD",
    "PIPELINE_API_URL",
  ];

  const missing = required.filter((key) => !process.env[key]);

  return {
    ok: missing.length === 0,
    missing,
    dbHost: maskHost(process.env.DB_HOST),
    fashionTable,
    pipelineApiUrl: process.env.PIPELINE_API_URL ?? null,
    pipelineTokenSet: Boolean(process.env.PIPELINE_TOKEN),
  };
}

// ── 資料庫 ──────────────────────────────────────────────────
async function checkDatabase(): Promise<Check> {
  try {
    const tables = await query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public'
          AND table_name = ANY($1)`,
      [[fashionTable, "ingest_jobs", "style_tags"]]
    );

    const found = tables.map((t) => t.table_name);
    const missing = [fashionTable, "ingest_jobs", "style_tags"].filter(
      (t) => !found.includes(t)
    );

    if (missing.length > 0) {
      return {
        ok: false,
        detail: `缺少資料表：${missing.join(", ")} —— migration 還沒跑`,
        tables: found,
      };
    }

    const [items] = await query<{ n: string }>(
      `SELECT count(*)::text AS n FROM ${fashionTable}`
    );
    const [jobs] = await query<{ n: string }>(
      `SELECT count(*)::text AS n FROM ingest_jobs`
    );
    const recent = await query<{
      id: number;
      shortcode: string | null;
      status: string;
      stage: string | null;
      item_count: number;
      error: string | null;
      created_at: Date;
    }>(
      `SELECT id, shortcode, status, stage, item_count, error, created_at
         FROM ingest_jobs ORDER BY id DESC LIMIT 5`
    );

    return {
      ok: true,
      itemCount: Number(items.n),
      jobCount: Number(jobs.n),
      recentJobs: recent.map((j) => ({
        id: j.id,
        shortcode: j.shortcode,
        status: j.status,
        stage: j.stage,
        itemCount: j.item_count,
        error: j.error,
        createdAt: new Date(j.created_at).toISOString(),
      })),
    };
  } catch (err) {
    return {
      ok: false,
      detail: String(err),
      hint:
        "連不到 RDS。security group 有開放這台伺服器的 IP 嗎？" +
        "Vercel 沒有固定 IP，只開 My IP 的話伺服器端會連不進來。",
    };
  }
}

// ── 分析服務 ────────────────────────────────────────────────
async function checkPipeline(onVercel: boolean): Promise<Check> {
  const url = process.env.PIPELINE_API_URL;

  if (!url) {
    return { ok: false, detail: "PIPELINE_API_URL 沒設" };
  }

  if (onVercel && isLoopback(url)) {
    return {
      ok: false,
      url,
      detail:
        "PIPELINE_API_URL 指向 localhost，但這支 API 跑在 Vercel 上 —— " +
        "那是 Vercel 容器自己的 localhost，不是你的電腦，永遠連不到。",
      hint:
        "把分析服務也開出去（ngrok http 8000）然後改這個環境變數，" +
        "或者把 LINE 的 webhook 改指到本機的 ngrok。",
    };
  }

  try {
    const res = await fetch(`${url.replace(/\/+$/, "")}/health`, {
      signal: AbortSignal.timeout(8000),
      cache: "no-store",
    });

    if (!res.ok) {
      return { ok: false, url, detail: `HTTP ${res.status}` };
    }

    return { ok: true, url, service: await res.json() };
  } catch (err) {
    return {
      ok: false,
      url,
      detail: String(err),
      hint: "分析服務沒跑起來，或這個網址從這台伺服器連不到。",
    };
  }
}

export async function GET() {
  const onVercel = Boolean(process.env.VERCEL);

  const env = checkEnv();

  const [database, pipeline] = await Promise.all([
    checkDatabase(),
    checkPipeline(onVercel),
  ]);

  const checks = { env, database, pipeline };

  const problems = Object.entries(checks)
    .filter(([, check]) => !check.ok)
    .map(([name]) => name);

  return NextResponse.json(
    {
      ok: problems.length === 0,
      problems,
      runtime: {
        onVercel,
        vercelEnv: process.env.VERCEL_ENV ?? null,
        region: process.env.VERCEL_REGION ?? null,
        nodeEnv: process.env.NODE_ENV,
      },
      checks,
    },
    { status: problems.length === 0 ? 200 : 503 }
  );
}
