export type AssetGroup =
  | "us-equity"
  | "crypto"
  | "china-equity"
  | "commodity-fx"
  | "macro";

export interface TickerDef {
  symbol: string;
  displayName: string;
  displayNameEn?: string;
  group: AssetGroup;
}

export function getDisplayName(t: TickerDef, locale: "zh" | "en"): string {
  return locale === "en" ? (t.displayNameEn ?? t.displayName) : t.displayName;
}

const ASSET_GROUP_LABELS_ZH: Record<AssetGroup, string> = {
  "us-equity": "美股 / ETF",
  crypto: "加密货币",
  "china-equity": "A股",
  "commodity-fx": "黄金",
  macro: "宏观信号",
};

const ASSET_GROUP_LABELS_EN: Record<AssetGroup, string> = {
  "us-equity": "US Stocks / ETF",
  crypto: "Crypto",
  "china-equity": "A-share",
  "commodity-fx": "Gold",
  macro: "Macro",
};

export function getAssetGroupLabels(
  locale: "zh" | "en",
): Record<AssetGroup, string> {
  return locale === "en" ? ASSET_GROUP_LABELS_EN : ASSET_GROUP_LABELS_ZH;
}

export const ASSET_GROUP_ORDER: AssetGroup[] = [
  "china-equity",
  "commodity-fx",
  "crypto",
];

export const WATCHLIST: TickerDef[] = [
  {
    symbol: "601138.SS",
    displayName: "工业富联",
    displayNameEn: "Foxconn Industrial Internet",
    group: "china-equity",
  },
  {
    symbol: "XAU-SPOT",
    displayName: "国际现货黄金",
    displayNameEn: "International Spot Gold",
    group: "commodity-fx",
  },
  {
    symbol: "BTC-USD",
    displayName: "Bitcoin",
    group: "crypto",
  },
  {
    symbol: "ETH-USD",
    displayName: "Ethereum",
    group: "crypto",
  },
  {
    symbol: "SOL-USD",
    displayName: "Solana",
    group: "crypto",
  },
];
