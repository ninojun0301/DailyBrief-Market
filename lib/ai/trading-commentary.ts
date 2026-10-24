import { jsonrepair } from "jsonrepair";
import { runLlm } from "./llm";
import { extractJson } from "./json-util";
import { REPORT_LOCALE } from "../sources/registry";
import type { CryptoGlobalStats } from "../trading/coingecko";
import type { FearGreedSnapshot } from "../trading/fear-greed";
import type { TickerAnalysis } from "../trading/signals";

export interface WatchlistPick {
  symbol: string;
  display_name: string;
  /**
   * Direction label of the current technical setup (NOT a price prediction).
   * Original "看多/看空" wording occasionally tripped Sonnet's "no investment
   * advice" guardrail into returning an empty array; the neutral technical
   * vocabulary "偏上行/偏下行/中性" (and "Bullish/Bearish/Neutral" for en
   * mode) avoids the trigger. Legacy values are kept for backwards-compat.
   */
  stance:
    | "偏上行"
    | "偏下行"
    | "中性"
    | "看多"
    | "看空"
    | "Bullish"
    | "Bearish"
    | "Neutral";
  rationale: string;
}

export interface ActionAssessment {
  dip_buying: "不适合抄底" | "仅小仓试探" | "可分批关注";
  selling: "暂不卖出" | "部分减仓" | "优先控制风险";
  summary: string;
}

export interface TradingCommentary {
  daily_view: string;
  action_assessment: ActionAssessment;
  market_overview: string;
  watchlist: WatchlistPick[];
  risk_caveat: string;
}

export interface TradingCommentaryInput {
  tickers: TickerAnalysis[];
  cryptoFearGreed?: FearGreedSnapshot;
  cryptoGlobal?: CryptoGlobalStats;
  focusedNews?: Array<{
    title: string;
    source: string;
    summary?: string;
  }>;
}

const SYSTEM_PROMPT_ZH = `你是一名专业、克制、中性的中文市场分析员。你的任务是把公开行情指标与当日权威资讯结合，写一份**条件式的市场与风险判断报告**。你不提供个性化投顾服务，也不承诺或确定预测涨跌，但必须基于证据明确回答「是否适合抄底」和「已有仓位是否需要减仓」。

**严格规则**：
1. 使用专业术语描述指标读数：金叉/死叉/MACD 红柱/绿柱/超买/超卖/突破/支撑/动量/趋势/背离 等。
2. 所有结论必须**基于输入的实际数字**（价格、SMA、RSI、MACD、信号、近期 % 变化等），不允许凭空概括。
3. watchlist 必须**为输入中的每一个标的分別输出一条记录**，stance 必须反映真实技术面，不得为了平衡而伪造方向。
4. market_overview 只覆盖三个重点：工业富联、国际现货黄金、加密（BTC / ETH / SOL）。
5. risk_caveat 必须包含「过去走势不代表未来表现」与「仅供技术指标解读参考」的明确声明。
6. daily_view 是你对当日行情的专业结论，控制在 40-80 字：先给偏强/偏弱/震荡判断，再点明最关键矛盾与接下来需要验证的信号，语言精炼，不写目标价，不构成投资建议。
7. action_assessment 必须直接回答两个问题：一是「现在是否适合抄底」，二是「已有仓位是否需要卖出/减仓」。判断要同时引用当日新闻、价格相对均线、RSI/MACD 与关键价位，并给出具体的验证或失效条件；必须区分空仓者与已有仓位者，并在 summary 中点名工业富联、黄金、BTC、ETH、SOL 之间的关键差异，不能只给笼统结论。

输入：JSON 数组，每个元素是某 ticker 的技术分析对象，字段包括 symbol、displayName、group、currentPrice、pct1Day、pct5Day、pct52WeekHigh、pct52WeekLow、sma20/sma50/sma200、rsi14、macd/macdSignal/macdHistogram、trend、rsiState、signals。

输出严格 JSON 对象（不要 markdown、不要任何前后缀），所有字段都**必填且非空**：
{
  "daily_view": "<40-80 字专业且精炼的当日行情观点>",
  "action_assessment": {
    "dip_buying": "不适合抄底" | "仅小仓试探" | "可分批关注",
    "selling": "暂不卖出" | "部分减仓" | "优先控制风险",
    "summary": "<80-180 字，点名目标标的，明确空仓与已有仓位分别怎么做、触发条件和风险点>"
  },
  "market_overview": "<300-400 字段落，不能省略>",
  "watchlist": [
    { "symbol": "<必须从输入精确复制>", "display_name": "<中文+(英文代码) 或 仅中文>", "stance": "偏上行" | "偏下行" | "中性", "rationale": "<80-150 字，必须引用具体技术指标数字>" },
    ...
  ],
  "risk_caveat": "<60-100 字，必须包含「过去走势不代表未来表现」与「仅供技术指标解读参考」>"
}

**关于 watchlist（这是历史上最容易出错的字段，请严格执行）**：
- watchlist **必须正好包含输入中的全部 5 个 ticker，每个 symbol 恰好一次**。
- 少任何一个 ticker 都是**输出格式错误**，下游会自动拒绝并重新调用你，浪费一次配额。
- "stance" 是当前技术 setup 的方向标签——纯描述、纯客观——不是涨跌预测，不是行动建议。你只是在说"这只标的当前的指标状态偏上行 / 偏下行 / 中性"。
- 工业富联、黄金、BTC、ETH、SOL 都是用户明确要求跟踪的对象，不能省略；行情平静时也应逐项如实描述并标注「中性」。
- 任何情况下**禁止返回空数组**。空 watchlist 不是更安全的选择，它就是错的。

**引号规则（重要！）**：JSON 字符串内的中文引用一律使用全角引号「」或""，**绝不**使用英文双引号——否则 JSON 解析失败。

**输出顺序建议**：先给出 daily_view 和 action_assessment，再生成 watchlist，最后生成 market_overview 与 risk_caveat。`;

