"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

/**
 * 從收藏的單品長出風向標的標籤。
 *
 * 按下去會做兩件事（/api/tags/sync）：
 *   1. 還沒標過的單品 → text_description 丟給 Claude 要三個標籤
 *   2. 把所有單品的標籤依出現次數算成權重，長到風向標上
 *
 * 平常 LINE 收藏完會自動跑一次，這顆是補跑用的（Claude 掛掉、或改了標籤想重算）。
 */
export default function SyncTagsButton({ untagged = 0 }: { untagged?: number }) {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const router = useRouter();

  async function onClick() {
    setBusy(true);
    setNote(null);
    try {
      const res = await fetch("/api/tags/sync", { method: "POST" });
      if (!res.ok) {
        alert("同步失敗，資料庫可能還沒建好 style_tags 表");
        return;
      }
      const data = (await res.json()) as { tagged?: number };
      setNote(
        data.tagged ? `Claude 新標了 ${data.tagged} 件` : "沒有新單品要標"
      );
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  const label = busy
    ? "標籤產生中…"
    : untagged > 0
      ? `用 Claude 標 ${untagged} 件新單品`
      : "從收藏更新標籤";

  return (
    <>
      <button className="btn btn--ghost" onClick={onClick} disabled={busy}>
        {label}
      </button>
      {note ? <span className="page-note">{note}</span> : null}
    </>
  );
}
