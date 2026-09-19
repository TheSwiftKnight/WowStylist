"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

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
      const res = await fetch("/api/links", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        setError(data.error ?? "新增失敗");
      } else {
        setUrl("");
        router.refresh();
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
          placeholder="貼上 Instagram 貼文 / Reels 連結來測試…"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          disabled={busy}
        />
        <button className="btn" type="submit" disabled={busy || !url.trim()}>
          {busy ? "新增中…" : "新增"}
        </button>
      </form>
      {error && <p className="form-error">{error}</p>}
    </>
  );
}
