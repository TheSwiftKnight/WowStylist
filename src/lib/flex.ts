// 把推薦結果組成 LINE Flex Message（carousel）。
//
// 為什麼用 Flex carousel：
//   - carousel 天生就是橫向滑動，一套一張卡
//   - 卡片裡可以放圖、超連結（uri action）和按讚（postback action）
//   - 純文字訊息做不到上面任何一項
//
// 圖片來源是 /api/products/:id/image（LINE 伺服器會自己去抓，所以 SITE_URL
// 必須是公開的 HTTPS 網址）。
//
// 一張卡 = 一套穿搭，卡內上下身各一列，每列有自己的「收藏」和「看商品」。
// 按讚走 postback，webhook 收到後呼叫 likeProduct()（見 src/lib/likes.ts）。

import type { RecommendedOutfit, RecommendedItem } from "@/lib/chat";
import { siteUrl } from "@/lib/url";

export { siteUrl };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type FlexNode = Record<string, any>;

export type FlexMessage = {
  type: "flex";
  altText: string;
  contents: FlexNode;
};

function productImageUrl(productId: number): string | null {
  const base = siteUrl();
  return base ? `${base}/api/products/${productId}/image` : null;
}

const SLOT_LABEL: Record<RecommendedItem["slot"], string> = {
  top: "上衣",
  bottom: "下著",
};

function priceText(price: number | null): string {
  return price === null ? "—" : `NT$${Math.round(price).toLocaleString("en-US")}`;
}

/** 一件商品一列：左邊圖，右邊標題／價格／兩顆按鈕。 */
function itemRow(item: RecommendedItem): FlexNode {
  const img = productImageUrl(item.productId);

  const buttons: FlexNode[] = [
    {
      type: "button",
      style: "secondary",
      height: "sm",
      action: {
        type: "postback",
        label: "♡",
        // postback data 上限 300 字元，只放必要的
        data: `action=like&pid=${item.productId}&slot=${item.slot}`,
        displayText: `收藏這件${SLOT_LABEL[item.slot]}`,
      },
    },
  ];

  if (item.productUrl) {
    buttons.push({
      type: "button",
      style: "link",
      height: "sm",
      action: { type: "uri", label: "🔗", uri: item.productUrl },
    });
  }

  const right: FlexNode = {
    type: "box",
    layout: "vertical",
    flex: 3,
    spacing: "xs",
    contents: [
      {
        type: "text",
        text: `${SLOT_LABEL[item.slot]}`,
        size: "xxs",
        color: "#9AA0A6",
      },
      {
        type: "text",
        text: item.title ?? `商品 ${item.productId}`,
        size: "sm",
        weight: "bold",
        wrap: true,
        maxLines: 2,
        // 整列點下去也能開商品頁，不是只有按鈕可以點
        ...(item.productUrl
          ? { action: { type: "uri", label: "看商品", uri: item.productUrl } }
          : {}),
      },
      { type: "text", text: priceText(item.priceTwd), size: "xs", color: "#6B7280" },
      { type: "box", layout: "horizontal", spacing: "sm", contents: buttons },
    ],
  };

  const left: FlexNode = img
    ? {
        type: "image",
        url: img,
        flex: 2,
        size: "full",
        aspectRatio: "1:1",
        aspectMode: "cover",
        ...(item.productUrl
          ? { action: { type: "uri", label: "看商品", uri: item.productUrl } }
          : {}),
      }
    : {
        // 沒有 SITE_URL 就退成一個灰底占位，不要讓整張卡壞掉
        type: "box",
        layout: "vertical",
        flex: 2,
        backgroundColor: "#F1F1F1",
        cornerRadius: "md",
        contents: [{ type: "filler" }],
      };

  return {
    type: "box",
    layout: "horizontal",
    spacing: "md",
    contents: [left, right],
  };
}

function bubble(outfit: RecommendedOutfit, total: number): FlexNode {
  const rows: FlexNode[] = [];
  outfit.items.forEach((item, i) => {
    if (i > 0) rows.push({ type: "separator", margin: "md" });
    rows.push({ ...itemRow(item), margin: i > 0 ? "md" : undefined });
  });

  return {
    type: "bubble",
    size: "mega",
    body: {
      type: "box",
      layout: "vertical",
      spacing: "sm",
      contents: [
        {
          type: "text",
          text: `第 ${outfit.index} / ${total} 套 · ${outfit.styleZh}`,
          size: "xs",
          color: "#9AA0A6",
          weight: "bold",
        },
        ...rows,
      ],
    },
  };
}

/**
 * 推薦 → Flex carousel。沒有可用的套數時回 null（呼叫端改送純文字）。
 * LINE 的 carousel 上限是 12 張，這裡再保險截一次。
 */
export function buildOutfitCarousel(
  outfits: RecommendedOutfit[],
  opts?: { altText?: string }
): FlexMessage | null {
  const usable = outfits.filter((o) => o.items.length > 0).slice(0, 12);
  if (usable.length === 0) return null;

  const styleZh = usable[0].styleZh;

  return {
    type: "flex",
    altText:
      opts?.altText ??
      `幫你挑了 ${usable.length} 套「${styleZh}」的搭配（在手機上左右滑動瀏覽）`,
    contents: {
      type: "carousel",
      contents: usable.map((o) => bubble(o, usable.length)),
    },
  };
}
