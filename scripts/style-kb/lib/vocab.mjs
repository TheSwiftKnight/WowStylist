// 品類受控詞彙表。
//
// 為什麼要管這個：下游是 vector search + 商品庫查詢，推薦必須是「品類 + 屬性」
// （bomber jacket 配棕色皮革褲），不是一件特定商品。category 若放任 LLM 自由發揮，
// 會跑出 "the perfect little black cardigan" 這種查不到東西的字串。

export const CATEGORY_VOCAB = {
  top: ["tshirt","long_sleeve_tee","tank_top","camisole","blouse","shirt","polo_shirt",
        "sweater","cardigan","hoodie","sweatshirt","knit_vest","vest","bodysuit",
        "corset","crop_top","turtleneck"],
  bottom: ["jeans","trousers","wide_leg_pants","straight_leg_pants","tapered_pants",
           "cargo_pants","leather_pants","track_pants","shorts","mini_skirt","midi_skirt",
           "maxi_skirt","pleated_skirt","denim_skirt","leggings"],
  dress: ["mini_dress","midi_dress","maxi_dress","slip_dress","shirt_dress","knit_dress",
          "jumpsuit"],
  outer: ["blazer","suit_jacket","bomber_jacket","denim_jacket","leather_jacket",
          "trench_coat","wool_coat","overcoat","peacoat","puffer_jacket","parka",
          "shacket","barn_jacket","varsity_jacket","windbreaker","gilet"],
  shoes: ["sneakers","chunky_sneakers","loafers","ballet_flats","mary_janes","ankle_boots",
          "knee_high_boots","cowboy_boots","hiking_boots","heels","kitten_heels","sandals",
          "mules","derby_shoes","clogs"],
  bag: ["tote_bag","shoulder_bag","crossbody_bag","baguette_bag","backpack","clutch",
        "bucket_bag","mini_bag"],
  accessory: ["belt","scarf","hair_ribbon","headband","cap","beanie","bucket_hat",
              "sunglasses","necklace","earrings","tights","socks","gloves","watch","tie"],
};

// 太籠統但還能用的 fallback。收得進 KB，但 report.mjs 會單獨統計，
// 比例太高代表抽取 prompt 要再收緊。
export const GENERIC = new Set(["top","bottom","dress","coat","jacket","pants","skirt","shoes","bag","boots","knitwear"]);

const SYNONYMS = {
  bomber: "bomber_jacket", bombers: "bomber_jacket",
  flats: "ballet_flats", ballet_flat: "ballet_flats", ballet_pumps: "ballet_flats",
  trench: "trench_coat", tee: "tshirt", t_shirt: "tshirt", tshirts: "tshirt",
  jumper: "sweater", pullover: "sweater", knit: "sweater", knits: "sweater",
  denim: "jeans", blue_jeans: "jeans", trouser: "trousers", slacks: "trousers",
  wide_leg_trousers: "wide_leg_pants", wide_leg_jeans: "wide_leg_pants",
  leather_trousers: "leather_pants", cargo_trousers: "cargo_pants",
  puffer: "puffer_jacket", parkas: "parka", overshirt: "shacket",
  barn_coat: "barn_jacket", chore_jacket: "barn_jacket", chore_coat: "barn_jacket",
  loafer: "loafers", sneaker: "sneakers", trainers: "sneakers",
  mary_jane: "mary_janes", boots: "ankle_boots", heeled_boots: "ankle_boots",
  tote: "tote_bag", crossbody: "crossbody_bag", shoulder_bags: "shoulder_bag",
  ribbon: "hair_ribbon", bow: "hair_ribbon", cap_hat: "cap", hat: "cap",
  sunglass: "sunglasses", shades: "sunglasses",
  maxi: "maxi_skirt", midi: "midi_skirt", mini: "mini_skirt",
  waistcoat: "vest", gilets: "gilet", cardi: "cardigan",
};

const ALL = new Set(Object.values(CATEGORY_VOCAB).flat());

/** 回傳 { category, status: "vocab" | "generic" | "oov" } */
export function normalizeCategory(raw, slot) {
  if (!raw) return { category: null, status: "oov" };
  let c = String(raw).toLowerCase().trim()
    .replace(/[\s\-/]+/g, "_")
    .replace(/[^a-z_]/g, "")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "");
  if (SYNONYMS[c]) c = SYNONYMS[c];
  if (ALL.has(c)) return { category: c, status: "vocab" };
  // 去複數再試一次
  const sing = c.replace(/ies$/, "y").replace(/([^s])s$/, "$1");
  if (SYNONYMS[sing]) return { category: SYNONYMS[sing], status: "vocab" };
  if (ALL.has(sing)) return { category: sing, status: "vocab" };
  if (GENERIC.has(c) || GENERIC.has(sing)) return { category: GENERIC.has(c) ? c : sing, status: "generic" };
  return { category: c, status: "oov" };
}

/** 給 prompt 用的詞彙表文字。只列需要的 slot，prompt 越短越快。 */
export function vocabPrompt(slots = Object.keys(CATEGORY_VOCAB)) {
  return slots
    .filter((s) => CATEGORY_VOCAB[s])
    .map((slot) => `  ${slot}: ${CATEGORY_VOCAB[slot].join(", ")}`)
    .join("\n");
}