const SYSTEM_PROMPT_EN = `You are a professional, restrained market analyst. Combine computed market indicators with the supplied authoritative news to produce a **conditional market and risk assessment**. You do not provide personalized advisory services or claim certainty, but you must answer whether dip-buying is appropriate and whether an existing position should be reduced.

**Strict rules**:
1. Use technical terminology to describe readings: golden-cross / death-cross / MACD bullish/bearish histogram / overbought / oversold / breakout / support / momentum / trend / divergence, etc.
2. Every conclusion MUST be **grounded in actual input numbers** (price, SMA, RSI, MACD, signals, recent % moves) — no generalizing without data.
3. The watchlist MUST include **every supplied ticker exactly once**, with stances reflecting the real technical setup rather than forced balance.
4. market_overview must cover only the three focus areas: Industrial Fulian, international spot gold, and crypto (BTC / ETH / SOL).
5. risk_caveat MUST explicitly include "past performance does not guarantee future results" and "for technical-indicator interpretation only".
6. daily_view is your concise professional conclusion in 40-80 words: state the current bullish/bearish/range-bound setup, the key tension, and the next confirming signal. No price target and no investment advice.
7. action_assessment must answer two questions directly: whether dip-buying is appropriate now, and whether existing positions need selling/reduction. Use the supplied news, moving averages, RSI/MACD, and key price levels; give explicit confirmation and invalidation conditions, distinguish a new entry from an existing position, and name the key differences among Industrial Fulian, gold, BTC, ETH, and SOL.

Input: a JSON array of ticker analysis objects with fields symbol, displayName, group, currentPrice, pct1Day, pct5Day, pct52WeekHigh, pct52WeekLow, sma20/sma50/sma200, rsi14, macd/macdSignal/macdHistogram, trend, rsiState, signals.

Output STRICTLY a JSON object (no markdown, no prefix/suffix). All fields must be **populated and non-empty**:
{
  "daily_view": "<40-80 word concise professional market view>",
  "action_assessment": {
    "dip_buying": "avoid dip-buying" | "small probe only" | "staged entry acceptable",
    "selling": "hold" | "reduce partially" | "prioritize risk control",
    "summary": "<80-180 words naming the focus assets and covering new entries, existing positions, triggers and risks>"
  },
  "market_overview": "<300-400 word paragraph; do not skip>",
  "watchlist": [
    { "symbol": "<copied exactly from input>", "display_name": "<readable name>", "stance": "Bullish" | "Bearish" | "Neutral", "rationale": "<80-150 words; must cite specific indicator numbers>" },
    ...
  ],
  "risk_caveat": "<60-100 words; must include 'past performance does not guarantee future results' and 'for technical-indicator interpretation only'>"
}

**About watchlist (historically the most error-prone field — execute strictly)**:
- watchlist MUST contain **all five supplied tickers, each symbol exactly once**.
- Omitting any ticker is **a format error** — downstream auto-rejects and re-invokes you, wasting a quota call.
- "stance" is a label for the **current technical setup** — pure description, pure observation — not a price prediction or an action recommendation. You are merely saying "this ticker's current indicator state is Bullish / Bearish / Neutral".
- Industrial Fulian, spot gold, BTC, ETH, and SOL are explicit user requirements and may not be omitted. Describe all five even when the market is quiet.
- Under no circumstances may you return an empty array. An empty watchlist is not the safer choice — it is wrong.

**Quote rule (important!)**: For any quotation INSIDE a JSON string, use single quotes ' or curly quotes '" — **never** raw double-quotes, which break JSON parsing.

**Output-order suggestion**: produce daily_view and action_assessment first, then watchlist, then market_overview and risk_caveat.`;

