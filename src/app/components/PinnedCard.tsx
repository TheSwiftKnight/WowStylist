"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { BoardLink } from "@/lib/mock";

const KIND_LABEL: Record<string, string> = {
  post: "貼文",
  reel: "Reels",
  tv: "IGTV",
  unknown: "IG",
};

const PIN_VARIANTS = ["", " pin--slate", " pin--rust"];

/** IG 官方 embed 的網址。不下載圖片，直接讓 IG 自己渲染。 */
function embedSrc(shortcode: string, kind: string) {
  const pathKind = kind === "reel" ? "reel" : kind === "tv" ? "tv" : "p";
  return `https://www.instagram.com/${pathKind}/${shortcode}/embed/`;
}

/**
 * embed iframe 沒有 IG 的 embed.js 就不會自己調高度，所以這裡按類型給固定比例。
 * 影片（Reels）是 9:16 的直式，比方形貼文高很多。
 */
function embedRatio(kind: string, isVideo: boolean) {
  return kind === "reel" || kind === "tv" || isVideo ? 0.5 : 0.78;
}

/** 由 id 推出固定的傾斜角與圖釘顏色，重新整理不會亂跳。 */
function jitter(id: number) {
  const n = Math.abs(id * 2654435761) % 1000;
  return {
    rotate: ((n % 41) - 20) / 10, // -2.0deg ~ +2.0deg
    pinLeft: 38 + (n % 25), // 圖釘不要每張都在正中間
    pin: PIN_VARIANTS[n % PIN_VARIANTS.length],
  };
}

export default function PinnedCard({
  link,
  isMock,
}: {
  link: BoardLink;
  isMock: boolean;
}) {
  const router = useRouter();
  const [removed, setRemoved] = useState(false);
  const [busy, setBusy] = useState(false);
  // public/media 沒有進 git，所以示範資料的圖在 Vercel 上是不存在的
  const [imgFailed, setImgFailed] = useState(false);
  const { rotate, pinLeft, pin } = jitter(link.id);

  async function onDelete() {
    if (
      !confirm(`要把「${link.caption?.slice(0, 16) ?? "這則收藏"}」取下來嗎？`)
    ) {
      return;
    }

    if (isMock) {
      // 示範資料不在資料庫裡，先在畫面上取下就好。
      setRemoved(true);
      return;
    }

    setBusy(true);
    try {
      // 之後資料庫換成 Amazon RDS，這支 API 不用改 —— Prisma 只換連線字串。
      const res = await fetch(`/api/links/${link.id}`, { method: "DELETE" });
      if (!res.ok) {
        alert("刪除失敗，請再試一次");
        return;
      }
      setRemoved(true);
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  if (removed) return null;

  const date = new Date(link.createdAt).toLocaleDateString("zh-TW", {
    month: "numeric",
    day: "numeric",
  });

  return (
    <article className="pinned" style={{ transform: `rotate(${rotate}deg)` }}>
      <span
        className={`pin${pin}`}
        style={{ left: `${pinLeft}%` }}
        aria-hidden="true"
      />

      {isMock ? (
        // 示範資料沒有真的 IG 貼文可以 embed，用本機圖片或留白代替。
        <a
          className="pinned__link"
          href={link.url}
          target="_blank"
          rel="noreferrer"
        >
          <div className="pinned__media">
            {link.mediaPath && !imgFailed ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={link.mediaPath}
                alt={link.caption?.slice(0, 60) ?? "Instagram 貼文縮圖"}
                loading="lazy"
                onError={() => setImgFailed(true)}
              />
            ) : (
              <div className="pinned__blank">
                <span>示範資料</span>
              </div>
            )}
            {link.isVideo && (
              <span className="pinned__play" aria-hidden="true">
                ▶
              </span>
            )}
          </div>
        </a>
      ) : (
        <div
          className="pinned__embed"
          style={{ aspectRatio: embedRatio(link.kind, link.isVideo) }}
        >
          <iframe
            src={embedSrc(link.shortcode, link.kind)}
            title={
              link.username
                ? `@${link.username} 的 Instagram 貼文`
                : "Instagram 貼文"
            }
            loading="lazy"
            scrolling="no"
            allowFullScreen
          />
        </div>
      )}

      <div className="pinned__body">
        {link.username && <div className="pinned__user">@{link.username}</div>}
        <p
          className={
            link.caption ? "pinned__caption" : "pinned__caption is-empty"
          }
        >
          {link.caption ?? "（沒有文字內容）"}
        </p>
      </div>

      <div className="pinned__foot">
        <span className="pinned__kind">{KIND_LABEL[link.kind] ?? "IG"}</span>
        <span>{date}</span>
        <span className="pinned__spacer" />
        <a
          className="pinned__open"
          href={link.url}
          target="_blank"
          rel="noreferrer"
        >
          開原文
        </a>
        <button
          className="btn btn--tiny"
          onClick={onDelete}
          disabled={busy}
          aria-label={`刪除${link.username ? " @" + link.username : "這則"}的收藏`}
        >
          {busy ? "取下中…" : "取下"}
        </button>
      </div>
    </article>
  );
}
