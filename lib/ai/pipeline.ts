import { jsonrepair } from "jsonrepair";
import { runLlm } from "./llm";
import { extractJson } from "./json-util";
import { SYSTEM_PROMPT_DIGEST_EN, SYSTEM_PROMPT_DIGEST_ZH } from "./prompts";
import { REPORT_LOCALE } from "../sources/registry";
import type { Category, RawArticle } from "../sources/types";

const SYSTEM_PROMPT_DIGEST =
  REPORT_LOCALE === "en" ? SYSTEM_PROMPT_DIGEST_EN : SYSTEM_PROMPT_DIGEST_ZH;

export interface BriefItem {
  title: string;
  url: string;
  source: string;
  summary: string;
  importance: number;
}

export interface DailyReport {
  hero_headline: string;
  daily_overview: string;
  tech_briefs: BriefItem[];
  finance_briefs: BriefItem[];
  politics_briefs: BriefItem[];
  editor_note: string;
  keywords: string[];
  /** Optional trading-signals section, present when scripts/daily.ts ran successfully. */
  trading?: TradingSection;
}

import type { TickerAnalysis } from "../trading/signals";
import type { CryptoGlobalStats } from "../trading/coingecko";
import type { FearGreedSnapshot } from "../trading/fear-greed";
import type { TradingCommentary } from "./trading-commentary";

export interface TradingSection extends TradingCommentary {
  generated_at: string;
  tickers: TickerAnalysis[];
  crypto_fear_greed?: FearGreedSnapshot;
  crypto_global?: CryptoGlobalStats;
}

export interface ArticleInput extends RawArticle {
  source: string;
}

const PER_CATEGORY_LIMIT: Record<Category, number> = {
  tech: 25,
  finance: 20,
  politics: 15,
};

const MAX_AGE_DAYS = 14;

const SOURCE_PRIORITY: Record<string, number> = {
  "fii-announcements": 110,
  "federal-reserve-monetary": 100,
  "sec-press": 100,
  "cftc-press": 100,
  "ecb-press": 100,
  "boe-news": 100,
  "anysearch-market": 92,
  "bloomberg-markets": 80,
  "wsj-markets": 80,
  "ft-companies": 80,
  "economist-finance": 75,
  "bbc-business": 70,
  "reuters": 85,
};

const OFFICIAL_SOURCE_IDS = new Set([
  "fii-announcements",
  "federal-reserve-monetary",
  "sec-press",
  "cftc-press",
  "ecb-press",
  "boe-news",
]);

function sourceTier(sourceId: string): "official" | "major-media" | "community" | "other" {
  if (OFFICIAL_SOURCE_IDS.has(sourceId)) return "official";
  if (sourceId === "v2ex-hot" || sourceId === "linuxdo" || sourceId === "reddit-stocks") {
    return "community";
  }
  if ((SOURCE_PRIORITY[sourceId] ?? 0) >= 70) return "major-media";
  return "other";
}

const FOCUS_PATTERNS: RegExp[] = [
  /\b(?:industrial fulian|foxconn|fii|ingrasys)\b/i,
  /\bA[- ]?shares?\b/i,
  /\b601138\b/,
  /\b(?:ai server|server rack|data center|liquid cooling)\b/i,
  /\b(?:gold|xauusd|bullion|precious metals?|gold etf)\b/i,
  /\b(?:bitcoin|btc|ethereum|eth|solana|sol|crypto(?:currenc(?:y|ies))?|digital assets?|stablecoins?)\b/i,
  /\b(?:federal reserve|fomc|interest rates?|rate decision|inflation|cpi|monetary policy)\b/i,
];

const FOCUS_TERMS_ZH = [
  "工业富联",
  "A股",
  "上证指数",
  "深证成指",
  "沪深股市",
  "富士康",
  "鸿佰",
  "601138",
  "AI服务器",
  "服务器机柜",
  "数据中心",
  "液冷",
  "黄金",
  "贵金属",
  "比特币",
  "以太坊",
  "索拉纳",
  "加密货币",
  "虚拟货币",
  "数字货币",
  "稳定币",
  "美联储",
  "利率决议",
  "通胀",
  "货币政策",
];

export function articleFocusScore(article: ArticleInput): number {
  const text = `${article.title} ${article.excerpt ?? ""}`;
  let score = 0;
  if (FOCUS_PATTERNS.some((pattern) => pattern.test(text))) score += 10;
  if (FOCUS_TERMS_ZH.some((term) => text.includes(term))) score += 10;
  if (sourceTier(article.sourceId) === "official") score += 3;
  return score;
}

