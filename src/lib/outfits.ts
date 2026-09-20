// 把「一列 = 一件衣服」的 fashion_items 收攏成畫面上的階層：
//
//   貼文（shortcode）→ 一套（同一張輪播圖 / 同一秒）→ 單品（top / pants）
//
// pipeline 把這個階層編在 source_item_id 裡（見 pipeline.py 的 build_source_item_id）：
//   post: <shortcode>_p<第幾張圖>_<第幾件>_<category>
//   reel: <shortcode>_t<第幾秒>_<第幾件>_<category>
//
// 中間那段（p0 / t6.0）就是「這是同一套」的標記。

import type { Garment } from "@/lib/garments";

/** 同一張輪播圖（或 reel 的同一秒）裡辨識出來的一整套。 */
export type Outfit = {
  /** 分組用的標記，例如 "p0"、"t6.0" */
  key: string;
  /** 排序用的數字；p0 → 0、t6.0 → 6 */
  order: number;
  garments: Garment[];
};

/** 一則貼文 = 板子上的一張卡片。 */
export type PostGroup = {
  /** React key，也是這組的識別：shortcode，沒有的話退回 g<id> */
  key: string;
  shortcode: string | null;
  instagramUrl: string | null;
  instagramType: string | null;
  /** 這則貼文裡最新那件的建立時間（ISO），排序用 */
  createdAt: string;
  outfits: Outfit[];
  /** 這則貼文總共幾件單品 */
  garmentCount: number;
  /** 封面：第一件有圖的單品，全部沒圖就拿第一件 */
  cover: Garment;
};

/**
 * 從 source_item_id 尾端往回拆出「同一套」的標記。
 *
 * 從尾端拆是故意的 —— IG 的 shortcode 本身就可能含底線
 * （字元集是 [A-Za-z0-9_-]），從頭拆會在那種 shortcode 上拆錯。
 * 尾端三段固定是 <marker>_<第幾件>_<category>，category 不含底線。
 */
function outfitMarker(garment: Garment): string | null {
  const parts = garment.sourceItemId?.split("_") ?? [];
  if (parts.length < 4) return null;

  const marker = parts[parts.length - 3];
  return /^[pt]/.test(marker) ? marker : null;
}

/** "p12" → 12、"t6.0" → 6。拆不出來的丟到最後面。 */
function markerOrder(marker: string): number {
  const n = Number.parseFloat(marker.slice(1));
  return Number.isFinite(n) ? n : Number.MAX_SAFE_INTEGER;
}

/**
 * 依貼文分組，組內再依「同一套」分頁。
 *
 * 進來的順序（listGarments 是 created_at DESC）決定卡片順序，
 * 卡片內部則一律照 p0 → p1 → p2 的原始輪播順序，比較好讀。
 */
export function groupByPost(garments: Garment[]): PostGroup[] {
  const groups = new Map<string, PostGroup>();

  for (const garment of garments) {
    // 沒有 shortcode 的（例如商品）各自成一組，不會被併在一起
    const key = garment.shortcode ?? `g${garment.id}`;

    let group = groups.get(key);
    if (!group) {
      group = {
        key,
        shortcode: garment.shortcode,
        instagramUrl: garment.instagramUrl,
        instagramType: garment.instagramType,
        createdAt: garment.createdAt,
        outfits: [],
        garmentCount: 0,
        cover: garment,
      };
      groups.set(key, group);
    }

    // 同一則貼文裡，標記一樣的算同一套；拆不出標記就自己一套
    const marker = outfitMarker(garment) ?? `solo-${garment.id}`;

    let outfit = group.outfits.find((o) => o.key === marker);
    if (!outfit) {
      outfit = { key: marker, order: markerOrder(marker), garments: [] };
      group.outfits.push(outfit);
    }
    outfit.garments.push(garment);

    group.garmentCount += 1;
    if (garment.createdAt > group.createdAt) group.createdAt = garment.createdAt;
    if (!group.cover.hasImage && garment.hasImage) group.cover = garment;
  }

  for (const group of groups.values()) {
    group.outfits.sort((a, b) => a.order - b.order || a.key.localeCompare(b.key));
    // 一套之內先上衣後褲子，讀起來跟穿的順序一致
    for (const outfit of group.outfits) {
      outfit.garments.sort(
        (a, b) =>
          Number(a.category === "pants") - Number(b.category === "pants") ||
          a.id - b.id
      );
    }
  }

  return [...groups.values()];
}

/** 一套的顯示名稱：把裡面單品的 display_tags 併起來當標題。 */
export function outfitName(outfit: Outfit, fallbackIndex: number): string {
  const tags = outfit.garments.flatMap((g) => g.displayTags);
  const unique = [...new Set(tags)];
  if (unique.length > 0) return unique.slice(0, 3).join(" ");
  return `第 ${fallbackIndex + 1} 套`;
}

/**
 * 一套裡要顯示哪幾張圖。
 *
 * pipeline 對同一套的每件單品存的是「同一張原始輪播圖」——
 * build_instagram_item 直接讀 garment["image_path"]，沒有各自裁切，
 * 所以 top / pants 兩列的 image_data 是一模一樣的 bytes
 * （實測 32 列 → 17 張圖，剛好一套一張）。
 * 重複貼兩張一樣的圖沒意義，只留第一張。
 *
 * 去重的 key 取「這一套」= 這張圖。哪天 pipeline 改成每件各自裁切，
 * 把 key 換成 image 的 hash（SELECT 加 md5(image_data)）就會自動分開。
 */
export function outfitImages(outfit: Outfit): Garment[] {
  const seen = new Set<string>();
  const images: Garment[] = [];

  for (const garment of outfit.garments) {
    if (!garment.hasImage) continue;
    const key = outfit.key;
    if (seen.has(key)) continue;
    seen.add(key);
    images.push(garment);
  }

  return images;
}
