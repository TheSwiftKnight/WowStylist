import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { enrichLink } from "@/lib/ingest";

export const dynamic = "force-dynamic";

// POST /api/links/backfill — 補抓「還沒抓過」或「上次抓失敗」的貼文內容。
// 一次最多處理 10 筆（避免打太兇被 IG 限流），前端按鈕可以按多次。
export async function POST() {
  const pending = await prisma.sharedLink.findMany({
    where: { OR: [{ fetchStatus: null }, { fetchStatus: "failed" }] },
    orderBy: { createdAt: "desc" },
    take: 10,
  });

  let ok = 0;
  let failed = 0;
  for (const row of pending) {
    const updated = await enrichLink(row);
    if (updated.fetchStatus === "ok") ok++;
    else failed++;
  }

  const remaining = await prisma.sharedLink.count({
    where: { OR: [{ fetchStatus: null }, { fetchStatus: "failed" }] },
  });

  return NextResponse.json({ processed: pending.length, ok, failed, remaining });
}
