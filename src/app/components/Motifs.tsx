/**
 * 三個入口的手繪圖騰（純裝飾，畫在相框裡）。
 * 用 SVG 線稿而不是照片，這樣沒有素材也不會出現破圖。
 */

const stroke = {
  fill: "none",
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

/** 收藏夾 — 木蘭枝 */
export function MagnoliaMotif() {
  return (
    <svg viewBox="0 0 200 250" role="presentation" aria-hidden="true">
      <g {...stroke} stroke="#6f7136" strokeWidth="1.4">
        <path d="M100 246c0-46 2-78 8-104" />
        <path d="M108 168c-18-6-32-20-38-40 22 2 36 12 44 30" />
        <path d="M112 142c16-10 26-26 27-48-20 6-32 19-35 38" />
        <path d="M104 206c-14-4-24-14-29-29 17 2 28 10 34 24" />
      </g>
      <g {...stroke} stroke="#3f4f5d" strokeWidth="1.5">
        <path d="M100 96c-6-22-24-34-46-32 4 22 20 34 46 32z" fill="#fdfbf4" />
        <path d="M100 96c6-22 24-34 46-32-4 22-20 34-46 32z" fill="#fdfbf4" />
        <path d="M100 96c-20-10-28-30-22-52 20 10 28 30 22 52z" fill="#fdfbf4" />
        <path d="M100 96c20-10 28-30 22-52-20 10-28 30-22 52z" fill="#fdfbf4" />
        <path d="M100 96c-2-24 10-42 32-50-4 24-14 40-32 50z" fill="#fdfbf4" />
      </g>
      <circle cx="100" cy="97" r="7" fill="#9a9b4f" />
      <g stroke="#a95c2a" strokeWidth="1.1" {...stroke}>
        <path d="M100 90v-6M94 94l-4-4M106 94l4-4" />
      </g>
    </svg>
  );
}

/** style 風向標 — 風向雞 / 羅盤 */
export function CompassMotif() {
  return (
    <svg viewBox="0 0 200 250" role="presentation" aria-hidden="true">
      <g {...stroke} stroke="#3f4f5d" strokeWidth="1.4">
        <circle cx="100" cy="112" r="62" />
        <circle cx="100" cy="112" r="48" strokeDasharray="2 6" />
        <path d="M100 44v-14M100 194v14M32 112H18M182 112h14" />
        <path d="M100 236V178" />
        <path d="M76 178h48" />
      </g>
      <path
        d="M100 58l13 44 44 10-44 10-13 44-13-44-44-10 44-10z"
        fill="#f4efe1"
        stroke="#6f7136"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
      <path d="M100 58l13 44-13 10-13-10z" fill="#a95c2a" opacity="0.85" />
      <circle cx="100" cy="112" r="5.5" fill="#3f4f5d" />
      <g
        fill="#8c8072"
        fontFamily="Cormorant Garamond, Georgia, serif"
        fontSize="15"
        textAnchor="middle"
      >
        <text x="100" y="28">N</text>
        <text x="100" y="226">S</text>
        <text x="10" y="117">W</text>
        <text x="192" y="117">E</text>
      </g>
    </svg>
  );
}

/** 年度總結 — 月桂冠 */
export function WreathMotif() {
  return (
    <svg viewBox="0 0 200 250" role="presentation" aria-hidden="true">
      <g {...stroke} stroke="#6f7136" strokeWidth="1.4">
        <path d="M100 216C48 204 22 168 26 122 30 76 60 46 100 38" />
        <path d="M100 216c52-12 78-48 74-94-4-46-34-76-74-84" />
      </g>
      <g fill="#9a9b4f" opacity="0.75">
        {Array.from({ length: 9 }).map((_, i) => {
          const t = i / 8;
          const a = Math.PI * (0.62 + t * 0.9);
          const x = 100 + Math.cos(a) * 74;
          const y = 127 + Math.sin(a) * 88;
          return (
            <ellipse
              key={`l${i}`}
              cx={x}
              cy={y}
              rx="13"
              ry="5.5"
              transform={`rotate(${(a * 180) / Math.PI + 90} ${x} ${y})`}
            />
          );
        })}
        {Array.from({ length: 9 }).map((_, i) => {
          const t = i / 8;
          const a = Math.PI * (0.38 - t * 0.9);
          const x = 100 + Math.cos(a) * 74;
          const y = 127 + Math.sin(a) * 88;
          return (
            <ellipse
              key={`r${i}`}
              cx={x}
              cy={y}
              rx="13"
              ry="5.5"
              transform={`rotate(${(a * 180) / Math.PI - 90} ${x} ${y})`}
            />
          );
        })}
      </g>
      <text
        x="100"
        y="140"
        textAnchor="middle"
        fontFamily="Cormorant Garamond, Georgia, serif"
        fontSize="54"
        fontWeight="300"
        fill="#3f4f5d"
      >
        {new Date().getFullYear()}
      </text>
      <path
        d="M62 214c14 10 62 10 76 0"
        {...stroke}
        stroke="#a95c2a"
        strokeWidth="1.3"
      />
    </svg>
  );
}

/** 散落用的壓乾枝葉 */
export function SprigMotif() {
  return (
    <svg viewBox="0 0 240 90" role="presentation" aria-hidden="true">
      <path
        d="M6 74C60 66 136 50 232 18"
        {...stroke}
        stroke="#6b5a3c"
        strokeWidth="2.2"
      />
      <g fill="#9a9b4f" opacity="0.8">
        <ellipse cx="46" cy="58" rx="17" ry="7" transform="rotate(-22 46 58)" />
        <ellipse cx="84" cy="52" rx="15" ry="6.5" transform="rotate(-30 84 52)" />
        <ellipse cx="122" cy="44" rx="18" ry="7.5" transform="rotate(-24 122 44)" />
        <ellipse cx="160" cy="34" rx="14" ry="6" transform="rotate(-28 160 34)" />
        <ellipse cx="196" cy="26" rx="16" ry="6.5" transform="rotate(-20 196 26)" />
      </g>
      <g fill="#6f7136" opacity="0.6">
        <ellipse cx="64" cy="70" rx="12" ry="5" transform="rotate(16 64 70)" />
        <ellipse cx="104" cy="62" rx="11" ry="4.5" transform="rotate(12 104 62)" />
        <ellipse cx="142" cy="54" rx="12" ry="5" transform="rotate(14 142 54)" />
      </g>
    </svg>
  );
}
