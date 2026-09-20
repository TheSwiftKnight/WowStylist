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
 * 送件的逾時。
 *
 * 本機 uvicorn 是毫秒回應，但免費方案的 host（Render 之類）閒置 15 分鐘
 * 會把容器收掉，下一個請求要等它冷啟動 —— 大約一分鐘。
 * 預設給 60 秒並且會重試一次，不然冷啟動當下丟進來的連結一定失敗。
 *
 * 根治方法是讓它不要睡（見 pipeline/README.md 的「別讓它睡著」）。
 */
const TIMEOUT_MS = Number(process.env.PIPELINE_TIMEOUT_MS ?? 60_000);

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

  const body = JSON.stringify({
    url,
    source_text: extra?.sourceText ?? null,
    sender_id: extra?.senderId ?? null,
    sender_name: extra?.senderName ?? null,
  });

  async function send(timeoutMs: number): Promise<Response> {
    return fetch(`${baseUrl()}/ingest`, {
      method: "POST",
      headers,
      body,
      signal: AbortSignal.timeout(timeoutMs),
    });
  }

  let res: Response;

  try {
    res = await send(TIMEOUT_MS);
  } catch (firstError) {
    // 冷啟動的話第一發常常就是被自己的 timeout 砍掉的，
    // 但這時容器其實已經在起了，再試一次通常就通。
    console.warn(
      `[pipeline] 第一次送件失敗（${String(firstError)}），重試一次…`
    );

    try {
      res = await send(TIMEOUT_MS);
    } catch (err) {
      throw new PipelineError(
        `連不上分析服務（${baseUrl()}）。它有跑起來嗎？` +
          `免費方案的話可能正在冷啟動。 ${String(err)}`,
        503
      );
    }
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
    signal: AbortSignal.timeout(TIMEOUT_MS),
    cache: "no-store",
  });
  return res.json();
}

/**
 * 叫醒服務，不等它回答。
 *
 * 睡著的容器收到任何請求就會開始起來。webhook 在確定有 IG 連結、
 * 還在跟 LINE 要使用者名稱的時候先打這一下，等真的要送件時
 * 往往已經起來了。
 */
export function warmUp(): void {
  fetch(`${baseUrl()}/health`, {
    signal: AbortSignal.timeout(TIMEOUT_MS),
    cache: "no-store",
  }).catch(() => {
    // 叫不醒就算了，requestIngest 那邊還會重試
  });
}
