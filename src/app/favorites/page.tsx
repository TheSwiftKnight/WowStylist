import Link from "next/link";
import AddLinkForm from "../components/AddLinkForm";
import JobsBanner from "../components/JobsBanner";
import GarmentCard from "../components/GarmentCard";
import { listGarments } from "@/lib/garments";
import { listRecentJobs } from "@/lib/jobs";

export const dynamic = "force-dynamic";

export const metadata = { title: "收藏夾 — WowStylist" };

export default async function FavoritesPage() {
  const [{ garments, isMock }, jobs] = await Promise.all([
    listGarments(),
    listRecentJobs(10),
  ]);

  const tops = garments.filter((g) => g.category === "top").length;
  const pants = garments.filter((g) => g.category === "pants").length;

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
              你分享給 LINE 官方帳號的貼文，會被拆成一件一件的單品釘在這面板子上。
              每件都有一段 AI 寫的描述跟一組語意向量，之後拿來配商品。
            </p>
          </div>
          <div className="fav-head__count">
            {garments.length} 件 · 上衣 {tops} / 褲子 {pants}
          </div>
        </header>

        <div className="fav-tools">
          <AddLinkForm />
          {isMock && (
            <span className="mock-flag">示範資料 · 尚未接上資料庫</span>
          )}
        </div>

        <JobsBanner initialJobs={jobs} />

        {garments.length === 0 ? (
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
            {garments.map((garment) => (
              <GarmentCard
                key={garment.id}
                garment={garment}
                isMock={isMock}
              />
            ))}
          </div>
        )}
      </div>
    </main>
  );
}
