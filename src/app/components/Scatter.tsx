import { SprigMotif } from "./Motifs";

/**
 * 首頁牆面上「隨機散落」的 3~5 個純裝飾物件。
 * 全部 aria-hidden + pointer-events:none，不影響鍵盤或讀屏。
 *
 * 位置只用畫面四邊的固定槽位，中間留給三個入口，所以不管抽到什麼
 * 都不會蓋住可點的東西。
 */

type Slot = {
  style: React.CSSProperties;
  rotate: number;
};

const SLOTS: Slot[] = [
  { style: { top: "9%", left: "3%" }, rotate: -7 },
  { style: { top: "4%", right: "6%" }, rotate: 5 },
  { style: { bottom: "8%", left: "7%" }, rotate: 4 },
  { style: { bottom: "6%", right: "4%" }, rotate: -6 },
  { style: { top: "40%", left: "1.5%" }, rotate: 9 },
  { style: { top: "46%", right: "1.5%" }, rotate: -9 },
  { style: { top: "2%", left: "31%" }, rotate: -3 },
  { style: { bottom: "3%", left: "44%" }, rotate: 6 },
];

const HAND_NOTES = [
  "週末想穿這件",
  "袖口的比例",
  "這個綠",
  "留著",
  "布料？",
];

const SWATCHES: { cap: string; chips: string[] }[] = [
  { cap: "moss / olive", chips: ["#6f7136", "#9a9b4f", "#c3be86"] },
  { cap: "oat / cream", chips: ["#e8dcc2", "#f2ebda", "#d8c4a4"] },
  { cap: "haze / slate", chips: ["#8ba0af", "#b9c7d0", "#3f4f5d"] },
  { cap: "rust / clay", chips: ["#a95c2a", "#b8623c", "#e7cfc1"] },
];

const CLIP_HEADS = ["FIELD NOTES", "PART ONE", "PLATE NO. 11", "ARCHIVE"];

const TICKETS = ["No.0317 / soft", "No.1120 / linen", "No.0948 / dusk"];

type Deco =
  | { kind: "polaroid"; photo: string | null; note: string }
  | { kind: "swatch"; idx: number }
  | { kind: "note"; text: string }
  | { kind: "clipping"; head: string }
  | { kind: "sprig" }
  | { kind: "ticket"; text: string };

function buildPool(photos: string[]): Deco[] {
  const pool: Deco[] = [
    { kind: "sprig" },
    { kind: "swatch", idx: 0 },
    { kind: "swatch", idx: 2 },
    { kind: "note", text: "顏色比版型重要\n（先看色系再看款）" },
    { kind: "note", text: "喜歡的都偏鬆\n肩線再大一號" },
    { kind: "clipping", head: CLIP_HEADS[0] },
    { kind: "clipping", head: CLIP_HEADS[2] },
    { kind: "ticket", text: TICKETS[0] },
    { kind: "ticket", text: TICKETS[2] },
    { kind: "swatch", idx: 1 },
    { kind: "swatch", idx: 3 },
  ];
  photos.forEach((photo, i) => {
    pool.push({
      kind: "polaroid",
      photo,
      note: HAND_NOTES[i % HAND_NOTES.length],
    });
  });
  if (photos.length === 0) {
    pool.push({ kind: "polaroid", photo: null, note: HAND_NOTES[0] });
  }
  return pool;
}

function shuffle<T>(items: T[]): T[] {
  const copy = items.slice();
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

export default function Scatter({ photos }: { photos: string[] }) {
  const count = 3 + Math.floor(Math.random() * 3); // 3~5 個
  const picks = shuffle(buildPool(photos)).slice(0, count);
  const slots = shuffle(SLOTS).slice(0, count);

  return (
    <div className="scatter" aria-hidden="true">
      {picks.map((deco, i) => {
        const slot = slots[i];
        const style: React.CSSProperties = {
          ...slot.style,
          transform: `rotate(${slot.rotate}deg)`,
        };
        return (
          <div
            key={i}
            className={`deco deco--${deco.kind}`}
            style={style}
          >
            {renderDeco(deco)}
          </div>
        );
      })}
    </div>
  );
}

function renderDeco(deco: Deco) {
  switch (deco.kind) {
    case "polaroid":
      return (
        <>
          <span className="pin pin--slate" />
          <div
            className="deco__photo"
            style={
              deco.photo
                ? { backgroundImage: `url(${deco.photo})` }
                : undefined
            }
          />
          <div className="deco__hand">{deco.note}</div>
        </>
      );
    case "swatch": {
      const s = SWATCHES[deco.idx % SWATCHES.length];
      return (
        <>
          <span className="pin pin--rust" />
          <div className="deco__chips">
            {s.chips.map((c) => (
              <div
                key={c}
                className="deco__chip"
                style={{ background: c }}
              />
            ))}
          </div>
          <div className="deco__cap">{s.cap}</div>
        </>
      );
    }
    case "note":
      return (
        <>
          <span className="pin" />
          <div className="deco__hand" style={{ whiteSpace: "pre-line" }}>
            {deco.text}
          </div>
        </>
      );
    case "clipping":
      return (
        <>
          <span
            className="tape"
            style={{ top: "-12px", left: "18px", transform: "rotate(-6deg)" }}
          />
          <div className="deco__head">{deco.head}</div>
          <div className="deco__lines">
            {[92, 78, 96, 64, 88].map((w, i) => (
              <div
                key={i}
                className="deco__line"
                style={{ width: `${w}%` }}
              />
            ))}
          </div>
        </>
      );
    case "sprig":
      return <SprigMotif />;
    case "ticket":
      return (
        <>
          <span className="pin" />
          <div className="deco__no">{deco.text}</div>
          <div className="deco__word">keep</div>
        </>
      );
  }
}
