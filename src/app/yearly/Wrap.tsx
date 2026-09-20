"use client";

// 年度總結 = 一本翻頁的小冊子。
//
// 形式借 Spotify Wrapped 的 story：上面一排進度段，點左右兩側翻頁，
// 每一頁只講一件事。但長相走的是這個站一貫的語彙 ——
// 每一頁都是一張釘／夾／貼在板子上的紙，不是滿版霓虹漸層。
//
// 不做自動播放：這頁是拿來「看」的，數字要讀得完，
// 自動跑掉反而會逼人一直倒回去。

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import type { RankedTag, WrapStats } from "@/lib/yearly";
import { swatchColor, swatchInk } from "./swatch";

/** 沒有標籤時的替代文案，免得整頁開天窗。 */
const NO_TAG = "還沒長出來";

function pct(share: number): string {
  return `${Math.round(share * 100)}%`;
}

function first(tags: RankedTag[]): string {
  return tags[0]?.label ?? NO_TAG;
}

type Fastener = "pin" | "pin--slate" | "pin--rust" | "clip" | "tape";

/** "pin--rust" 要輸出 "pin pin--rust"；clip / tape 本身就是完整的 class。 */
function fastenerClass(f: Fastener): string {
  return f.startsWith("pin--") ? `pin ${f}` : f;
}

type Slide = {
  key: string;
  fastener: Fastener;
  body: React.ReactNode;
};

