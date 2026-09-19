import { NextResponse } from "next/server";
import { extractIgLinks } from "@/lib/ig";
import { PipelineError, requestIngest } from "@/lib/pipeline";
import { createFailedJob } from "@/lib/jobs";

export const dynamic = "force-dynamic";

// POST /api/ingest — 把一條 IG 連結送進分析 pipeline
//
// 立刻回 job id，不等 pipeline 跑完（整條要幾十秒到幾分鐘）。
// 進度看 GET /api/jobs。
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

  try {
    const ticket = await requestIngest(links[0].url, {
      sourceText: body.url,
      senderName: "手動新增",
    });
    return NextResponse.json({ job: ticket }, { status: 202 });
  } catch (err) {
    const message =
      err instanceof PipelineError ? err.message : "送件失敗";

    console.error("[ingest] 送件失敗：", err);

    await createFailedJob(links[0].url, String(err), {
      shortcode: links[0].shortcode,
      sourceText: body.url,
      senderName: "手動新增",
    });

    return NextResponse.json(
      { error: message },
      { status: err instanceof PipelineError ? err.status : 500 }
    );
  }
}
