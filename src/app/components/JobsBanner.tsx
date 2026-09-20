"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { stageLabel, type IngestJob } from "@/lib/jobTypes";

/**
 * 分析進度條。
 *
 * pipeline 是非同步的：連結送出去之後 Apify → Claude Vision → BGE-M3
 * 要跑幾十秒到幾分鐘。這個元件每兩秒問一次 /api/jobs，
 * 有 job 從「跑完」變成 done 就 router.refresh() 把新卡片拉進來。
 */
export default function JobsBanner({
  initialJobs,
}: {
  initialJobs: IngestJob[];
}) {
  const router = useRouter();
  const [jobs, setJobs] = useState<IngestJob[]>(initialJobs);

  const active = jobs.filter(
    (job) => job.status === "queued" || job.status === "running"
  );

  useEffect(() => {
    if (active.length === 0) return;

    let cancelled = false;

    const timer = setInterval(async () => {
      try {
        const res = await fetch("/api/jobs", { cache: "no-store" });
        if (!res.ok) return;

        const data = (await res.json()) as { jobs: IngestJob[] };
        if (cancelled) return;

        const stillActive = data.jobs.filter(
          (job) => job.status === "queued" || job.status === "running"
        ).length;

        setJobs(data.jobs);

        // 全部跑完了 → 把新寫進 RDS 的單品撈上來
        if (stillActive === 0) router.refresh();
      } catch {
        // 網路抖一下就算了，下一輪再說
      }
    }, 2000);

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [active.length, router]);

  const failed = jobs.filter((job) => job.status === "failed").slice(0, 3);

  if (active.length === 0 && failed.length === 0) return null;

  return (
    <div className="jobs-banner">
      {active.map((job) => (
        <div className="jobs-row" key={job.id}>
          <span className="jobs-dot" aria-hidden="true" />
          <span className="jobs-code">{job.shortcode ?? "解析中"}</span>
          <span className="jobs-stage">{stageLabel(job.stage)}…</span>
        </div>
      ))}

      {failed.map((job) => (
        <div className="jobs-row jobs-row--failed" key={job.id}>
          <span className="jobs-dot jobs-dot--failed" aria-hidden="true" />
          <span className="jobs-code">{job.shortcode ?? "—"}</span>
          <span className="jobs-stage">
            分析失敗{job.error ? `：${job.error.slice(0, 80)}` : ""}
          </span>
        </div>
      ))}
    </div>
  );
}
