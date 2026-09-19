"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

/**
 * 手動貼一條 IG 連結進 pipeline。
 *
 * POST /api/ingest 只是「送件」，回來的是 job id —— 真正的分析
 * （Apify → Claude Vision → BGE-M3 → RDS）在 Python 那邊背景跑，
 * 進度由 JobsBanner 顯示。
 */
export default function AddLinkForm() {
  const [url, setUrl] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const router = useRouter();

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!url.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/ingest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        setError(data.error ?? "送件失敗");
      } else {
        setUrl("");
        router.refresh(); // 讓 JobsBanner 抓到新的 job
      }
    } catch {
      setError("連線失敗，請再試一次");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <form className="add-form" onSubmit={onSubmit}>
        <input
          className="field"
          type="url"
          aria-label="Instagram 連結"
          placeholder="貼上 Instagram 貼文 / Reels 連結，交給 AI 拆解穿搭…"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          disabled={busy}
        />
        <button className="btn" type="submit" disabled={busy || !url.trim()}>
          {busy ? "送出中…" : "分析"}
        </button>
      </form>
      {error && <p className="form-error">{error}</p>}
    </>
  );
}
