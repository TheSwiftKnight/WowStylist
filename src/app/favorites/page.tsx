import Link from "next/link";
import AddLinkForm from "../components/AddLinkForm";
import BackfillButton from "../components/BackfillButton";
import PinnedCard from "../components/PinnedCard";
import { getLinks } from "@/lib/links";

export const dynamic = "force-dynamic";

export const metadata = { title: "收藏夾 — WowStylist" };

export default async function FavoritesPage() {
  const { links, isMock, pendingCount } = await getLinks();

  return (
    <main className="board">
      <div className="return-bar">
        <Link className="return-link" href="/">
          ← 回靈感板
        </Link>
        <span className="label-type">Saved</span>
      </div>

      <div className="board__inner">
        <header className="fav-head">
          <div>
            <h1 className="page-title">
              收藏<em>夾</em>
            </h1>
            <p className="page-note">
              你分享給 LINE 官方帳號的貼文都會被釘在這面板子上。點圖片開原始貼文，
              右下角的「取下」會一併把它從資料庫刪掉。
            </p>
          </div>
          <div className="fav-head__count">{links.length} 則</div>
        </header>

        <div className="fav-tools">
          <AddLinkForm />
          {pendingCount > 0 && <BackfillButton pendingCount={pendingCount} />}
          {isMock && (
            <span className="mock-flag">示範資料 · 尚未接上資料庫</span>
          )}
        </div>

        {links.length === 0 ? (
          <div className="empty-board">
            <span className="pin" aria-hidden="true" />
            <p>
              板子上還是空的。
              <br />
              用上面的欄位貼一個 IG 連結，或把貼文分享給你的 LINE bot。
            </p>
          </div>
        ) : (
          <div className="pinboard">
            {links.map((link) => (
              <PinnedCard key={link.id} link={link} isMock={isMock} />
            ))}
          </div>
        )}
      </div>
    </main>
  );
}
