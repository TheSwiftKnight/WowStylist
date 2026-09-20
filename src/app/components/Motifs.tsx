/**
 * 三個入口的圖騰（純裝飾，畫在相框裡）。
 *
 * 走舊書銅版畫的路子：細線稿 + 排線陰影 + 米白填色。
 * 重點是不要用「色塊堆形狀」——一堆完美的橢圓疊起來就會變成簡報剪貼圖。
 * 所以葉子是有尖端跟葉脈的杏仁形，花瓣裡面有順著形狀的細線，
 * 羅盤的每個角都切成亮面／暗面，線寬也刻意分粗細。
 */

const INK = "#3f4f5d";
const MOSS = "#6f7136";
const OLIVE = "#9a9b4f";
const RUST = "#a95c2a";
const CREAM = "#fdfbf4";
const PAPER = "#f4efe1";

const stroke = {
  fill: "none",
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

const rad = (deg: number) => (deg * Math.PI) / 180;
const n = (v: number) => Number(v.toFixed(1));

/** 一片葉子：杏仁形 + 中肋 + 側脈。預設朝正上方，靠 rotate 轉向。 */
function Leaf({
  len,
  wid,
  fill = OLIVE,
  line = MOSS,
  opacity = 1,
}: {
  len: number;
  wid: number;
  fill?: string;
  line?: string;
  opacity?: number;
}) {
  return (
    <g opacity={opacity}>
      <path
        d={`M0 0C${n(-wid)} ${n(-len * 0.32)} ${n(-wid * 0.58)} ${n(-len * 0.84)} 0 ${n(-len)}C${n(wid * 0.58)} ${n(-len * 0.84)} ${n(wid)} ${n(-len * 0.32)} 0 0Z`}
        fill={fill}
        stroke={line}
        strokeWidth="0.9"
        strokeLinejoin="round"
      />
      <path
        {...stroke}
        d={`M0 ${n(-len * 0.06)}V${n(-len * 0.92)}`}
        stroke={line}
        strokeWidth="0.8"
        opacity="0.75"
      />
      {[0.24, 0.44, 0.64].map((t) => (
        <g key={t} {...stroke} stroke={line} strokeWidth="0.6" opacity="0.6">
          <path
            d={`M0 ${n(-len * t)}L${n(-wid * 0.6)} ${n(-len * (t + 0.17))}`}
          />
          <path
            d={`M0 ${n(-len * t)}L${n(wid * 0.6)} ${n(-len * (t + 0.17))}`}
          />
        </g>
      ))}
    </g>
  );
}

/** 一片木蘭花被片：寬身、圓頭，裡面兩道順著形狀的褶痕。 */
function Petal({
  len,
  wid,
  fill,
  line,
}: {
  len: number;
  wid: number;
  fill: string;
  line: string;
}) {
  return (
    <g>
      <path
        d={`M0 0C${n(-wid * 0.86)} ${n(-len * 0.16)} ${n(-wid)} ${n(-len * 0.56)} ${n(-wid * 0.5)} ${n(-len * 0.87)}C${n(-wid * 0.26)} ${n(-len * 1.03)} ${n(wid * 0.26)} ${n(-len * 1.03)} ${n(wid * 0.5)} ${n(-len * 0.87)}C${n(wid)} ${n(-len * 0.56)} ${n(wid * 0.86)} ${n(-len * 0.16)} 0 0Z`}
        fill={fill}
        stroke={line}
        strokeWidth="1"
        strokeLinejoin="round"
      />
      <path
        {...stroke}
        d={`M0 ${n(-len * 0.12)}C${n(-wid * 0.3)} ${n(-len * 0.45)} ${n(-wid * 0.34)} ${n(-len * 0.72)} ${n(-wid * 0.2)} ${n(-len * 0.92)}`}
        stroke={line}
        strokeWidth="0.6"
        opacity="0.42"
      />
      <path
        {...stroke}
        d={`M0 ${n(-len * 0.12)}C${n(wid * 0.3)} ${n(-len * 0.45)} ${n(wid * 0.34)} ${n(-len * 0.72)} ${n(wid * 0.2)} ${n(-len * 0.92)}`}
        stroke={line}
        strokeWidth="0.6"
        opacity="0.42"
      />
    </g>
  );
}

/** 排線陰影：一組長度漸收的平行短線。 */
function Hatch({
  x,
  y,
  angle,
  count,
  len,
  gap,
  color = INK,
  opacity = 0.28,
}: {
  x: number;
  y: number;
  angle: number;
  count: number;
  len: number;
  gap: number;
  color?: string;
  opacity?: number;
}) {
  return (
    <g
      transform={`translate(${x} ${y}) rotate(${angle})`}
      {...stroke}
      stroke={color}
      strokeWidth="0.6"
      opacity={opacity}
    >
      {Array.from({ length: count }).map((_, i) => (
        <path
          key={i}
          d={`M${n(i * gap)} 0V${n(len * (1 - (i / count) * 0.7))}`}
        />
      ))}
    </g>
  );
}

/* ── 收藏夾 — 木蘭標本 ──────────────────────────────────── */
export function MagnoliaMotif() {
  // 花被片分兩層：後層窄一點、顏色悶一點，前層壓在上面。
  // 角度跟大小都刻意不平均——每片一樣大就會變成向量剪貼圖。
  const back = [30, 90, 150, 210, 270, 330];
  const front = [0, 62, 124, 186, 248, 310];
  const jitter = [1, 0.93, 1.05, 0.95, 1.04, 0.97];

  return (
    <svg viewBox="0 0 200 250" role="presentation" aria-hidden="true">
      {/* 枝幹：帶彎，旁邊再補一條細亮線當木紋 */}
      <path
        {...stroke}
        d="M100 136C100 166 96 192 92 210c-2 10-3 16-3 26"
        stroke="#6b5a3c"
        strokeWidth="2.6"
      />

      {/* 兩根側枝 */}
      <path {...stroke} d="M98 182C86 178 74 170 66 158" stroke="#6b5a3c" strokeWidth="1.6" />
      <path {...stroke} d="M94 212c12-3 23-11 29-23" stroke="#6b5a3c" strokeWidth="1.5" />

      {/* 葉子：大小角度都不一樣，才不像複製貼上 */}
      <g transform="translate(66 158) rotate(-56)">
        <Leaf len={46} wid={17} fill="#a9ab5e" />
      </g>
      <g transform="translate(123 189) rotate(54)">
        <Leaf len={38} wid={14} fill="#8e9147" />
      </g>
      <g transform="translate(89 232) rotate(-28)">
        <Leaf len={29} wid={11} fill="#93964b" opacity={0.9} />
      </g>

      {/* 花：後層 → 前層 → 花心的蕊柱 */}
      <g transform="translate(100 92)">
        {back.map((a, i) => (
          <g key={`b${a}`} transform={`rotate(${a})`}>
            <Petal
              len={n(51 * jitter[(i + 3) % 6])}
              wid={n(18 * jitter[i])}
              fill={PAPER}
              line="#a2a8ad"
            />
          </g>
        ))}
        {front.map((a, i) => (
          <g key={`f${a}`} transform={`rotate(${a})`}>
            <Petal
              len={n(47 * jitter[i])}
              wid={n(22 * jitter[(i + 2) % 6])}
              fill={CREAM}
              line={INK}
            />
          </g>
        ))}

        {/* 木蘭的花心是一根立起來的蕊柱，不是一顆圓點 */}
        <g {...stroke} stroke={RUST} strokeWidth="0.9" opacity="0.85">
          {[-64, -40, -18, 18, 40, 64].map((a) => (
            <path key={a} transform={`rotate(${a})`} d="M0 -6V-16" />
          ))}
        </g>
        <path
          d="M0 -17C5 -17 7.6 -9 6.4 -1 5.4 5.4 2.8 8 0 8-2.8 8-5.4 5.4-6.4-1-7.6-9-5-17 0-17Z"
          fill={OLIVE}
          stroke={MOSS}
          strokeWidth="0.9"
          strokeLinejoin="round"
        />
        <g fill={MOSS} opacity="0.5">
          <circle cx="-2.4" cy="-9" r="0.9" />
          <circle cx="2" cy="-4" r="0.9" />
          <circle cx="-1.6" cy="1.4" r="0.9" />
          <circle cx="2.6" cy="-11" r="0.8" />
        </g>
      </g>

    </svg>
  );
}

/* ── style 風向標 — 銅版羅盤 ────────────────────────────── */
export function CompassMotif() {
  const cx = 100;
  const cy = 112;
  const R = 74;
  const waist = 13;
  const P = (a: number, r: number) => [
    n(cx + r * Math.sin(rad(a))),
    n(cy - r * Math.cos(rad(a))),
  ];
  const dirs = [0, 45, 90, 135, 180, 225, 270, 315];

  return (
    <svg viewBox="0 0 200 250" role="presentation" aria-hidden="true">
      {/* 外圈：粗細兩道線，中間夾刻度 */}
      <circle cx={cx} cy={cy} r={R} fill="none" stroke={INK} strokeWidth="1.3" />
      <circle cx={cx} cy={cy} r={R - 5} fill="none" stroke={INK} strokeWidth="0.55" opacity="0.8" />
      <circle cx={cx} cy={cy} r={R - 20} fill="none" stroke={INK} strokeWidth="0.5" strokeDasharray="1 5" opacity="0.65" />

      {/* 每 5 度一刻，每 45 度長一點 */}
      <g {...stroke} stroke={INK} strokeWidth="0.6">
        {Array.from({ length: 72 }).map((_, i) => {
          const a = i * 5;
          const long = i % 9 === 0;
          const [x1, y1] = P(a, R - 5);
          const [x2, y2] = P(a, long ? R - 13 : R - 9);
          return (
            <path
              key={i}
              d={`M${x1} ${y1}L${x2} ${y2}`}
              opacity={long ? 0.9 : 0.45}
              strokeWidth={long ? 0.9 : 0.6}
            />
          );
        })}
      </g>

      {/* 八角星：每個角切成亮面／暗面，光從左上來 */}
      <g stroke={INK} strokeWidth="0.8" strokeLinejoin="round">
        {dirs.map((a) => {
          const long = a % 90 === 0;
          const [tx, ty] = P(a, long ? 60 : 33);
          const [lx, ly] = P(a - 45, waist);
          const [rx, ry] = P(a + 45, waist);
          const north = a === 0;
          return (
            <g key={a}>
              <path
                d={`M${tx} ${ty}L${lx} ${ly}L${cx} ${cy}Z`}
                fill={north ? "#fdf6ec" : CREAM}
              />
              <path
                d={`M${tx} ${ty}L${rx} ${ry}L${cx} ${cy}Z`}
                fill={north ? RUST : long ? INK : "#7d8b96"}
                opacity={north ? 0.92 : 0.9}
              />
            </g>
          );
        })}
      </g>

      {/* 軸心 */}
      <circle cx={cx} cy={cy} r="6" fill={PAPER} stroke={INK} strokeWidth="1" />
      <circle cx={cx} cy={cy} r="2.2" fill={INK} />

      {/* 方位字 */}
      <g
        fill={INK}
        fontFamily="Cormorant Garamond, Georgia, serif"
        fontSize="15"
        letterSpacing="1"
        textAnchor="middle"
        opacity="0.85"
      >
        <text x={cx} y={cy - R - 9}>N</text>
        <text x={cx} y={cy + R + 20}>S</text>
        <text x={cx - R - 13} y={cy + 5}>W</text>
        <text x={cx + R + 13} y={cy + 5}>E</text>
      </g>

      {/* 下方一道小飾線，把畫面壓住 */}
      <g {...stroke} stroke="#b9ae97" strokeWidth="0.8" opacity="0.75">
        <path d="M62 232h30" />
        <path d="M108 232h30" />
      </g>
      <path d="M100 228l3.4 4-3.4 4-3.4-4z" fill={OLIVE} opacity="0.8" />
    </svg>
  );
}

/* ── 年度總結 — 月桂冠 ──────────────────────────────────── */
export function WreathMotif() {
  const cx = 100;
  const cy = 122;
  const R = 68;
  const COUNT = 10;
  const at = (a: number, r = R) =>
    [n(cx + r * Math.sin(rad(a))), n(cy + r * Math.cos(rad(a)))] as const;

  // 枝條：照角度取樣連成線，省得跟 SVG 弧線的 flag 打架
  const branch = (side: 1 | -1) => {
    const pts: string[] = [];
    for (let a = 4; a <= 150; a += 4) {
      pts.push(
        `${n(cx + side * R * Math.sin(rad(a)))} ${n(cy + R * Math.cos(rad(a)))}`
      );
    }
    return `M${pts.join("L")}`;
  };

  const leaves = ([1, -1] as const).flatMap((side) =>
    Array.from({ length: COUNT }).map((_, i) => {
      const a = 12 + i * 15;
      const [x, y] = at(side * a);
      // 切線方向（順著枝條往上），再往外岔開一點，上下交錯
      const tangent =
        (Math.atan2(side * Math.cos(rad(a)), Math.sin(rad(a))) * 180) /
        Math.PI;
      const splay = i % 2 === 0 ? 28 : -24;
      // 中段的葉子最大，兩頭收小
      const len = 15 + 11 * Math.sin((Math.PI * (i + 0.7)) / COUNT);
      return (
        <g
          key={`${side}-${i}`}
          transform={`translate(${x} ${y}) rotate(${n(tangent + splay)})`}
        >
          <Leaf
            len={len}
            wid={len * 0.31}
            fill={i % 3 === 0 ? "#8e9147" : OLIVE}
            opacity={0.95}
          />
        </g>
      );
    })
  );

  // 果實長在枝條上，三顆一叢，不是飄在半空
  const berries = ([1, -1] as const).flatMap((side) =>
    [38, 92].map((a) => {
      const [x, y] = at(side * a, R - 4);
      return (
        <g key={`${side}-${a}`} transform={`translate(${x} ${y})`} fill={RUST}>
          <circle cx="0" cy="0" r="2.4" opacity="0.8" />
          <circle cx="3.4" cy="2.6" r="1.9" opacity="0.65" />
          <circle cx="-2.8" cy="2.8" r="1.7" opacity="0.7" />
        </g>
      );
    })
  );

  return (
    <svg viewBox="0 0 200 250" role="presentation" aria-hidden="true">
      <g {...stroke} stroke={MOSS} strokeWidth="1.6" opacity="0.9">
        <path d={branch(1)} />
        <path d={branch(-1)} />
      </g>

      {leaves}
      {berries}

      {/* 底下的緞帶：兩個圈 + 兩條垂尾 + 中間的結 */}
      <g transform={`translate(${cx} ${n(cy + R + 2)})`}>
        <g {...stroke} stroke={RUST} strokeWidth="1.4">
          <path d="M0 0C-9-7-22-5-24 3c-2 8 9 11 16 5C-3 4 0 1 0 0Z" fill="#fdf4ee" />
          <path d="M0 0C9-7 22-5 24 3c2 8-9 11-16 5C3 4 0 1 0 0Z" fill="#fdf4ee" />
          <path d="M-2 3C-6 12-11 19-19 24" />
          <path d="M2 3C6 12 11 19 19 24" />
        </g>
        <ellipse cx="0" cy="1.5" rx="3.6" ry="3" fill="#fdf4ee" stroke={RUST} strokeWidth="1.3" />
      </g>

      {/* 年份放在環的正中心 */}
      <text
        x={cx}
        y={cy + 15}
        textAnchor="middle"
        fontFamily="Cormorant Garamond, Georgia, serif"
        fontSize="44"
        fontWeight="300"
        letterSpacing="2"
        fill={INK}
      >
        {new Date().getFullYear()}
      </text>
      <g {...stroke} stroke="#b9ae97" strokeWidth="0.8" opacity="0.8">
        <path d={`M${cx - 20} ${cy + 27}h40`} />
      </g>
    </svg>
  );
}

/* ── 散件用的壓乾枝葉 ───────────────────────────────────── */
export function SprigMotif() {
  const leaves = Array.from({ length: 7 }).map((_, i) => {
    const t = i / 6;
    const x = 22 + t * 196;
    const y = 74 - t * 54;
    const len = 15 + 8 * Math.sin(Math.PI * (t + 0.15));
    const up = i % 2 === 0;
    return (
      <g
        key={i}
        transform={`translate(${n(x)} ${n(y)}) rotate(${up ? -52 : 42})`}
      >
        <Leaf len={len} wid={len * 0.36} fill={up ? OLIVE : "#8b8e45"} opacity={0.85} />
      </g>
    );
  });

  return (
    <svg viewBox="0 0 240 90" role="presentation" aria-hidden="true">
      <path
        {...stroke}
        d="M8 78C62 70 140 52 234 16"
        stroke="#6b5a3c"
        strokeWidth="1.8"
      />
      {leaves}
    </svg>
  );
}
