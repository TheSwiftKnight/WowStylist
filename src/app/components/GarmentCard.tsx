"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { Garment } from "@/lib/garments";

const CATEGORY_LABEL: Record<string, string> = {
  top: "上衣",
  pants: "褲子",
};

const PIN_VARIANTS = ["", " pin--slate", " pin--rust"];

/** 由 id 推出固定的傾斜角與圖釘顏色，重新整理不會亂跳。 */
function jitter(id: number) {
  const n = Math.abs(id * 2654435761) % 1000;
  return {
    rotate: ((n % 41) - 20) / 10, // -2.0deg ~ +2.0deg
    pinLeft: 38 + (n % 25),
    pin: PIN_VARIANTS[n % PIN_VARIANTS.length],
  };
}

/**
 * 一張卡片 = pipeline 從貼文裡辨識出來的「一件衣服」。
 *
 * 圖片是 RDS 裡的 bytea，走 /api/garments/:id/image 出圖，
 * 不是 IG 的 embed —— IG 的 CDN 網址會過期，而且 embed 沒辦法只顯示單品。
 */
export default function GarmentCard({
  garment,
  isMock,
}: {
  garment: Garment;
  isMock: boolean;
}) {
  const router = useRouter();
  const [removed, setRemoved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [imgFailed, setImgFailed] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const { rotate, pinLeft, pin } = jitter(garment.id);

  // 標題：商品才有 title；IG 來的用 display_tags 兜一個顯示用的名字
  const name =
    garment.title ??
    (garment.displayTags.length > 0
      ? garment.displayTags.slice(0, 3).join(" ")
      : garment.category === "pants"
        ? "這件褲子"
        : "這件上衣");

  async function onDelete() {
    if (!confirm(`要把「${name}」取下來嗎？`)) return;

    if (isMock) {
      setRemoved(true);
      return;
    }

    setBusy(true);
    try {
      const res = await fetch(`/api/garments/${garment.id}`, {
        method: "DELETE",
      });
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

  const date = new Date(garment.createdAt).toLocaleDateString("zh-TW", {
    month: "numeric",
    day: "numeric",
  });

  const showImage = garment.hasImage && !imgFailed;

  return (
    <article className="pinned" style={{ transform: `rotate(${rotate}deg)` }}>
      <span
        className={`pin${pin}`}
        style={{ left: `${pinLeft}%` }}
        aria-hidden="true"
      />

      <div className="pinned__media">
        {showImage ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={`/api/garments/${garment.id}/image`}
            alt={name}
            loading="lazy"
            onError={() => setImgFailed(true)}
          />
        ) : (
          <div className="pinned__blank">
            <span>{isMock ? "示範資料" : "沒有圖片"}</span>
          </div>
        )}

        {garment.category && (
          <span className="pinned__badge">
            {CATEGORY_LABEL[garment.category] ?? garment.category}
          </span>
        )}

        {garment.instagramType === "reel" && (
          <span className="pinned__play" aria-hidden="true">
            ▶
          </span>
        )}
      </div>

      <div className="pinned__body">
        {garment.displayTags.length > 0 && (
          <ul className="tag-row">
            {garment.displayTags.slice(0, 4).map((tag) => (
              <li className="tag-chip" key={tag}>
                {tag}
              </li>
            ))}
          </ul>
        )}

        <p
          className={`pinned__caption${expanded ? "" : " is-clamped"}${
            garment.description ? "" : " is-empty"
          }`}
          onClick={() => setExpanded((v) => !v)}
          title={expanded ? "收合" : "點一下看完整描述"}
        >
          {garment.description || "（還沒有描述）"}
        </p>

        {garment.outfitTags.length > 0 && (
          <p className="pinned__outfit">
            {garment.outfitTags.slice(0, 4).join(" · ")}
          </p>
        )}
      </div>

      <div className="pinned__foot">
        <span className="pinned__kind">
          {garment.instagramType === "reel" ? "Reels" : "貼文"}
        </span>
        <span>{date}</span>
        <span className="pinned__spacer" />
        {garment.instagramUrl && (
          <a
            className="pinned__open"
            href={garment.instagramUrl}
            target="_blank"
            rel="noreferrer"
          >
            開原文
          </a>
        )}
        <button
          className="btn btn--tiny"
          onClick={onDelete}
          disabled={busy}
          aria-label={`刪除${name}`}
        >
          {busy ? "取下中…" : "取下"}
        </button>
      </div>
    </article>
  );
}
