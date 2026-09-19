import Link from "next/link";
import TagCloud from "./TagCloud";
import { listTags } from "@/lib/tags";

export const dynamic = "force-dynamic";

export const metadata = { title: "style 風向標 — WowStylist" };

export default async function CompassPage() {
  const tags = await listTags();

  return (
    <main className="board board--fixed">
      <div className="return-bar">
        <Link className="return-link" href="/">
          ← 回靈感板
        </Link>
        <span className="label-type">Your Algorithm</span>
      </div>

      <div className="compass">
        <header className="compass__head">
          <div>
            <h1 className="page-title">
              style <em>風向標</em>
            </h1>
            <p className="page-note">
              這些是目前系統讀到的你。點一下改名字、點兩下換分類、右邊的 × 刪掉。
            </p>
          </div>
          <div className="compass__legend">
            <span>
              <i style={{ background: "#9a9b4f" }} />
              風格
            </span>
            <span>
              <i style={{ background: "#8ba0af" }} />
              色系
            </span>
            <span>
              <i style={{ background: "#b8623c" }} />
              形容詞
            </span>
          </div>
        </header>

        <section className="compass__sheet">
          <span className="clip" aria-hidden="true" />
          <TagCloud initialTags={tags} />
        </section>

        <footer className="compass__foot">
          <span>字級大小＝這個標籤在你收藏裡的比重</span>
          <span>示範資料 · 尚未接上資料庫</span>
        </footer>
      </div>
    </main>
  );
}
