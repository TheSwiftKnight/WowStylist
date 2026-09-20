import fs from "node:fs";
import path from "node:path";
import Link from "next/link";
import Scatter from "./components/Scatter";
import { CompassMotif, MagnoliaMotif, WreathMotif } from "./components/Motifs";
import { listGarments } from "@/lib/garments";
import { listTags } from "@/lib/tags";

export const dynamic = "force-dynamic";

/** 拿 public/media 裡已經抓下來的圖，當首頁裝飾用的拍立得照片。 */
function decorPhotos(): string[] {
  try {
    return fs
      .readdirSync(path.join(process.cwd(), "public", "media"))
      .filter((f) => /\.(jpe?g|png|webp)$/i.test(f))
      .slice(0, 6)
      .map((f) => `/media/${f}`);
  } catch {
    return [];
  }
}

export default async function WallPage() {
  const [{ garments }, { tags }] = await Promise.all([
    listGarments(),
    listTags(),
  ]);
  const year = new Date().getFullYear();

  // 相框下緣那條描圖紙用權重最高的三個標籤。
  const topTags = [...tags]
    .sort((a, b) => b.weight - a.weight)
    .slice(0, 3)
    .map((t) => t.label);

  return (
    <main className="wall">
      <Scatter photos={decorPhotos()} />

      <div className="wall__inner">
        <header className="masthead">
          <p className="masthead__kicker"><span className="brand">wOow</span></p>
          <h1 className="masthead__title">
            My<em> Inspiration</em>
          </h1>
          <div className="masthead__rule" aria-hidden="true">
            <span />
            <i />
            <span />
          </div>
          <p className="masthead__lede">
            從 LINE 丟進來的每一張穿搭，都釘在這面牆上。
          </p>
        </header>

        <nav className="entries" aria-label="分頁">
          <Link className="entry" href="/favorites">
            <span className="pin" />
            <span className="entry__no" aria-hidden="true">
              I
            </span>
            <div
              className="entry__plate"
              style={{ ["--plate" as string]: "#efe9db" }}
            >
              <MagnoliaMotif />
              <span className="entry__strip">
                {garments.length > 0
                  ? `${garments.length} items`
                  : "waiting for the first one"}
              </span>
            </div>
            <div className="entry__caption">
              <h2 className="entry__name">收藏夾</h2>
              <p className="entry__sub">Saved</p>
              <p className="entry__meta">
                從 LINE 分享進來的穿搭 · 共 {garments.length} 件單品
              </p>
            </div>
          </Link>

          <Link className="entry" href="/compass">
            <span className="pin pin--slate" />
            <span className="entry__no" aria-hidden="true">
              II
            </span>
            <div
              className="entry__plate"
              style={{ ["--plate" as string]: "#e9eef0" }}
            >
              <CompassMotif />
              <span className="entry__strip">
                {topTags.length > 0
                  ? topTags.join(" · ")
                  : "還沒有標籤"}
              </span>
            </div>
            <div className="entry__caption">
              <h2 className="entry__name">style 風向標</h2>
              <p className="entry__sub">Your Algorithm</p>
              <p className="entry__meta">
                現在的你偏向什麼 · {tags.length} 個標籤
              </p>
            </div>
          </Link>

          <Link className="entry" href="/yearly">
            <span className="pin pin--rust" />
            <span className="entry__no" aria-hidden="true">
              III
            </span>
            <div
              className="entry__plate"
              style={{ ["--plate" as string]: "#f0e7d5" }}
            >
              <WreathMotif />
              <span className="entry__strip">{year} in review</span>
            </div>
            <div className="entry__caption">
              <h2 className="entry__name">年度總結</h2>
              <p className="entry__sub">Almanac</p>
              <p className="entry__meta">{year} 這一年的穿搭軌跡</p>
            </div>
          </Link>
        </nav>

        <footer className="wall__foot">
          <span>Pinned in Taipei</span>
          <i aria-hidden="true" />
          <span>{year}</span>
        </footer>
      </div>
    </main>
  );
}