const SYSTEM_PROMPT =
  REPORT_LOCALE === "en" ? SYSTEM_PROMPT_EN : SYSTEM_PROMPT_ZH;

export async function generateTradingCommentary(
  input: TradingCommentaryInput,
): Promise<TradingCommentary> {
  const { tickers, cryptoFearGreed, cryptoGlobal, focusedNews = [] } = input;
  // Slim payload — drop fields that don't help the model (no need to send
  // exchangeName/currency etc. — those are display-only)
  const payload = tickers.map((a) => ({
    symbol: a.symbol,
    displayName: a.displayName,
    group: a.group,
    currentPrice: round(a.currentPrice),
    pct1Day: round(a.pct1Day, 2),
    pct5Day: round(a.pct5Day, 2),
    pct52WeekHigh: round(a.pct52WeekHigh, 2),
    pct52WeekLow: round(a.pct52WeekLow, 2),
    sma20: roundNullable(a.sma20),
    sma50: roundNullable(a.sma50),
    sma200: roundNullable(a.sma200),
    rsi14: roundNullable(a.rsi14, 1),
    macd: roundNullable(a.macd, 4),
    macdSignal: roundNullable(a.macdSignal, 4),
    trend: a.trend,
    rsiState: a.rsiState,
    signals: a.signals.map((s) => s.label),
  }));

  // Compact context sidecars — the model should weave these into the
  // market_overview when relevant (e.g. "VIX 14 + DXY weakening + crypto
  // F&G 43 → risk-on lite").
  const contextLines: string[] = [];
  if (cryptoFearGreed) {
    const classification =
      REPORT_LOCALE === "en"
        ? cryptoFearGreed.classification
        : cryptoFearGreed.classificationCn;
    const label =
      REPORT_LOCALE === "en"
        ? `Crypto Fear & Greed Index = ${cryptoFearGreed.value} (${classification})`
        : `加密恐慌贪婪指数 = ${cryptoFearGreed.value}（${classification}）`;
    contextLines.push(label);
  }
  if (cryptoGlobal) {
    const label =
      REPORT_LOCALE === "en"
        ? `Crypto total market cap = ${(cryptoGlobal.totalMarketCapUsd / 1e12).toFixed(2)}T USD (24h ${round(cryptoGlobal.marketCapChangePct24h, 2)}%) · BTC dominance ${round(cryptoGlobal.btcDominance, 1)}% · ETH ${round(cryptoGlobal.ethDominance, 1)}%`
        : `加密总市值 = ${(cryptoGlobal.totalMarketCapUsd / 1e12).toFixed(2)}T USD (24h ${round(cryptoGlobal.marketCapChangePct24h, 2)}%) · BTC 主导率 ${round(cryptoGlobal.btcDominance, 1)}% · ETH ${round(cryptoGlobal.ethDominance, 1)}%`;
    contextLines.push(label);
  }

  const newsPayload = focusedNews.slice(0, 10).map((item) => ({
    title: item.title,
    source: item.source,
    summary: (item.summary ?? "").slice(0, 180),
  }));

  // user prompt header = highest instruction-recency precedence. The
  // SYSTEM_PROMPT requires every supplied focus ticker. Restating the
  // system prompt that constraint sometimes loses to the RLHF "no
  // investment advice" reflex; restating it at the top of the user
  // prompt materially improves hit rate (see lesson #8).
  const userPrompt =
    REPORT_LOCALE === "en"
      ? [
          `**Output language: ENGLISH ONLY.** Every string value in the JSON — market_overview, every pick's display_name and rationale, risk_caveat — MUST be written entirely in English. Do not use any Chinese characters anywhere in the output. Even if some input ticker names appear in Chinese (e.g. "黄金期货"), translate them to English in the display_name field (e.g. "Gold Futures").`,
          "",
          `**Hard output constraint**: the response MUST be a single valid JSON object (starts with \`{\`, ends with \`}\`, no markdown, no prefix/suffix). It MUST include a non-empty \`daily_view\` of 40-80 English words and an \`action_assessment\` object with \`dip_buying\`, \`selling\`, and an 80-180 word \`summary\`. **The watchlist field MUST contain one complete WatchlistPick object for every supplied ticker (five total)**, each shaped like \`{ "symbol": "...", "display_name": "<English name>", "stance": "Bullish"|"Bearish"|"Neutral", "rationale": "80-150 word English summary citing concrete indicator numbers" }\`. **DO NOT write the watchlist as a string array of ticker symbols** and do not omit any requested asset.`,
          "",
          contextLines.length > 0
            ? `Auxiliary context (**you MUST reference at least one of these in market_overview**):\n${contextLines.map((l) => `  - ${l}`).join("\n")}\n`
            : "",
          newsPayload.length > 0
            ? `Today's focused, authoritative news (use these facts in the action assessment; do not invent details):\n${JSON.stringify(newsPayload)}`
            : "No additional relevant news was captured today; base the action assessment on price and indicators.",
          `Candidate assets (${payload.length} entries, JSON array):`,
          JSON.stringify(payload),
          "",
          `Output a JSON object per the system-prompt schema. Include daily_view and action_assessment. watchlist must contain all five complete WatchlistPick objects (symbol / display_name / stance / rationale fields). Omitting a ticker or using a string array is forbidden.`,
        ]
          .filter(Boolean)
          .join("\n")
      : [
          `**输出硬约束**：响应必须是单一合法 JSON 对象（以 \`{\` 开头以 \`}\` 结尾，不要 markdown、不要前后缀）。必须包含非空的 \`daily_view\`（40-80 字）和 \`action_assessment\`（含 dip_buying、selling、80-180 字 summary）。**watchlist 字段必须为输入中的全部 5 个标的各输出一个完整对象**，每个对象形如 \`{ "symbol": "...", "display_name": "...", "stance": "偏上行"|"偏下行"|"中性", "rationale": "80-150 字中文，引用具体指标数字" }\`。**禁止把 watchlist 写成 ticker symbol 字符串数组，也禁止遗漏工业富联、国际现货黄金、BTC、ETH、SOL。**`,
          "",
          contextLines.length > 0
            ? `辅助背景（**必须在 market_overview 里至少引用一项**）：\n${contextLines.map((l) => `  - ${l}`).join("\n")}\n`
            : "",
          newsPayload.length > 0
            ? `今日相关权威资讯（用于操作判断，不得编造资讯之外的事实）：\n${JSON.stringify(newsPayload)}`
            : "今日未抓取到额外相关资讯；操作判断以价格与技术指标为准。",
          `候选资产（共 ${payload.length} 个，JSON 数组）：`,
          JSON.stringify(payload),
          "",
          `请按 system prompt 的 schema 输出 JSON 对象。必须提供精炼的 daily_view 和 action_assessment。watchlist 必须覆盖全部 5 个标的，并为每个标的输出完整对象（含 symbol / display_name / stance / rationale 四个字段），绝不允许遗漏或使用字符串数组。`,
        ]
          .filter(Boolean)
          .join("\n");

  const fallback: TradingCommentary = {
    daily_view:
      REPORT_LOCALE === "en"
        ? "The focus assets remain mixed; wait for price confirmation rather than extrapolating one session's move."
        : "目标资产走势分化，当前更适合等待价格与动能共同确认，不宜根据单日波动外推趋势。",
    action_assessment: {
      dip_buying: "仅小仓试探",
      selling: "暂不卖出",
      summary:
        REPORT_LOCALE === "en"
          ? "New entries should wait for price and momentum confirmation and use small position sizes; existing positions should follow predefined risk limits rather than react to one session."
          : "空仓者暂时只宜小仓试探，等待价格与动能共同转强；已有仓位按既定风险线管理，不宜仅因单日波动追涨杀跌。",
    },
    market_overview: "",
    watchlist: [],
    risk_caveat:
      REPORT_LOCALE === "en"
        ? "The above is based on computed technical indicators from public market data and text summaries; it does NOT constitute investment advice. Past performance does not guarantee future results — market risk is your own."
        : "以上内容基于公开行情数据的技术指标计算与文本摘要，不构成任何投资建议。过去走势不代表未来表现，市场风险自负。",
  };

  // Up to 3 attempts. The "0 picks" failure mode is a probabilistic
  // guardrail trigger, not a deterministic prompt bug — retrying with the
  // exact same prompt usually flips to a different sampling branch. From
  // attempt 2 on, we also prefix a corrective note so the model sees its
  // own prior empty output as the thing to fix.
  const MAX_ATTEMPTS = 3;
  const RETRY_HINT =
    REPORT_LOCALE === "en"
      ? `\n\n⚠️ Important: the previous attempt had an invalid watchlist. This retry MUST include all five supplied assets exactly once, each with its own rationale.`
      : `\n\n⚠️ 重要：上一次 watchlist 格式错误。本次必须覆盖全部 5 个标的且每个只出现一次，每个标的都要有独立解读。`;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const promptForAttempt = attempt === 1 ? userPrompt : userPrompt + RETRY_HINT;
    try {
      return await callOnce(promptForAttempt, fallback, tickers.length);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (attempt < MAX_ATTEMPTS) {
        console.warn(
          `[trading-commentary] attempt ${attempt}/${MAX_ATTEMPTS} failed, retrying: ${msg}`,
        );
      } else {
        console.warn(
          `[trading-commentary] all ${MAX_ATTEMPTS} attempts failed: ${msg}`,
        );
      }
    }
  }
  return fallback;
}

