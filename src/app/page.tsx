import { prisma } from "@/lib/db";
import AddLinkForm from "./components/AddLinkForm";
import LinkCard from "./components/LinkCard";
import BackfillButton from "./components/BackfillButton";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const links = await prisma.sharedLink.findMany({
    orderBy: { createdAt: "desc" },
  });

  const pendingCount = links.filter((l) => l.fetchStatus !== "ok").length;

  return (
    <main className="container">
      <div className="header">
        <h1>靈感收藏</h1>
        <span className="count">{links.length} 則</span>
        {pendingCount > 0 && <BackfillButton pendingCount={pendingCount} />}
      </div>
      <p className="subtitle">
        把喜歡的 Instagram 貼文或 Reels 分享給 LINE 官方帳號，就會出現在這裡。
      </p>

      <AddLinkForm />

      {links.length === 0 ? (
        <div className="empty">
          還沒有收藏。
          <br />
          用上面的欄位貼一個 IG 連結試試，或把貼文分享給你的 LINE bot。
        </div>
      ) : (
        <div className="grid">
          {links.map((link) => (
            <LinkCard
              key={link.id}
              id={link.id}
              url={link.url}
              kind={link.kind}
              username={link.username}
              caption={link.caption}
              mediaPath={link.mediaPath}
              isVideo={link.isVideo}
              senderName={link.senderName}
              createdAt={link.createdAt.toISOString()}
            />
          ))}
        </div>
      )}
    </main>
  );
}
