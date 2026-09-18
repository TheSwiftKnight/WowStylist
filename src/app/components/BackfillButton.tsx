"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

// 有些收藏可能還沒抓到內容（webhook 抓失敗、或舊資料）
// 這顆按鈕會呼叫 /api/links/backfill 一次補抓最多 10 筆
export default function BackfillButton({ pendingCount }: { pendingCount: number }) {
  const [busy, setBusy] = useState(false);
  const router = useRouter();

  async function onClick() {
    setBusy(true);
    try {
      await fetch("/api/links/backfill", { method: "POST" });
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <button className="backfill-btn" onClick={onClick} disabled={busy}>
      {busy ? "抓取中…" : `補抓 ${pendingCount} 則內容`}
    </button>
  );
}