async function callOnce(
  userPrompt: string,
  fallback: TradingCommentary,
  expectedPicks: number,
): Promise<TradingCommentary> {
  const { text } = await runLlm({
    systemPrompt: SYSTEM_PROMPT,
    userPrompt,
    timeoutMs: 240_000,
  });
  const cleaned = extractJson(text);
  let parsed: Partial<TradingCommentary>;
  try {
    parsed = JSON.parse(cleaned);
  } catch (strictErr) {
    try {
      parsed = JSON.parse(jsonrepair(cleaned));
      console.warn("[trading-commentary] JSON.parse failed, jsonrepair recovered");
    } catch {
      // Dump raw output for postmortem — symmetric to pipeline.ts logging.
      try {
        const fs = await import("node:fs");
        fs.mkdirSync("logs", { recursive: true });
        const ts = new Date().toISOString().replace(/[:.]/g, "-");
        fs.writeFileSync(`logs/trading-raw-${ts}.txt`, text, "utf8");
        fs.writeFileSync(`logs/trading-cleaned-${ts}.txt`, cleaned, "utf8");
        console.warn(
          `[trading-commentary] both JSON.parse and jsonrepair failed; raw at logs/trading-raw-${ts}.txt`,
        );
      } catch {
        // best-effort
      }
      throw strictErr;
    }
  }
  // Validate critical fields are populated. Empty watchlist, missing
  // overview, or wrong-shape picks (e.g. Sonnet sometimes returns a
  // string array when over-anchored on the ticker-count wording
  // wording) all trigger retry.
  const overview = parsed.market_overview ?? "";
  const dailyView = parsed.daily_view ?? "";
  const action = parsed.action_assessment;
  const picks = parsed.watchlist ?? [];
  if (dailyView.length < 20) {
    throw new Error(`daily_view too short (${dailyView.length} chars)`);
  }
  if (
    !action ||
    !action.dip_buying ||
    !action.selling ||
    typeof action.summary !== "string" ||
    action.summary.length < 30
  ) {
    throw new Error("action_assessment is missing or incomplete");
  }
  if (overview.length < 100) {
    throw new Error(`market_overview too short (${overview.length} chars)`);
  }
  if (picks.length !== expectedPicks) {
    throw new Error(
      `watchlist must contain ${expectedPicks} picks, received ${picks.length}`,
    );
  }
  const malformed = picks.find(
    (p) =>
      !p ||
      typeof p !== "object" ||
      typeof (p as WatchlistPick).symbol !== "string" ||
      typeof (p as WatchlistPick).stance !== "string" ||
      typeof (p as WatchlistPick).rationale !== "string" ||
      (p as WatchlistPick).rationale.length < 20,
  );
  if (malformed !== undefined) {
    throw new Error(
      `watchlist pick has invalid shape: ${JSON.stringify(malformed).slice(0, 120)}`,
    );
  }
  return {
    daily_view: dailyView,
    action_assessment: action,
    market_overview: overview,
    watchlist: picks as WatchlistPick[],
    risk_caveat: parsed.risk_caveat ?? fallback.risk_caveat,
  };
}

function round(n: number, dp = 2): number {
  return Math.round(n * 10 ** dp) / 10 ** dp;
}
function roundNullable(n: number | null, dp = 2): number | null {
  return n == null ? null : round(n, dp);
}
