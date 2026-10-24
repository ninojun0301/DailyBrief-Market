import type { RawArticle } from "./types";
import { getReportTz, todayKey } from "../utils";

const ENDPOINT = "https://api.anysearch.com/mcp";
const MAX_AGE_MS = 7 * 86_400_000;

const OFFICIAL_HOSTS = [
  "sse.com.cn",
  "szse.cn",
  "csrc.gov.cn",
  "csindex.com.cn",
  "federalreserve.gov",
  "sec.gov",
  "cftc.gov",
  "ecb.europa.eu",
  "bankofengland.co.uk",
];

const MEDIA_HOSTS = [
  "reuters.com",
  "bloomberg.com",
  "wsj.com",
  "ft.com",
  "cnbc.com",
  "bbc.com",
  "economist.com",
  "caixin.com",
  "yicai.com",
  "cls.cn",
  "stcn.com",
  "eastmoney.com",
  "sina.com.cn",
  "jpmorgan.com",
  "coindesk.com",
  "theblock.co",
  "techcrunch.com",
  "theverge.com",
];

const INDUSTRY_HOSTS = [
  "cnfol.com",
  "finance.yahoo.com",
  "investing.com",
  "ssga.com",
  "21shares.com",
  "taiwannews.com.tw",
];

const FOCUS_PATTERN =
  /(工业富联|601138|A股|上证指数|深证成指|沪深股市|黄金|金价|xauusd|美联储|fomc|降息|加息|bitcoin|btc|ethereum|eth|solana|sol|crypto(?:currenc(?:y|ies))?|数字货币|加密货币|稳定币)/i;

const PUBLISHERS: Record<string, string> = {
  "sse.com.cn": "上海证券交易所",
  "szse.cn": "深圳证券交易所",
  "csrc.gov.cn": "中国证监会",
  "csindex.com.cn": "中证指数",
  "federalreserve.gov": "美联储",
  "sec.gov": "美国 SEC",
  "cftc.gov": "美国 CFTC",
  "ecb.europa.eu": "欧洲央行",
  "bankofengland.co.uk": "英国央行",
  "reuters.com": "Reuters",
  "bloomberg.com": "Bloomberg",
  "wsj.com": "WSJ",
  "ft.com": "Financial Times",
  "cnbc.com": "CNBC",
  "bbc.com": "BBC",
  "economist.com": "The Economist",
  "caixin.com": "财新",
  "yicai.com": "第一财经",
  "cls.cn": "财联社",
  "stcn.com": "证券时报",
  "eastmoney.com": "东方财富",
  "sina.com.cn": "新浪财经",
  "jpmorgan.com": "J.P. Morgan",
  "coindesk.com": "CoinDesk",
  "theblock.co": "The Block",
  "techcrunch.com": "TechCrunch",
  "theverge.com": "The Verge",
  "cnfol.com": "中金在线",
  "finance.yahoo.com": "Yahoo Finance",
  "investing.com": "Investing.com",
  "ssga.com": "State Street Global Advisors",
  "21shares.com": "21Shares",
  "taiwannews.com.tw": "Taiwan News",
};

function decodeEntities(value: string): string {
  return value
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)));
}

