// 年度總結要的數字。
//
// 資料來源刻意跟其他兩頁一樣，不另外開一條路：
//   收藏夾 listGarments()  → 件數 / 套數 / 貼文數 / 時間軸 / 封面圖
//   風向標 listTags()      → 風格 / 色系 / 形容詞的排行
//
// listTags() 自己已經有三層 fallback（style_tags → garment_style_tags → MOCK_TAGS），
// 所以這頁不管資料庫在不在，都一定有東西可以翻。

import { listGarments } from "@/lib/garments";
import { groupByPost } from "@/lib/outfits";
import { listTags, type StyleTag, type StyleTagKind } from "@/lib/tags";

/** 排行榜的一列。share 是「在同一個圖例裡佔多少」，0~1。 */
export type RankedTag = {
  label: string;
  share: number;
};

/** 時間軸的一格。 */
export type MonthBar = {
  /** 1~12 */
  month: number;
  count: number;
};

export type WrapStats = {
  year: number;
  /** true = 這一年沒有資料，數字是拿全部收藏算的 */
  spansAllTime: boolean;

  postCount: number;
  outfitCount: number;
  garmentCount: number;
  topCount: number;
  pantsCount: number;

  styles: RankedTag[];
  colors: RankedTag[];
  moods: RankedTag[];

  months: MonthBar[];
  /** 收得最兇的那個月；完全沒資料時是 null */
  busiestMonth: MonthBar | null;

  /** 封面拼貼要用的單品 id（都是有圖的） */
  coverIds: number[];

  isMock: boolean;
};

/** 權重在同一個圖例裡正規化成佔比，取前 n 名。 */
function rank(tags: StyleTag[], kind: StyleTagKind, n: number): RankedTag[] {
  const mine = tags.filter((t) => t.kind === kind && t.label.trim() !== "");
  const total = mine.reduce((sum, t) => sum + t.weight, 0);

  return [...mine]
    .sort((a, b) => b.weight - a.weight || a.label.localeCompare(b.label))
    .slice(0, n)
    .map((t) => ({
      label: t.label,
      share: total > 0 ? t.weight / total : 0,
    }));
}

export async function getWrapStats(): Promise<WrapStats> {
  const [{ garments, isMock: garmentsMock }, { tags, isMock: tagsMock }] =
    await Promise.all([listGarments(), listTags()]);

  const year = new Date().getFullYear();

  // 以今年為準；今年還沒收過東西（demo 常見）就退回全部，
  // 不然整頁會變成一排 0。
  const thisYear = garments.filter(
    (g) => new Date(g.createdAt).getFullYear() === year
  );
  const spansAllTime = thisYear.length === 0 && garments.length > 0;
  const scoped = spansAllTime ? garments : thisYear;

  const posts = groupByPost(scoped);

  const months: MonthBar[] = Array.from({ length: 12 }, (_, i) => ({
    month: i + 1,
    count: 0,
  }));
  for (const g of scoped) {
    const m = new Date(g.createdAt).getMonth();
    if (m >= 0 && m < 12) months[m].count += 1;
  }
  const busiestMonth = months.reduce<MonthBar | null>(
    (best, m) => (m.count > 0 && (!best || m.count > best.count) ? m : best),
    null
  );

  return {
    year,
    spansAllTime,

    postCount: posts.length,
    outfitCount: posts.reduce((n, p) => n + p.outfits.length, 0),
    garmentCount: scoped.length,
    topCount: scoped.filter((g) => g.category === "top").length,
    pantsCount: scoped.filter((g) => g.category === "pants").length,

    styles: rank(tags, "style", 5),
    colors: rank(tags, "color", 6),
    moods: rank(tags, "mood", 4),

    months,
    busiestMonth,

    // id 從 DB 回來可能是字串（pg 的 bigint），型別上宣告了 number，這裡收乾淨
    coverIds: scoped
      .filter((g) => g.hasImage)
      .slice(0, 6)
      .map((g) => Number(g.id)),

    isMock: garmentsMock && tagsMock,
  };
}