/**
 * Keep only items materially related to Industrial Fulian, gold, BTC, ETH,
 * or SOL. Market data remains available even when no relevant article exists.
 */
export function filterFocusedArticles(articles: ArticleInput[]): ArticleInput[] {
  return articles.filter((article) => articleFocusScore(article) > 0);
}

/**
 * Pick `limit` items from `items` so every source gets a fair shot.
 *
 * Why this exists: the previous `slice(0, limit)` honored insertion order,
 * which is the source-iteration order in daily.ts. That gave whichever
 * source came first 100% of the quota — e.g. all 25 tech slots filled by
 * Hacker News before GitHub Trending / Solidot / V2EX / 阮一峰 got a turn.
 *
 * Strategy: drop items older than MAX_AGE_DAYS, group by sourceId,
 * sort each bucket newest-first, then round-robin one item per source
 * until we hit the limit. Sources with fewer items naturally drop out
 * and others absorb the slack.
 */
function selectRoundRobin(
  items: ArticleInput[],
  limit: number,
): ArticleInput[] {
  const cutoff = Date.now() - MAX_AGE_DAYS * 86_400_000;
  const fresh = items.filter(
    (it) => !it.publishedAt || it.publishedAt.getTime() >= cutoff,
  );

  const bySource = new Map<string, ArticleInput[]>();
  for (const it of fresh) {
    const arr = bySource.get(it.sourceId) ?? [];
    arr.push(it);
    bySource.set(it.sourceId, arr);
  }
  for (const arr of bySource.values()) {
    arr.sort(
      (a, b) =>
        (b.publishedAt?.getTime() ?? 0) - (a.publishedAt?.getTime() ?? 0),
    );
  }

  const buckets = Array.from(bySource.entries())
    .sort(([a], [b]) => (SOURCE_PRIORITY[b] ?? 50) - (SOURCE_PRIORITY[a] ?? 50))
    .map(([, items]) => items);
  const out: ArticleInput[] = [];
  let madeProgress = true;
  while (out.length < limit && madeProgress) {
    madeProgress = false;
    for (const b of buckets) {
      if (b.length === 0) continue;
      out.push(b.shift()!);
      madeProgress = true;
      if (out.length >= limit) break;
    }
  }
  return out;
}

function hasStaleExplicitPrice(
  article: ArticleInput,
  marketContext?: TradingSection | null,
): boolean {
  if (!marketContext || !article.publishedAt) return false;
  if (Date.now() - article.publishedAt.getTime() < 86_400_000) return false;
  const text = `${article.title} ${article.excerpt ?? ""}`;
  if (
    !/(站上|突破|跌破|报|现价|上涨|下跌|current|tops?|drops?|rises?|falls?|hits?|above|below)/i.test(
      text,
    )
  ) {
    return false;
  }
  const numbers = [
    ...text.matchAll(
      /(?:\$|USD\s*)?(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d{2,5}(?:\.\d+)?)/gi,
    ),
  ]
    .map((match) => Number(match[1].replace(/,/g, "")))
    .filter((value) => Number.isFinite(value) && value > 0);

  return marketContext.tickers.some((ticker) => {
    const relevant =
      (ticker.symbol === "XAU-SPOT" && /gold|黄金|xau/i.test(text)) ||
      (ticker.symbol === "BTC-USD" && /\bBTC\b|bitcoin|比特币/i.test(text)) ||
      (ticker.symbol === "ETH-USD" && /\bETH\b|ethereum|以太坊/i.test(text)) ||
      (ticker.symbol === "SOL-USD" && /\bSOL\b|solana|索拉纳/i.test(text)) ||
      (ticker.symbol === "601138.SS" && /601138|工业富联|foxconn/i.test(text));
    if (!relevant || !Number.isFinite(ticker.currentPrice)) return false;
    return numbers.some((price) => {
      const ratio = price / ticker.currentPrice;
      return (
        ratio >= 0.5 &&
        ratio <= 1.5 &&
        Math.abs(price - ticker.currentPrice) / ticker.currentPrice > 0.015
      );
    });
  });
}