function clean(value: string): string {
  return decodeEntities(value)
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function hostMatches(host: string, domains: string[]): boolean {
  return domains.some((domain) => host === domain || host.endsWith(`.${domain}`));
}

function publisherFor(host: string): string {
  for (const domain of [...OFFICIAL_HOSTS, ...MEDIA_HOSTS, ...INDUSTRY_HOSTS]) {
    if (host === domain || host.endsWith(`.${domain}`)) {
      return PUBLISHERS[domain] ?? domain;
    }
  }
  return host.replace(/^www\./, "");
}

function parseDate(snippet: string, now: number): Date | undefined {
  const explicit =
    snippet.match(/date:\s*([A-Za-z]{3,9}\s+\d{1,2},\s+\d{4})/i)?.[1] ??
    snippet.match(/Published On\s+(\d{1,2}\s+[A-Za-z]{3,9}\s+\d{4})/i)?.[1] ??
    snippet.match(/(\d{4}-\d{2}-\d{2}(?:\s+\d{2}:\d{2})?)/)?.[1] ??
    snippet.match(/([A-Za-z]{3,9}\s+\d{1,2},\s+\d{4})/)?.[1];
  if (explicit) {
    const parsed = new Date(explicit);
    if (Number.isFinite(parsed.getTime())) return parsed;
  }
  if (/\btoday\b/i.test(snippet)) return new Date(now);
  if (/\byesterday\b/i.test(snippet)) return new Date(now - 86_400_000);
  const relative = snippet.match(/(\d+)\s+(?:day|days)\s+ago/i);
  if (relative) return new Date(now - Number(relative[1]) * 86_400_000);
  const hours = snippet.match(/(\d+)\s+(?:hour|hours)\s+ago/i);
  if (hours) return new Date(now - Number(hours[1]) * 3_600_000);
  return undefined;
}

function parseMcpText(responseText: string): string {
  try {
    const payload = JSON.parse(responseText);
    return (
      payload.result?.content
        ?.filter((item: { type?: string }) => item.type === "text")
        .map((item: { text?: string }) => item.text ?? "")
        .join("\n") ?? ""
    );
  } catch {
    const dataLine = responseText
      .split(/\r?\n/)
      .find((line) => line.startsWith("data:"));
    if (!dataLine) return "";
    const payload = JSON.parse(dataLine.slice(5).trim());
    return (
      payload.result?.content
        ?.filter((item: { type?: string }) => item.type === "text")
        .map((item: { text?: string }) => item.text ?? "")
        .join("\n") ?? ""
    );
  }
}

function parseSearchMarkdown(markdown: string): RawArticle[] {
  const now = Date.now();
  const cutoff = now - MAX_AGE_MS;
  const seen = new Set<string>();
  const matches = [
    ...markdown.matchAll(
      /###\s+\d+\.\s+([^\n]+)\n-\s+\*\*URL\*\*:\s+(\S+)\n-\s+([^\n]+)/g,
    ),
  ];

  const candidates: Array<RawArticle | undefined> = matches.map(
    (match): RawArticle | undefined => {
      const title = clean(match[1]);
      const url = match[2].trim();
      const excerpt = clean(match[3]);
      const publishedAt = parseDate(excerpt, now);
      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        return undefined;
      }
      const host = parsed.hostname.toLowerCase();
      const official = hostMatches(host, OFFICIAL_HOSTS);
      const majorMedia = hostMatches(host, MEDIA_HOSTS);
      const industryMedia = hostMatches(host, INDUSTRY_HOSTS);
      if (!official && !majorMedia && !industryMedia) return undefined;
      if (!FOCUS_PATTERN.test(`${title} ${excerpt}`)) return undefined;
      if (!publishedAt || publishedAt.getTime() < cutoff) return undefined;
      if (publishedAt.getTime() > now + 86_400_000) return undefined;
      if (!official && (parsed.pathname === "/" || parsed.pathname === "")) {
        return undefined;
      }
      const key = `${host}${parsed.pathname.replace(/\/$/, "")}`.toLowerCase();
      if (seen.has(key)) return undefined;
      seen.add(key);
      return {
        sourceId: "anysearch-market",
        title,
        url,
        excerpt,
        publishedAt,
        category: "finance" as const,
        publisher: publisherFor(host),
        meta: official
          ? "AnySearch · 官方来源"
          : majorMedia
            ? "AnySearch · 权威媒体"
            : "AnySearch · 行业媒体",
      };
    },
  );

  return candidates
    .filter((item): item is RawArticle => Boolean(item))
    .sort(
      (a, b) =>
        (b.publishedAt?.getTime() ?? 0) - (a.publishedAt?.getTime() ?? 0),
    )
    .slice(0, 10);
}

export async function fetchAnySearch(sourceId: string): Promise<RawArticle[]> {
  const date = todayKey();
  const queries = [
    `工业富联 601138 A股 ${date}`,
    `A股 市场 行情 ${date} 权威媒体`,
    `黄金 XAUUSD 美联储 ${date} 市场`,
    `Bitcoin Ethereum Solana ${date} 市场 新闻`,
  ];
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    "X-Anysearch-Client": "dailybrief/1.0.0",
  };
  const apiKey = process.env.ANYSEARCH_API_KEY?.trim();
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  const call = async (body: unknown): Promise<string> => {
    const response = await fetch(ENDPOINT, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(45000),
    });
    if (!response.ok) {
      throw new Error(`AnySearch HTTP ${response.status}`);
    }
    return response.text();
  };

  await call({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "dailybrief", version: "1.0.0" },
    },
  });

  const responseText = await call({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: {
      name: "batch_search",
      arguments: {
        queries: queries.map((query) => ({ query, max_results: 6 })),
      },
    },
  });
  const markdown = parseMcpText(responseText);
  const results = parseSearchMarkdown(markdown);
  if (process.env.ANYSEARCH_DEBUG === "1") {
    console.log(`[anysearch] markdown chars=${markdown.length} accepted=${results.length}`);
    console.log(markdown.slice(0, 1500));
  }
  return results.map((item) => ({
    ...item,
    sourceId,
  }));
}
