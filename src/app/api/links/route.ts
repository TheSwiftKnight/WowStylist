import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { extractIgLinks } from "@/lib/ig";
import { saveLink } from "@/lib/ingest";

export const dynamic = "force-dynamic";

// GET /api/links — 列出所有收藏的連結（新到舊）
export async function GET() {
  const links = await prisma.sharedLink.findMany({
    orderBy: { createdAt: "desc" },
  });
  return NextResponse.json({ links });
}

// POST /api/links — 手動新增（前端表單 / 測試用，不經過 LINE）
// 會同步抓取 IG 內容，所以要等個 1~3 秒
export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as { url?: string } | null;
  if (!body?.url) {
    return NextResponse.json({ error: "缺少 url" }, { status: 400 });
  }

  const links = extractIgLinks(body.url);
  if (links.length === 0) {
    return NextResponse.json(
      { error: "看不出這是 Instagram 貼文/Reels 連結" },
      { status: 422 }
    );
  }

  const saved = await saveLink(links[0], {
    sourceText: body.url,
    senderName: "手動新增",
  });

  return NextResponse.json({ link: saved }, { status: 201 });
}