async function callOnce(
  userPayloadJson: string,
  marketContextJson: string,
): Promise<DailyReport> {
  // Claude Code CLI's built-in system prompt biases the model toward
  // conversational markdown output. Anchor the format expectation in the
  // user message (instruction recency wins) *and* explicitly demand every
  // schema field be populated — without this Sonnet has been observed to
  // emit a JSON shell with empty arrays to "satisfy" a JSON-only ask.
  const userPrompt =
    REPORT_LOCALE === "en"
      ? [
          "**Output language: ENGLISH ONLY.** Every string value in the JSON — hero_headline, daily_overview, every brief's title/summary, editor_note, keywords — must be written entirely in English. No Chinese characters anywhere.",
          "",
          "Your task: generate today's daily brief from the candidate news below. **The response MUST be a single valid JSON object** — starts with `{`, ends with `}`, no markdown, no code fences, no explanations.",
          "",
          "The JSON must contain every field; briefs arrays may be empty when there are no highly relevant, authoritative items:",
          "  - hero_headline: 10-25 word headline of the day",
          "  - daily_overview: **150-250 word** paragraph covering tech / finance / politics signals so a reader sees the whole picture at a glance",
          "  - tech_briefs: **0-3** relevant tech BriefItems",
          "  - finance_briefs: **0-5** relevant finance BriefItems",
          "  - politics_briefs: **0-2** directly relevant politics BriefItems",
          "  - editor_note: 30-60 word editor's note",
          "  - keywords: 5-8 keywords",
          "",
          "BriefItem fields: title, url (copied verbatim from candidate), source, summary, importance (1-10).",
          "**Quote rule (important!)**: For any quotation INSIDE a JSON string, use single quotes ' or curly quotes '\" — **never** raw double quotes \", which break JSON parsing.",
          "No trailing commas.",
          "",
          "Authoritative current-market snapshot (prices and generated_at):",
          marketContextJson,
          "",
          "Market consistency rules:",
          "- Current prices in the market snapshot override every price mentioned in candidate articles.",
          "- Never describe an article's historical price as the current price or say the asset is currently above/below it when the snapshot differs materially.",
          "- If a candidate contains an older price that conflicts with the snapshot, either omit it or explicitly label it as historical with its publication date.",
          "- The hero headline must agree with the current-market snapshot.",
          "",
          `Candidate news (JSON array, ${userPayloadJson.length} chars):`,
          userPayloadJson,
        ].join("\n")
      : [
          "你的任务：根据下方候选新闻，生成一份当日简报，**响应必须是一个合法 JSON 对象**——以 `{` 开头，以 `}` 结尾，不要 markdown / 不要代码围栏 / 不要任何解释。",
          "",
          "JSON 必须包含全部字段；若没有高度相关且有价值的条目，tech_briefs / finance_briefs / politics_briefs 可以返回空数组，不要填充无关新闻：",
          "  - hero_headline: 10-25 字的当日一句话头条",
          "  - daily_overview: **150-220 字** 的当日总览段落，一段话覆盖技术 / 财经 / 时政 的核心信号，让读者一眼抓住全貌",
          "  - tech_briefs: **0-3 条** 与工业富联或 AI 服务器供应链直接相关的 BriefItem",
          "  - finance_briefs: **0-5 条** 与工业富联、黄金、BTC、ETH、SOL 高度相关的 BriefItem",
          "  - politics_briefs: **0-2 条** 直接影响这些资产的政策或地缘事件",
          "  - editor_note: 30-60 字的编辑短评",
          "  - keywords: 5-8 个关键词",
          "",
          "BriefItem 字段：title、url（必须从候选条目原样选取）、source、summary、importance(1-10)。",
          "**引号规则（重要！）**：JSON 字符串内的中文引用请使用**中文全角引号**「」或者 “”，**绝对不要**用英文双引号 \" —— 那会导致 JSON 解析失败。例：写 商务部回应「内卷」 而不是 商务部回应\"内卷\"。",
          "不要使用单引号、不要末尾多余逗号。",
          "",
          "权威实时行情快照（当前价格与生成时间）：",
          marketContextJson,
          "",
          "行情一致性规则：",
          "- 当前价格必须以行情快照为准，候选新闻中的价格不能覆盖快照。",
          "- 不得把旧新闻中的历史价格写成“现价、站上、突破、仍处于”等当前状态；若与快照明显冲突，应删除或注明历史日期。",
          "- 头条必须与实时行情快照一致。",
          "",
          "候选新闻（JSON 数组，共 " + userPayloadJson.length + " 字符）：",
          userPayloadJson,
        ].join("\n");
  const { text } = await runLlm({
    systemPrompt: SYSTEM_PROMPT_DIGEST,
    userPrompt,
  });
  const cleaned = extractJson(text);
  let parsed: Partial<DailyReport>;
  try {
    parsed = JSON.parse(cleaned) as Partial<DailyReport>;
  } catch (strictErr) {
    // LLMs routinely emit JSON with unescaped quotes inside Chinese
    // strings (e.g. 商务部回应"内卷"). jsonrepair fixes most of these
    // mechanically before we ever surface a failure.
    try {
      const repaired = jsonrepair(cleaned);
      parsed = JSON.parse(repaired) as Partial<DailyReport>;
      console.warn("[pipeline] JSON.parse failed but jsonrepair recovered");
    } catch {
      try {
        const fs = await import("node:fs");
        fs.mkdirSync("logs", { recursive: true });
        const ts = new Date().toISOString().replace(/[:.]/g, "-");
        fs.writeFileSync(`logs/claude-raw-${ts}.txt`, text, "utf8");
        fs.writeFileSync(`logs/claude-cleaned-${ts}.txt`, cleaned, "utf8");
        console.warn(
          `[pipeline] both JSON.parse and jsonrepair failed; raw at logs/claude-raw-${ts}.txt`,
        );
      } catch {
        // best-effort logging
      }
      throw strictErr;
    }
  }
  return {
    hero_headline: parsed.hero_headline ?? "",
    daily_overview: parsed.daily_overview ?? "",
    tech_briefs: parsed.tech_briefs ?? [],
    finance_briefs: parsed.finance_briefs ?? [],
    politics_briefs: parsed.politics_briefs ?? [],
    editor_note: parsed.editor_note ?? "",
    keywords: parsed.keywords ?? [],
  };
}

