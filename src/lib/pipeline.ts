// 呼叫 ./pipeline 的 FastAPI service（同一個 repo，但是獨立的 Python 行程）。
//
//   Next.js  ──POST /ingest──>  FastAPI  ──背景──>  Apify → Claude → BGE-M3 → RDS
//
// 這支只負責「把連結丟過去」。整條 pipeline 要跑幾十秒到幾分鐘，
// 所以 FastAPI 立刻回一個 job_id，進度寫在 RDS 的 ingest_jobs，
// 前端從 /api/jobs 讀（見 src/lib/jobs.ts）。

export type IngestTicket = {
  jobId: number;
  url: string;
  shortcode: string;
  status: string;
};

export class PipelineError extends Error {
  status: number;
  constructor(message: string, status = 502) {
    super(message);
    this.name = "PipelineError";
    this.status = status;
  }
}

function baseUrl(): string {
  return (
    process.env.PIPELINE_API_URL ?? "http://127.0.0.1:8000"
  ).replace(/\/+$/, "");
}

/**
 * 把一條 IG 連結送進 pipeline。
 *
 * 丟出去就回來，不等 pipeline 跑完 —— LINE webhook 只有幾秒可以用。
 */
export async function requestIngest(
  url: string,
  extra?: {
    sourceText?: string | null;
    senderId?: string | null;
    senderName?: string | null;
  }
): Promise<IngestTicket> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  if (process.env.PIPELINE_TOKEN) {
    headers["x-pipeline-token"] = process.env.PIPELINE_TOKEN;
  }

  let res: Response;

  try {
    res = await fetch(`${baseUrl()}/ingest`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        url,
        source_text: extra?.sourceText ?? null,
        sender_id: extra?.senderId ?? null,
        sender_name: extra?.senderName ?? null,
      }),
      // 只是建 job，應該很快就回
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    throw new PipelineError(
      `連不上分析服務（${baseUrl()}）。它有跑起來嗎？ ${String(err)}`,
      503
    );
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new PipelineError(
      `分析服務回 HTTP ${res.status}：${text.slice(0, 300)}`,
      res.status === 422 ? 422 : 502
    );
  }

  const data = (await res.json()) as {
    job_id: number;
    url: string;
    shortcode: string;
    status: string;
  };

  return {
    jobId: data.job_id,
    url: data.url,
    shortcode: data.shortcode,
    status: data.status,
  };
}

/** 服務健康檢查（設定頁 / 除錯用）。 */
export async function pipelineHealth(): Promise<unknown> {
  const res = await fetch(`${baseUrl()}/health`, {
    signal: AbortSignal.timeout(8_000),
    cache: "no-store",
  });
  return res.json();
}
