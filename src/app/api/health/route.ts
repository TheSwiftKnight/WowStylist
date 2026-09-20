import { NextResponse } from "next/server";
import {
  fashionTable,
  productsTable,
  query,
  queryProducts,
  hasSeparateProductsDb,
} from "@/lib/rds";
import { listStyles, loadStyleCandidates, resolveProductSource } from "@/lib/rank";

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
    productsDbHost: maskHost(process.env.PRODUCTS_DB_HOST),
    productsTable,
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
        "連不到 RDS。你自己的電腦連得上、但這台伺服器連不上，" +
        "就是 security group 的 inbound 只開了你的 IP。" +
        "Vercel 沒有固定 IP 範圍，要嘛開 0.0.0.0/0，" +
        "要嘛不要從 Vercel 連（把 webhook 指回本機的 ngrok）。",
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

    if (res.status === 404) {
      return {
        ok: false,
        url,
        detail: "HTTP 404 —— 這個網址有東西在回應，但它不是分析服務。",
        hint:
          "ngrok 八成指到 3000（Next.js）而不是 8000（FastAPI）。" +
          "Next.js 沒有 /health 這條路由，所以回 404。" +
          "正確做法：ngrok http 8000。",
      };
    }

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

// ── 商品 RDS（跟 IG 那台是分開的兩台）─────────────────────
async function checkProductsDatabase(): Promise<Check> {
  if (!hasSeparateProductsDb) {
    return {
      ok: true,
      separate: false,
      detail: "PRODUCTS_DB_HOST 沒設，商品沿用 IG 那條連線",
    };
  }

  try {
    const [row] = await queryProducts<{ n: string }>(
      `SELECT count(*)::text AS n FROM ${productsTable}`
    );

    return {
      ok: true,
      separate: true,
      host: maskHost(process.env.PRODUCTS_DB_HOST),
      table: productsTable,
      rowCount: Number(row?.n ?? 0),
    };
  } catch (err) {
    return {
      ok: false,
      separate: true,
      host: maskHost(process.env.PRODUCTS_DB_HOST),
      table: productsTable,
      detail: String(err),
      hint:
        "連不到商品 RDS。跟 IG 那台一樣，security group 要放行這台伺服器的 IP。",
    };
  }
}

// ── 推薦引擎（style_kb + 商品向量 + 使用者偏好）─────────────
async function checkRecommender(): Promise<Check> {
  const styles = listStyles();

  if (styles.length === 0) {
    return {
      ok: false,
      detail: "讀不到 data/style-kb/style_kb.jsonl",
    };
  }

  // 拿第一個風格當樣本，看 matches 有沒有真的寫進去
  const sample = loadStyleCandidates(styles[0].style);

  if (!sample) {
    return {
      ok: false,
      styleCount: styles.length,
      detail:
        "style_kb.jsonl 裡沒有 matches 欄位 —— 應該覆寫成 " +
        "build_style_lookup.py 產出的 style_kb_matched.jsonl",
    };
  }

  const source = await resolveProductSource();

  if (!source) {
    return {
      ok: false,
      styleCount: styles.length,
      sampleStyle: {
        style: sample.style,
        top: sample.top.length,
        bottom: sample.bottom.length,
      },
      detail: hasSeparateProductsDb
        ? `商品 RDS 上找不到帶 embedding 的 ${productsTable} 表`
        : "PRODUCTS_DB_HOST 沒設，而 IG 這台上找不到商品向量",
      hint: hasSeparateProductsDb
        ? "確認 PRODUCTS_DB_* 指對機器、PRODUCTS_TABLE 表名對、" +
          "security group 有放行這台伺服器的 IP"
        : "商品在另一台 RDS 的話要設 PRODUCTS_DB_HOST / _PORT / _NAME / " +
          "_USER / _PASSWORD（見 .env.example）",
    };
  }

  let productCount: number | null = null;
  try {
    const conditions = ["embedding IS NOT NULL"];
    if (source.sourceFilter) conditions.push("source = 'product'");

    const run = source.database === "products" ? queryProducts : query;

    const [row] = await run<{ n: string }>(
      `SELECT count(*)::text AS n FROM ${source.table}
        WHERE ${conditions.join(" AND ")}`
    );
    productCount = Number(row?.n ?? 0);
  } catch {
    productCount = null;
  }

  let prefCount: number | null = null;
  try {
    const [row] = await query<{ n: string }>(
      `SELECT count(*)::text AS n FROM ${fashionTable}
        WHERE source = 'instagram' AND embedding IS NOT NULL`
    );
    prefCount = Number(row?.n ?? 0);
  } catch {
    prefCount = null;
  }

  return {
    ok: true,
    styleCount: styles.length,
    sampleStyle: {
      style: sample.style,
      styleZh: sample.styleZh,
      top: sample.top.length,
      bottom: sample.bottom.length,
    },
    productSource: {
      database: source.database === "products" ? "商品 RDS" : "IG RDS（共用）",
      table: source.table,
      idColumn: source.idColumn,
      sourceFilter: source.sourceFilter,
      bottomCategory: source.bottomCategory,
      productsWithEmbedding: productCount,
    },
    // 使用者偏好的來源：pipeline 寫進來的 IG 單品
    igGarmentsWithEmbedding: prefCount,
    hfTokenSet: Boolean(process.env.HF_TOKEN),
  };
}

export async function GET() {
  const onVercel = Boolean(process.env.VERCEL);

  const env = checkEnv();

  const [database, productsDatabase, pipeline, recommender] = await Promise.all([
    checkDatabase(),
    checkProductsDatabase().catch((err) => ({ ok: false, detail: String(err) })),
    checkPipeline(onVercel),
    checkRecommender().catch((err) => ({ ok: false, detail: String(err) })),
  ]);

  const checks = { env, database, productsDatabase, pipeline, recommender };

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
    {
      status: problems.length === 0 ? 200 : 503,
      // 不標 charset 的話有些 viewer 會把中文當 latin-1 顯示成亂碼
      headers: { "Content-Type": "application/json; charset=utf-8" },
    }
  );
}