function buildSlides(stats: WrapStats): Slide[] {
  const {
    year,
    spansAllTime,
    postCount,
    outfitCount,
    garmentCount,
    topCount,
    pantsCount,
    styles,
    colors,
    moods,
    months,
    busiestMonth,
    coverIds,
  } = stats;

  const monthPeak = Math.max(1, ...months.map((m) => m.count));
  const wornTotal = Math.max(1, topCount + pantsCount);

  return [
    // ---- 封面 ---------------------------------------------------------
    {
      key: "cover",
      fastener: "pin",
      body: (
        <>
          <p className="wrap__kicker"><span className="brand">wOow</span> Almanac</p>
          <h1 className="wrap__year">{year}</h1>
          <p className="wrap__display">
            年度<em>總結</em>
          </p>
          <p className="wrap__lede">
            {spansAllTime
              ? "把你釘上牆的每一件，重新攤開來看一次。"
              : `${year} 年，你從 LINE 丟進來的每一張穿搭，在這裡收成一本。`}
          </p>
          <p className="wrap__hand">往右翻 →</p>
        </>
      ),
    },

    // ---- 總量 ---------------------------------------------------------
    {
      key: "count",
      fastener: "clip",
      body: (
        <>
          <p className="wrap__kicker">01 — 這一年的重量</p>
          <p className="wrap__lede">你一共釘上了</p>
          <p className="wrap__huge">
            {garmentCount}
            <span className="wrap__unit">件單品</span>
          </p>

          <div className="wrap__split" aria-hidden="true">
            <i
              className="wrap__split-top"
              style={{ flexGrow: Math.max(topCount, 0.04) }}
            />
            <i
              className="wrap__split-pants"
              style={{ flexGrow: Math.max(pantsCount, 0.04) }}
            />
          </div>
          <p className="wrap__splitkey">
            上衣 {topCount}（{Math.round((topCount / wornTotal) * 100)}%） · 褲子{" "}
            {pantsCount}（{Math.round((pantsCount / wornTotal) * 100)}%）
          </p>

          <ul className="wrap__stats">
            <li>
              <b>{postCount}</b>
              <span>則貼文</span>
            </li>
            <li>
              <b>{outfitCount}</b>
              <span>套穿搭</span>
            </li>
          </ul>
        </>
      ),
    },

    // ---- 時間軸 -------------------------------------------------------
    {
      key: "months",
      fastener: "tape",
      body: (
        <>
          <p className="wrap__kicker">02 — 你什麼時候在看衣服</p>
          <p className="wrap__lede">
            {busiestMonth ? (
              <>
                <em>{busiestMonth.month} 月</em>
                {" "}是你收得最兇的一個月，一口氣釘了 {busiestMonth.count} 件。
              </>
            ) : (
              "這一年還沒有任何一筆收藏。"
            )}
          </p>

          <div className="wrap__months">
            {months.map((m) => (
              <div className="wrap__month" key={m.month}>
                <i
                  className={
                    busiestMonth && m.month === busiestMonth.month
                      ? "wrap__bar is-peak"
                      : "wrap__bar"
                  }
                  style={{ height: `${(m.count / monthPeak) * 100}%` }}
                >
                  <span className="visually-hidden">
                    {m.month} 月 {m.count} 件
                  </span>
                </i>
                <span className="wrap__monthno">{m.month}</span>
              </div>
            ))}
          </div>
          <p className="wrap__hand">十二格，一格一個月</p>
        </>
      ),
    },

    // ---- 風格排行 -----------------------------------------------------
    {
      key: "styles",
      fastener: "pin--slate",
      body: (
        <>
          <p className="wrap__kicker">03 — 你的風格前五</p>
          <p className="wrap__lede">
            Claude 讀完你每一件收藏，數出來最常出現的幾種美學。
          </p>

          {styles.length === 0 ? (
            <p className="wrap__blankline">{NO_TAG}</p>
          ) : (
            <ol className="wrap__rows">
              {styles.map((t, n) => (
                <li className="wrap__row" key={t.label}>
                  <span className="wrap__rank">
                    {String(n + 1).padStart(2, "0")}
                  </span>
                  <span className="wrap__rowlabel">{t.label}</span>
                  <span className="wrap__meter">
                    <i style={{ width: `${Math.max(t.share * 100, 4)}%` }} />
                  </span>
                  <span className="wrap__pct">{pct(t.share)}</span>
                </li>
              ))}
            </ol>
          )}
        </>
      ),
    },

    // ---- 色盤 ---------------------------------------------------------
    {
      key: "colors",
      fastener: "clip",
      body: (
        <>
          <p className="wrap__kicker">04 — 你的色盤</p>
          <p className="wrap__lede">
            一整年下來，你的衣櫃其實只在這幾個顏色之間來回。
          </p>

          {colors.length === 0 ? (
            <p className="wrap__blankline">{NO_TAG}</p>
          ) : (
            <ul className="wrap__swatches">
              {colors.map((t) => (
                <li className="wrap__swatch" key={t.label}>
                  <i
                    style={{
                      background: swatchColor(t.label),
                      color: swatchInk(t.label),
                    }}
                  >
                    {t.label}
                  </i>
                  <span>{pct(t.share)}</span>
                </li>
              ))}
            </ul>
          )}
        </>
      ),
    },

    // ---- 形容詞 -------------------------------------------------------
    {
      key: "moods",
      fastener: "tape",
      body: (
        <>
          <p className="wrap__kicker">05 — 你一直在找的那個感覺</p>
          {moods.length === 0 ? (
            <p className="wrap__blankline">{NO_TAG}</p>
          ) : (
            <ul className="wrap__moods">
              {moods.map((t, n) => (
                <li key={t.label} style={{ ["--n" as string]: n }}>
                  <em>{t.label}</em>
                  <span>{pct(t.share)}</span>
                </li>
              ))}
            </ul>
          )}
          <p className="wrap__hand">越上面，出現得越多</p>
        </>
      ),
    },

    // ---- 拼貼 ---------------------------------------------------------
    {
      key: "collage",
      fastener: "pin--rust",
      body: (
        <>
          <p className="wrap__kicker">06 — 釘在牆上的那些</p>
          <p className="wrap__lede">
            {outfitCount > 0
              ? `${outfitCount} 套裡挑出來的幾張。`
              : "板子上還是空的。"}
          </p>

          <div className="wrap__collage">
            {coverIds.length > 0
              ? coverIds.map((id, n) => (
                  <figure className="wrap__frame" key={id} style={{ ["--n" as string]: n }}>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={`/api/garments/${id}/image`} alt="" loading="lazy" />
                  </figure>
                ))
              : Array.from({ length: 6 }, (_, n) => (
                  <figure className="wrap__frame is-blank" key={n} style={{ ["--n" as string]: n }}>
                    <span>無圖</span>
                  </figure>
                ))}
          </div>
        </>
      ),
    },

    // ---- 結語 ---------------------------------------------------------
    {
      key: "finale",
      fastener: "pin",
      body: (
        <>
          <p className="wrap__kicker">07 — 你的 {year}</p>
          <p className="wrap__lede">你的年度風格是</p>
          <p className="wrap__persona">{first(styles)}</p>
          <p className="wrap__hand">一個{first(moods)}的收藏者</p>
          <p className="wrap__closing">
            走過 {postCount} 則貼文、{outfitCount} 套穿搭、{garmentCount} 件單品，
            你的色盤最後還是回到 <em>{first(colors)}</em>。
          </p>
          <p className="wrap__signoff">明年這面牆見。</p>
        </>
      ),
    },
  ];
}

