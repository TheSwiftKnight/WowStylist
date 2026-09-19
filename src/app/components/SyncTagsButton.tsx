"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

/**
 * 從收藏的單品長出風向標的標籤。
 * pipeline 會替每件衣服產 display_tags / outfit_tags，
 * 這顆按鈕把它們依出現次數算成權重寫進 style_tags。
 */
export default function SyncTagsButton() {
  const [busy, setBusy] = useState(false);
  const router = useRouter();

  async function onClick() {
    setBusy(true);
    try {
      const res = await fetch("/api/tags/sync", { method: "POST" });
      if (!res.ok) {
        alert("同步失敗，資料庫可能還沒建好 style_tags 表");
        return;
      }
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <button className="btn btn--ghost" onClick={onClick} disabled={busy}>
      {busy ? "同步中…" : "從收藏更新標籤"}
    </button>
  );
}
