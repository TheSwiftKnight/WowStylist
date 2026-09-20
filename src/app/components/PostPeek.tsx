"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { PostGroup } from "@/lib/outfits";
import { outfitImages, outfitName } from "@/lib/outfits";

const CATEGORY_LABEL: Record<string, string> = {
  top: "上衣",
  pants: "褲子",
};

/** 手指要滑超過這個距離才算換頁，不然點一下都會誤觸。 */
const SWIPE_THRESHOLD = 48;

/**
 * Notion 式的置中 peek，一則貼文一個。
 * 左右滑（或方向鍵 / 兩側按鈕）在「同一套」之間換頁。
 *
 * 用 portal 掛到 body —— .pinned 身上有 transform: rotate()，
 * 那會變成 fixed 的 containing block，不脫離的話 modal 會跟著卡片歪掉。
 */
export default function PostPeek({
  group,
  isMock,
  onClose,
  onDeleteOutfit,
  busy,
}: {
  group: PostGroup;
  isMock: boolean;
  onClose: () => void;
  onDeleteOutfit: (index: number) => void;
  busy: boolean;
}) {
  const [mounted, setMounted] = useState(false);
  const [index, setIndex] = useState(0);
  const [dir, setDir] = useState<1 | -1>(1);
  const [failed, setFailed] = useState<Record<number, boolean>>({});
  const touchX = useRef<number | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const total = group.outfits.length;
  // 刪到剩比較少套的時候，index 可能超出範圍
  const safeIndex = Math.min(index, Math.max(total - 1, 0));
  const outfit = group.outfits[safeIndex];

  const go = useCallback(
    (delta: number) => {
      setIndex((i) => {
        const next = Math.min(Math.max(i + delta, 0), total - 1);
        if (next !== i) setDir(next > i ? 1 : -1);
        return next;
      });
    },
    [total]
  );

  const jumpTo = useCallback(
    (target: number) => {
      setIndex((i) => {
        if (target !== i) setDir(target > i ? 1 : -1);
        return target;
      });
    },
    []
  );

  useEffect(() => setMounted(true), []);

  // 換頁時把內容捲回頂端，不然上一套捲到一半的位置會留著
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 0 });
  }, [safeIndex]);

  // Esc 關閉、左右鍵換頁，開著的時候鎖住底下的捲動
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
      else if (e.key === "ArrowRight") go(1);
      else if (e.key === "ArrowLeft") go(-1);
    }
    document.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [onClose, go]);

  if (!mounted || !outfit) return null;

  const title = outfitName(outfit, safeIndex);
  // 同一套的每件單品共用同一張原始圖，重複的不重貼
  const images = outfitImages(outfit);
  const date = new Date(group.createdAt).toLocaleDateString("zh-TW", {
    month: "numeric",
    day: "numeric",
  });

  return createPortal(
    <div className="peek" role="dialog" aria-modal="true" aria-label={title}>
      <button
        className="peek__scrim"
        onClick={onClose}
        aria-label="關閉"
        tabIndex={-1}
      />

      <article className="peek__paper">
        <button className="peek__close" onClick={onClose} aria-label="關閉">
          ×
        </button>

        {total > 1 && (
          <header className="peek__rail">
            <button
              className="peek__arrow"
              onClick={() => go(-1)}
              disabled={safeIndex === 0}
              aria-label="上一套"
            >
              ‹
            </button>
            <span className="peek__counter">
              {safeIndex + 1} / {total} 套
            </span>
            <button
              className="peek__arrow"
              onClick={() => go(1)}
              disabled={safeIndex === total - 1}
              aria-label="下一套"
            >
              ›
            </button>
          </header>
        )}

        <div
          className="peek__scroll"
          ref={scrollRef}
          onTouchStart={(e) => {
            touchX.current = e.touches[0].clientX;
          }}
          onTouchEnd={(e) => {
            if (touchX.current === null) return;
            const dx = e.changedTouches[0].clientX - touchX.current;
            if (Math.abs(dx) > SWIPE_THRESHOLD) go(dx < 0 ? 1 : -1);
            touchX.current = null;
          }}
        >
          {/* key 掛 safeIndex：換頁時整頁重掛，翻頁動畫才會重播 */}
          <div className="peek__page" key={safeIndex} data-dir={dir}>
          <div className="peek__rack" data-count={Math.min(images.length, 3)}>
            {images.length === 0 ? (
              <div className="peek__slot">
                <div className="pinned__blank">
                  <span>{isMock ? "示範資料" : "沒有圖片"}</span>
                </div>
              </div>
            ) : (
              images.map((garment) => (
                <div className="peek__slot" key={garment.id}>
                  {!failed[garment.id] ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={`/api/garments/${garment.id}/image`}
                      alt={garment.description || "單品"}
                      onError={() =>
                        setFailed((f) => ({ ...f, [garment.id]: true }))
                      }
                    />
                  ) : (
                    <div className="pinned__blank">
                      <span>沒有圖片</span>
                    </div>
                  )}
                  {/* 只有一張圖時不標上衣／褲子 —— 圖裡本來就兩件都有，標了反而誤導 */}
                  {images.length > 1 && garment.category && (
                    <span className="pinned__badge">
                      {CATEGORY_LABEL[garment.category] ?? garment.category}
                    </span>
                  )}
                </div>
              ))
            )}
          </div>

          <div className="peek__body">
            <h2 className="peek__title">{title}</h2>

            {/* 每件單品各自的描述，保留 pipeline 寫的細節 */}
            {outfit.garments.map((garment) => (
              <section className="peek__item" key={garment.id}>
                <h3 className="peek__item-head">
                  {CATEGORY_LABEL[garment.category] ?? garment.category}
                </h3>

                {garment.displayTags.length > 0 && (
                  <ul className="tag-row">
                    {garment.displayTags.map((tag) => (
                      <li className="tag-chip" key={tag}>
                        {tag}
                      </li>
                    ))}
                  </ul>
                )}

                <p
                  className={`peek__caption${
                    garment.description ? "" : " is-empty"
                  }`}
                >
                  {garment.description || "（還沒有描述）"}
                </p>
              </section>
            ))}

            {outfit.garments[0]?.outfitTags.length > 0 && (
              <p className="pinned__outfit">
                {outfit.garments[0].outfitTags.join(" · ")}
              </p>
            )}
          </div>
          </div>
        </div>

        {total > 1 && (
          <div className="peek__dots" role="tablist" aria-label="選擇第幾套">
            {group.outfits.map((o, i) => (
              <button
                key={o.key}
                className={`peek__dot${i === safeIndex ? " is-on" : ""}`}
                onClick={() => jumpTo(i)}
                role="tab"
                aria-selected={i === safeIndex}
                aria-label={`第 ${i + 1} 套`}
              />
            ))}
          </div>
        )}

        <div className="peek__foot">
          <span className="pinned__kind">
            {group.instagramType === "reel" ? "Reels" : "貼文"}
          </span>
          <span>{date}</span>
          <span className="pinned__spacer" />
          {group.instagramUrl && (
            <a
              className="pinned__open"
              href={group.instagramUrl}
              target="_blank"
              rel="noreferrer"
            >
              開原文
            </a>
          )}
          <button
            className="btn btn--tiny"
            onClick={() => onDeleteOutfit(safeIndex)}
            disabled={busy}
          >
            {busy ? "取下中…" : "取下這套"}
          </button>
        </div>
      </article>
    </div>,
    document.body,
  );
}
