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

  return (
    <main className="wall">
      <Scatter photos={decorPhotos()} />

      <div className="wall__inner">
        <header className="masthead">
          <p className="masthead__kicker">Wow Stylist</p>
          <h1 className="masthead__title">
            My<em> Inspiration</em>
          </h1>
          <div className="masthead__rule" />
        </header>

        <nav className="entries" aria-label="分頁">
          <Link className="entry" href="/favorites">
            <span className="pin" />
            <div
              className="entry__plate"
              style={{ ["--plate" as string]: "#efe9db" }}
            >
              <MagnoliaMotif />
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
            <div
              className="entry__plate"
              style={{ ["--plate" as string]: "#e9eef0" }}
            >
              <CompassMotif />
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
            <div
              className="entry__plate"
              style={{ ["--plate" as string]: "#f0e7d5" }}
            >
              <WreathMotif />
            </div>
            <div className="entry__caption">
              <h2 className="entry__name">年度總結</h2>
              <p className="entry__sub">Almanac</p>
              <p className="entry__meta">{year} 這一年的穿搭軌跡</p>
              <span className="entry__soon">籌備中</span>
            </div>
          </Link>
        </nav>
      </div>
    </main>
  );
}
