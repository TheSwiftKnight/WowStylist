// 收藏連結的共用邏輯：webhook 和手動新增都走這裡
import { prisma } from "./db";
import type { IgLink } from "./ig";
import { fetchIgMeta } from "./igFetch";
import type { SharedLink } from "@prisma/client";

type Extra = {
  sourceText?: string | null;
  senderId?: string | null;
  senderName?: string | null;
};

/** 只建立/取回資料列，不抓 IG 內容（webhook 用：先快速回覆，再慢慢抓） */
export async function saveLinkBasic(
  link: IgLink,
  extra: Extra
): Promise<SharedLink> {
  return prisma.sharedLink.upsert({
    where: { shortcode: link.shortcode },
    update: {}, // 已存在就不動（去重）
    create: {
      url: link.url,
      shortcode: link.shortcode,
      kind: link.kind,
      sourceText: extra.sourceText ?? null,
      senderId: extra.senderId ?? null,
      senderName: extra.senderName ?? null,
    },
  });
}

/** 抓 IG 內容（caption/username/圖片）並更新資料列 */
export async function enrichLink(row: {
  id: number;
  shortcode: string;
  kind: string;
}): Promise<SharedLink> {
  const meta = await fetchIgMeta(row.shortcode, row.kind);
  return prisma.sharedLink.update({
    where: { id: row.id },
    data: meta
      ? {
          username: meta.username,
          caption: meta.caption,
          mediaPath: meta.mediaPath,
          isVideo: meta.isVideo,
          fetchStatus: "ok",
          fetchedAt: new Date(),
        }
      : { fetchStatus: "failed", fetchedAt: new Date() },
  });
}

/** 建立 + 立刻抓內容（手動新增用，UI 會等結果） */
export async function saveLink(link: IgLink, extra: Extra): Promise<SharedLink> {
  const row = await saveLinkBasic(link, extra);
  if (row.fetchStatus === "ok") return row; // 已抓過就不重抓
  return enrichLink(row);
}