export default function Wrap({ stats }: { stats: WrapStats }) {
  const slides = buildSlides(stats);
  const last = slides.length - 1;
  const [index, setIndex] = useState(0);
  // 往前翻還是往後翻，決定紙從哪一側滑進來
  const [dir, setDir] = useState(1);

  const go = useCallback(
    (delta: number) => {
      setIndex((now) => {
        const next = Math.min(last, Math.max(0, now + delta));
        if (next !== now) setDir(delta > 0 ? 1 : -1);
        return next;
      });
    },
    [last]
  );

  const jump = useCallback((to: number) => {
    setIndex((now) => {
      if (to !== now) setDir(to > now ? 1 : -1);
      return to;
    });
  }, []);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "ArrowRight" || e.key === " ") {
        e.preventDefault();
        go(1);
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        go(-1);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [go]);

  const slide = slides[index];

  return (
    <div className="wrap">
      <ol className="wrap__progress" aria-label="進度">
        {slides.map((s, n) => (
          <li key={s.key}>
            <button
              type="button"
              className={n <= index ? "wrap__seg is-on" : "wrap__seg"}
              aria-label={`第 ${n + 1} 頁，共 ${slides.length} 頁`}
              aria-current={n === index ? "step" : undefined}
              onClick={() => jump(n)}
            />
          </li>
        ))}
      </ol>

      <div className="wrap__stage">
        {/* 翻頁用的左右感應區。蓋在紙上面，但結語頁的按鈕 z-index 更高，點得到。 */}
        <button
          type="button"
          className="wrap__zone wrap__zone--prev"
          onClick={() => go(-1)}
          disabled={index === 0}
          aria-label="上一頁"
        />
        <button
          type="button"
          className="wrap__zone wrap__zone--next"
          onClick={() => go(1)}
          disabled={index === last}
          aria-label="下一頁"
        />

        <section
          className="wrap__sheet"
          key={slide.key}
          data-dir={dir}
          data-last={index === last}
          aria-live="polite"
        >
          <span className={fastenerClass(slide.fastener)} aria-hidden="true" />
          <div className="wrap__body">{slide.body}</div>

          {index === last && (
            <div className="wrap__actions">
              <button type="button" className="btn btn--ghost" onClick={() => jump(0)}>
                再看一次
              </button>
              <Link className="btn" href="/favorites">
                回收藏夾
              </Link>
            </div>
          )}
        </section>
      </div>

      <footer className="wrap__foot">
        <span className="label-type">
          {index + 1} / {slides.length}
        </span>
        <span>點畫面左右兩側翻頁，或用 ← → 鍵</span>
        {stats.isMock && <span className="mock-flag">示範資料 · 尚未接上資料庫</span>}
      </footer>
    </div>
  );
}