export async function generateDailyReport(
  articles: ArticleInput[],
  marketContext?: TradingSection | null,
): Promise<{ report: DailyReport; tokensUsed: number }> {
  const focusedArticles = filterFocusedArticles(articles);
  const grouped: Record<Category, ArticleInput[]> = {
    tech: [],
    finance: [],
    politics: [],
  };
  for (const a of focusedArticles) grouped[a.category].push(a);

  const compact = (Object.keys(grouped) as Category[]).flatMap((c) =>
    selectRoundRobin(grouped[c], PER_CATEGORY_LIMIT[c]),
  );
  const freshCompact = compact.filter(
    (article) => !hasStaleExplicitPrice(article, marketContext),
  );
  if (freshCompact.length !== compact.length) {
    console.log(
      `[daily] removed ${compact.length - freshCompact.length} stale price claim(s) before digest`,
    );
  }

  if (freshCompact.length === 0) {
    return {
      report: {
        hero_headline: "工业富联、黄金与加密市场日报",
        daily_overview:
          "今日未抓取到与工业富联、黄金、BTC、ETH 或 SOL 直接相关的新增权威资讯；行情与技术指标仍可在市场行情栏目查看。",
        tech_briefs: [],
        finance_briefs: [],
        politics_briefs: [],
        editor_note: "本期只保留与目标标的高度相关且可核验的信息。",
        keywords: ["工业富联", "黄金", "BTC", "ETH", "SOL"],
      },
      tokensUsed: 0,
    };
  }

  const userPayload = freshCompact.map((a, i) => ({
    n: i + 1,
    title: a.title,
    url: a.url,
    source: a.source,
    category: a.category,
    source_tier: sourceTier(a.sourceId),
    excerpt: (a.excerpt ?? "").slice(0, 200),
    published: a.publishedAt?.toISOString() ?? "",
  }));
  const userPayloadJson = JSON.stringify(userPayload);
  const marketContextJson = JSON.stringify(
    marketContext
      ? {
          generated_at: marketContext.generated_at,
          tickers: marketContext.tickers.map((ticker) => ({
            symbol: ticker.symbol,
            displayName: ticker.displayName,
            currentPrice: ticker.currentPrice,
            currency: ticker.currency,
            pct1Day: ticker.pct1Day,
            pct5Day: ticker.pct5Day,
          })),
        }
      : {},
  );

  let report: DailyReport;
  try {
    report = await callOnce(userPayloadJson, marketContextJson);
  } catch (firstErr) {
    // One retry — claude CLI occasionally wraps in narration on the first
    // pass but obeys when the same prompt is repeated.
    console.warn(
      `[pipeline] first claude CLI call failed, retrying: ${
        firstErr instanceof Error ? firstErr.message : String(firstErr)
      }`,
    );
    report = await callOnce(userPayloadJson, marketContextJson);
  }

  // Max subscription has no per-call token meter — we expose 0 for schema
  // compatibility; consumers should treat 0 as "metric not available".
  return { report, tokensUsed: 0 };
}
