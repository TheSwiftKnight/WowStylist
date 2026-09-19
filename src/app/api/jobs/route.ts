import { NextResponse } from "next/server";
import { listRecentJobs } from "@/lib/jobs";

export const dynamic = "force-dynamic";

// GET /api/jobs — 最近的分析進度（前端每兩秒 poll 一次）
export async function GET(req: Request) {
  const url = new URL(req.url);
  const limitParam = Number(url.searchParams.get("limit"));
  const limit =
    Number.isInteger(limitParam) && limitParam > 0
      ? Math.min(limitParam, 50)
      : 10;

  const jobs = await listRecentJobs(limit);
  const active = jobs.filter(
    (job) => job.status === "queued" || job.status === "running"
  ).length;

  return NextResponse.json({ jobs, active });
}
