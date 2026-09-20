// ingest_jobs 的型別與顯示文字。
//
// 單獨拉一支是因為 client component（JobsBanner）要用 stageLabel，
// 而 src/lib/jobs.ts 會 import pg —— 那包不能進瀏覽器的 bundle。

export type JobStatus = "queued" | "running" | "done" | "failed";

export type IngestJob = {
  id: number;
  url: string;
  shortcode: string | null;
  instagramType: string | null;
  status: JobStatus;
  stage: string | null;
  itemCount: number;
  error: string | null;
  senderName: string | null;
  createdAt: string;
  updatedAt: string;
};

/** pipeline 各階段的中文說明（對應 fashion_retrieval/pipeline.py 的 stage()）。 */
const STAGES: Record<string, string> = {
  apify: "抓取貼文",
  parse: "取出畫面",
  filter: "篩掉沒用的圖",
  analyze: "辨識服裝",
  encode: "產生語意向量",
  write: "寫入資料庫",
};

export function stageLabel(stage: string | null): string {
  if (!stage) return "排隊中";
  return STAGES[stage] ?? stage;
}
