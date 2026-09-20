"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { stageLabel, type IngestJob } from "@/lib/jobTypes";

/**
 * 分析進度條。
 *
 * pipeline 是非同步的：連結送出去之後 Apify → Claude Vision → BGE-M3
 * 要跑幾十秒到幾分鐘。這個元件每兩秒問一次 /api/jobs，
 * 有 job 從「跑完」變成 done 就 router.refresh() 把新卡片拉進來，
 * 同時打一次 /api/tags/sync —— 新單品的 text_description 丟給 Claude
 * 標成三個標籤，這樣 style 風向標上馬上看得到這次收藏的風格。
 */
export default function JobsBanner({
  initialJobs,
}: {
  initialJobs: IngestJob[];
}) {
  const router = useRouter();
  const [jobs, setJobs] = useState<IngestJob[]>(initialJobs);
  // 一輪只補標一次；不擋著的話 poll 每兩秒就會多打一次 Claude
  const tagging = useRef(false);

  const active = jobs.filter(
    (job) => job.status === "queued" || job.status === "running"
  );

  useEffect(() => {
    if (active.length === 0) return;

    // 又有新的在跑了 → 這輪跑完要再補標一次
    tagging.current = false;

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

        // 全部跑完了 → 先讓 Claude 把新單品標好，再把新卡片撈上來
        if (stillActive === 0) {
          if (!tagging.current) {
            tagging.current = true;
            try {
              await fetch("/api/tags/sync", { method: "POST" });
            } catch {
              // 標籤補不上不影響收藏，風向標上的按鈕還能再補一次
            }
          }
          router.refresh();
        }
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
