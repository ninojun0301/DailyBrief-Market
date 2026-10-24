import type { RawArticle } from "./types";

interface Announcement {
  art_code?: string;
  notice_date?: string;
  title?: string;
  columns?: Array<{ column_name?: string }>;
}

interface AnnouncementResponse {
  success?: boolean;
  data?: {
    list?: Announcement[];
  };
}

const API_URL =
  "https://np-anotice-stock.eastmoney.com/api/security/ann" +
  "?sr=-1&page_size=30&page_index=1&ann_type=A&client_source=web&stock_list=601138";

/**
 * Industrial Fulian's listed-company disclosures. Eastmoney mirrors the
 * issuer's exchange announcements; the generated URL opens the disclosure
 * detail rather than a reposted news article.
 */
export async function fetchFiiAnnouncements(sourceId: string): Promise<RawArticle[]> {
  const response = await fetch(API_URL, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36",
      Accept: "application/json, text/plain, */*",
      Referer: "https://data.eastmoney.com/",
    },
  });
  if (!response.ok) {
    throw new Error(`FII announcement API returned HTTP ${response.status}`);
  }
  const payload = (await response.json()) as AnnouncementResponse;
  const items = payload.data?.list;
  if (!payload.success || !Array.isArray(items)) {
    throw new Error("FII announcement API returned an invalid payload");
  }

  return items
    .filter((item) => item.art_code && item.title)
    .map((item) => {
      const columns = (item.columns ?? [])
        .map((column) => column.column_name)
        .filter(Boolean)
        .join("、");
      return {
        sourceId,
        title: item.title!.trim(),
        url: `https://data.eastmoney.com/notices/detail/601138/${item.art_code}.html`,
        excerpt: columns ? `公告类型：${columns}` : "工业富联上市公司公告",
        publishedAt: item.notice_date ? new Date(item.notice_date) : undefined,
        category: "finance" as const,
        summary: columns ? `公司披露公告，类型：${columns}。` : "公司披露公告。",
      };
    });
}
