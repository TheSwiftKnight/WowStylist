// ingest_jobs：一條 IG 連結 = 一個 job。
//
// Python 的 pipeline 每跑完一個階段就回寫 status / stage，
// Next.js 直接讀這張表就知道「分析中 / 完成 / 失敗」，
// 不用去 poll FastAPI，那支服務重開也不會掉狀態。

import { query } from "@/lib/rds";
import type { IngestJob, JobStatus } from "@/lib/jobTypes";

export { stageLabel } from "@/lib/jobTypes";
export type { IngestJob, JobStatus } from "@/lib/jobTypes";

type Row = {
  id: number;
  url: string;
  shortcode: string | null;
  instagram_type: string | null;
  status: string;
  stage: string | null;
  item_count: number;
  error: string | null;
  sender_name: string | null;
  created_at: Date | string;
  updated_at: Date | string;
};

const SELECT = `
  id, url, shortcode, instagram_type, status, stage,
  item_count, error, sender_name, created_at, updated_at
`;

function toJob(row: Row): IngestJob {
  return {
    id: row.id,
    url: row.url,
    shortcode: row.shortcode,
    instagramType: row.instagram_type,
    status: (row.status as JobStatus) ?? "queued",
    stage: row.stage,
    itemCount: row.item_count ?? 0,
    error: row.error,
    senderName: row.sender_name,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

/** 還在跑的 job（前端進度條用）。 */
export async function listActiveJobs(): Promise<IngestJob[]> {
  try {
    const rows = await query<Row>(
      `SELECT ${SELECT} FROM ingest_jobs
        WHERE status IN ('queued', 'running')
        ORDER BY created_at DESC
        LIMIT 20`
    );
    return rows.map(toJob);
  } catch (err) {
    console.warn("[jobs] 讀不到 ingest_jobs：", err);
    return [];
  }
}

/** 最近的 job（含剛失敗的，讓使用者看得到錯在哪）。 */
export async function listRecentJobs(limit = 10): Promise<IngestJob[]> {
  try {
    const rows = await query<Row>(
      `SELECT ${SELECT} FROM ingest_jobs
        ORDER BY created_at DESC
        LIMIT $1`,
      [limit]
    );
    return rows.map(toJob);
  } catch (err) {
    console.warn("[jobs] 讀不到 ingest_jobs：", err);
    return [];
  }
}

export async function getJob(id: number): Promise<IngestJob | null> {
  const rows = await query<Row>(
    `SELECT ${SELECT} FROM ingest_jobs WHERE id = $1`,
    [id]
  );
  return rows[0] ? toJob(rows[0]) : null;
}

/**
 * 送件失敗時自己補一筆 failed job。
 *
 * 正常情況下 job 是 FastAPI 建的，但「連不上 FastAPI」這種錯誤
 * 根本到不了那裡 —— 不補這筆的話使用者只會看到 LINE 回「正在分析」，
 * 然後永遠沒有下文，前端也沒有任何線索。
 */
export async function createFailedJob(
  url: string,
  error: string,
  extra?: {
    shortcode?: string | null;
    sourceText?: string | null;
    senderId?: string | null;
    senderName?: string | null;
  }
): Promise<void> {
  try {
    await query(
      `INSERT INTO ingest_jobs
         (url, shortcode, status, stage, error,
          source_text, sender_id, sender_name)
       VALUES ($1, $2, 'failed', 'submit', $3, $4, $5, $6)`,
      [
        url,
        extra?.shortcode ?? null,
        error.slice(0, 2000),
        extra?.sourceText ?? null,
        extra?.senderId ?? null,
        extra?.senderName ?? null,
      ]
    );
  } catch (err) {
    // 連資料庫也連不上就只能留在 log 裡了
    console.error("[jobs] 連 failed job 都寫不進去：", err);
  }
}
