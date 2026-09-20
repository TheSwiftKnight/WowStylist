import Link from "next/link";
import Wrap from "./Wrap";
import { getWrapStats } from "@/lib/yearly";

export const dynamic = "force-dynamic";

export const metadata = { title: "年度總結 — WowStylist" };

export default async function YearlyPage() {
  const stats = await getWrapStats();

  return (
    <main className="board board--fixed">
      <div className="return-bar">
        <Link className="return-link" href="/">
          ← 回靈感板
        </Link>
        <span className="label-type">Almanac {stats.year}</span>
      </div>

      <Wrap stats={stats} />
    </main>
  );
}
