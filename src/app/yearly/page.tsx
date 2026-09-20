import Link from "next/link";

export const metadata = { title: "年度總結 — WowStylist" };

export default function YearlyPage() {
  const year = new Date().getFullYear();

  return (
    <main className="board">
      <div className="return-bar">
        <Link className="return-link" href="/">
          ← 回靈感板
        </Link>
        <span className="label-type">Almanac</span>
      </div>

      {/* 內容先留空 —— 版面與導覽先搭好，等年度資料的規格確定再填。 */}
      <div className="board__inner">
        <header className="page-head">
          <h1 className="page-title">
            年度<em>總結</em>
          </h1>
          <p className="page-note">
            等一整年的收藏累積夠了，這裡會長出你的色系、輪廓與版型軌跡。
          </p>
          <div className="page-head__meta fav-head__count">{year}</div>
        </header>
      </div>

      <div className="yearly">
        <section className="yearly__sheet">
          <span className="clip" aria-hidden="true" />
          <div>
            <h1 className="yearly__year">{year}</h1>
            <p className="yearly__word">這一頁還空著</p>
          </div>
        </section>
      </div>
    </main>
  );
}
