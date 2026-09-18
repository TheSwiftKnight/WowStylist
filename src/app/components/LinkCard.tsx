"use client";

import { useRouter } from "next/navigation";

const KIND_LABEL: Record<string, string> = {
  post: "貼文",
  reel: "Reels",
  tv: "IGTV",
  unknown: "IG",
};

export default function LinkCard({
  id,
  url,
  kind,
  username,
  caption,
  mediaPath,
  isVideo,
  senderName,
  createdAt,
}: {
  id: number;
  url: string;
  kind: string;
  username: string | null;
  caption: string | null;
  mediaPath: string | null;
  isVideo: boolean;
  senderName: string | null;
  createdAt: string;
}) {
  const router = useRouter();

  async function onDelete() {
    if (!confirm("確定要刪除這則收藏嗎？")) return;
    await fetch(`/api/links/${id}`, { method: "DELETE" });
    router.refresh();
  }

  const date = new Date(createdAt).toLocaleDateString("zh-TW", {
    month: "numeric",
    day: "numeric",
  });

  return (
    <div className="card">
      {/* 整張圖片 + 內文都可點，點了直接開原始 IG 貼文 */}
      <a className="card-link" href={url} target="_blank" rel="noreferrer">
        <div className="card-media">
          {mediaPath ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={mediaPath} alt={caption?.slice(0, 60) ?? "Instagram"} loading="lazy" />
          ) : (
            <div className="media-placeholder">
              <span>尚未抓到圖片</span>
            </div>
          )}
          {isVideo && (
            <span className="play-badge" aria-label="影片">
              ▶
            </span>
          )}
        </div>
        <div className="card-body">
          {username && <div className="card-user">@{username}</div>}
          <p className={caption ? "card-caption" : "card-caption muted"}>
            {caption ?? "（沒有文字內容）"}
          </p>
        </div>
      </a>
      <div className="card-meta">
        <span className="badge">{KIND_LABEL[kind] ?? "IG"}</span>
        {senderName && <span>{senderName}</span>}
        <span>{date}</span>
        <span className="spacer" />
        <button className="delete-btn" onClick={onDelete} aria-label="刪除">
          刪除
        </button>
      </div>
    </div>
  );
}
