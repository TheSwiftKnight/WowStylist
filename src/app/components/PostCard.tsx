"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { PostGroup } from "@/lib/outfits";
import { outfitName } from "@/lib/outfits";
import PostPeek from "./PostPeek";

const PIN_VARIANTS = ["", " pin--slate", " pin--rust"];

/** 由 key 推出固定的傾斜角與圖釘顏色，重新整理不會亂跳。 */
function jitter(key: string) {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) | 0;
  const n = Math.abs(h) % 1000;
  return {
    rotate: ((n % 41) - 20) / 10, // -2.0deg ~ +2.0deg
    pinLeft: 38 + (n % 25),
    pin: PIN_VARIANTS[n % PIN_VARIANTS.length],
  };
}

/**
 * 一張卡片 = 一則 IG 貼文（可能含很多套）。
 *
 * 之前是一件單品一張卡，同一則貼文會散成十幾張。
 * 現在收成一張，點進去再左右滑看每一套。
 *
 * 圖片是 RDS 裡的 bytea，走 /api/garments/:id/image 出圖，
 * 不是 IG 的 embed —— IG 的 CDN 網址會過期，而且 embed 沒辦法只顯示單品。
 */
export default function PostCard({
  group,
  isMock,
}: {
  group: PostGroup;
  isMock: boolean;
}) {
  const router = useRouter();
  // 刪掉的單品記 id，畫面從 props 推出來 —— 用 useState 存 outfits 的話，
  // server component 重新整理（新貼文分析完）不會反映到已經掛著的卡片上。
  const [deleted, setDeleted] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState(false);
  const [imgFailed, setImgFailed] = useState(false);
  const [peeking, setPeeking] = useState(false);
  const { rotate, pinLeft, pin } = jitter(group.key);

  const outfits = group.outfits
    .map((o) => ({ ...o, garments: o.garments.filter((g) => !deleted.has(g.id)) }))
    .filter((o) => o.garments.length > 0);

  const total = outfits.length;
  if (total === 0) return null;

  const cover = group.cover;
  const showImage = cover.hasImage && !imgFailed;
  const title = outfitName(outfits[0], 0);
  const date = new Date(group.createdAt).toLocaleDateString("zh-TW", {
    month: "numeric",
    day: "numeric",
  });

  /** 取下一整套 = 把那套裡的每件單品都刪掉。 */
  async function onDeleteOutfit(index: number) {
    const outfit = outfits[index];
    if (!outfit) return;

    const count = outfit.garments.length;
    if (!confirm(`要把第 ${index + 1} 套（${count} 件）取下來嗎？`)) return;

    if (isMock) {
      setDeleted((prev) => {
        const next = new Set(prev);
        for (const g of outfit.garments) next.add(g.id);
        return next;
      });
      return;
    }

    setBusy(true);
    try {
      // API 一次刪一件，所以一套要逐件打
      const results = await Promise.all(
        outfit.garments.map((g) =>
          fetch(`/api/garments/${g.id}`, { method: "DELETE" }).then(
            (r) => r.ok
          )
        )
      );

      if (results.some((ok) => !ok)) {
        alert("有幾件沒刪成功，請重新整理再試一次");
        router.refresh();
        return;
      }

      setDeleted((prev) => {
        const next = new Set(prev);
        for (const g of outfit.garments) next.add(g.id);
        return next;
      });
      if (outfits.length === 1) setPeeking(false);
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <article
        className={`pinned${total > 1 ? " pinned--stack" : ""}`}
        style={{ transform: `rotate(${rotate}deg)` }}
        onClick={() => setPeeking(true)}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            setPeeking(true);
          }
        }}
        title={total > 1 ? `${total} 套 · 點一下翻閱` : "點一下放大看"}
      >
        <span
          className={`pin${pin}`}
          style={{ left: `${pinLeft}%` }}
          aria-hidden="true"
        />

        <div className="pinned__media">
          {showImage ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={`/api/garments/${cover.id}/image`}
              alt={title}
              loading="lazy"
              onError={() => setImgFailed(true)}
            />
          ) : (
            <div className="pinned__blank">
              <span>{isMock ? "示範資料" : "沒有圖片"}</span>
            </div>
          )}

          {total > 1 && <span className="pinned__count">{total} 套</span>}

          {group.instagramType === "reel" && (
            <span className="pinned__play" aria-hidden="true">
              ▶
            </span>
          )}
        </div>

        <div className="pinned__body">
          {outfits[0].garments[0]?.displayTags.length > 0 && (
            <ul className="tag-row">
              {outfits[0].garments[0].displayTags.slice(0, 4).map((tag) => (
                <li className="tag-chip" key={tag}>
                  {tag}
                </li>
              ))}
            </ul>
          )}

          <p
            className={`pinned__caption is-clamped${
              outfits[0].garments[0]?.description ? "" : " is-empty"
            }`}
          >
            {outfits[0].garments[0]?.description || "（還沒有描述）"}
          </p>
        </div>

        <div className="pinned__foot">
          <span className="pinned__kind">
            {group.instagramType === "reel" ? "Reels" : "貼文"}
          </span>
          <span>{date}</span>
          <span className="pinned__spacer" />
          <span className="pinned__hint">翻閱</span>
        </div>
      </article>

      {peeking && (
        <PostPeek
          group={{ ...group, outfits }}
          isMock={isMock}
          onClose={() => setPeeking(false)}
          onDeleteOutfit={onDeleteOutfit}
          busy={busy}
        />
      )}
    </>
  );
}
