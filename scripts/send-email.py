#!/usr/bin/env python3
"""Email a readable Daily Brief through QQ Mail SMTP."""

import json
import os
import smtplib
import ssl
from datetime import datetime
from email.message import EmailMessage
from email.utils import formatdate
from html import escape
from pathlib import Path
from zoneinfo import ZoneInfo


def required_env(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise RuntimeError(f"{name} is required")
    return value


def safe_url(value: object) -> str:
    url = str(value or "")
    return url if url.startswith(("https://", "http://")) else "#"


def format_price(value: object, currency: object) -> str:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return "-"
    symbol = {"CNY": "¥", "HKD": "HK$", "USD": "$"}.get(str(currency), "")
    return f"{symbol}{number:,.2f}"


def format_pct(value: object) -> tuple[str, str]:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return "-", "#64748b"
    color = "#c62828" if number > 0 else "#2e7d32" if number < 0 else "#64748b"
    return f"{number:+.2f}%", color


def stance_color(stance: object) -> str:
    if stance == "偏上行":
        return "#c62828"
    if stance == "偏下行":
        return "#2e7d32"
    return "#64748b"


recipient = required_env("EMAIL_TO")
sender = required_env("EMAIL_FROM")
password = required_env("EMAIL_PASSWORD")
report_tz = os.environ.get("REPORT_TZ", "Asia/Shanghai")
report_home = os.environ.get(
    "REPORT_HOME", "https://ninojun0301.github.io/DailyBrief/"
).rstrip("/")

report_date = datetime.now(ZoneInfo(report_tz)).strftime("%Y-%m-%d")
report_dir = Path("daily_reports") / report_date
report_path = report_dir / f"{report_date}.html"
data_path = report_dir / f"{report_date}.json"
if not report_path.exists():
    raise FileNotFoundError(f"Daily report not found: {report_path}")

raw_report = report_path.read_text(encoding="utf-8")
data = json.loads(data_path.read_text(encoding="utf-8")) if data_path.exists() else {}

headline = str(data.get("hero_headline") or "今日全球简报")
overview = str(data.get("daily_overview") or "今日简报已生成，点击文末链接查看完整内容。")
daily_view = str(data.get("trading", {}).get("daily_view") or "").strip()
action = data.get("trading", {}).get("action_assessment") or {}
action_dip = str(action.get("dip_buying") or "").strip()
action_sell = str(action.get("selling") or "").strip()
action_summary = str(action.get("summary") or "").strip()
report_url = f"{report_home}/{report_date}/{report_date}.html"

group_titles = {
    "china-equity": "工业富联",
    "commodity-fx": "国际现货黄金",
    "crypto": "加密货币",
}
group_order = ["china-equity", "commodity-fx", "crypto"]
tickers = data.get("trading", {}).get("tickers", [])

ticker_sections: list[str] = []
for group in group_order:
    group_tickers = [item for item in tickers if item.get("group") == group]
    if not group_tickers:
        continue
    rows: list[str] = []
    for item in group_tickers:
        day_text, day_color = format_pct(item.get("pct1Day"))
        five_day_text, five_day_color = format_pct(item.get("pct5Day"))
        rsi = item.get("rsi14")
        rsi_text = f"{float(rsi):.1f}" if isinstance(rsi, (int, float)) else "-"
        signals = " / ".join(
            str(signal.get("label"))
            for signal in item.get("signals", [])
            if signal.get("label")
        )
        signal_html = (
            f'<div style="font-size:12px;color:#64748b;margin-top:4px;">{escape(signals)}</div>'
            if signals
            else ""
        )
        rows.append(
            f"""
            <tr>
              <td style="padding:11px 8px;border-bottom:1px solid #e2e8f0;">
                <div style="font-weight:700;color:#0f172a;">{escape(str(item.get("displayName", "")))}</div>
                <div style="font-size:12px;color:#94a3b8;margin-top:2px;">{escape(str(item.get("symbol", "")))}</div>
                {signal_html}
              </td>
              <td style="padding:11px 8px;border-bottom:1px solid #e2e8f0;text-align:right;white-space:nowrap;font-weight:700;color:#0f172a;">{escape(format_price(item.get("currentPrice"), item.get("currency")))}</td>
              <td style="padding:11px 8px;border-bottom:1px solid #e2e8f0;text-align:right;white-space:nowrap;color:{day_color};font-weight:700;">{day_text}</td>
              <td style="padding:11px 8px;border-bottom:1px solid #e2e8f0;text-align:right;white-space:nowrap;color:{five_day_color};">{five_day_text}</td>
              <td style="padding:11px 8px;border-bottom:1px solid #e2e8f0;text-align:right;white-space:nowrap;color:#475569;">{rsi_text}</td>
            </tr>
            """
        )
    ticker_sections.append(
        f"""
        <div style="margin:0 0 22px;">
          <h3 style="margin:0 0 8px;font-size:16px;color:#0f172a;">{group_titles[group]}</h3>
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse;background:#ffffff;border:1px solid #e2e8f0;border-radius:8px;">
            <thead>
              <tr style="background:#f8fafc;color:#64748b;font-size:12px;">
                <th align="left" style="padding:10px 8px;">标的</th>
                <th align="right" style="padding:10px 8px;">现价</th>
                <th align="right" style="padding:10px 8px;">当日</th>
                <th align="right" style="padding:10px 8px;">5日</th>
                <th align="right" style="padding:10px 8px;">RSI</th>
              </tr>
            </thead>
            <tbody>{''.join(rows)}</tbody>
          </table>
        </div>
        """
    )

watch_items: list[str] = []
for item in data.get("trading", {}).get("watchlist", [])[:6]:
    stance = str(item.get("stance") or "中性")
    watch_items.append(
        f"""
        <div style="margin:0 0 14px;padding:14px 16px;background:#f8fafc;border-left:4px solid {stance_color(stance)};border-radius:6px;">
          <div style="margin:0 0 6px;font-weight:700;color:#0f172a;">{escape(str(item.get("display_name", "")))} <span style="font-size:12px;color:{stance_color(stance)};">{escape(stance)}</span></div>
          <div style="font-size:14px;line-height:1.7;color:#475569;">{escape(str(item.get("rationale", "")))}</div>
        </div>
        """
    )

focus_briefs = []
seen_brief_urls: set[str] = set()
for item in [
    *data.get("tech_briefs", []),
    *data.get("finance_briefs", []),
    *data.get("politics_briefs", []),
]:
    url = str(item.get("url") or "")
    if not url or url in seen_brief_urls:
        continue
    seen_brief_urls.add(url)
    focus_briefs.append(item)
focus_briefs.sort(key=lambda item: float(item.get("importance") or 0), reverse=True)

brief_items: list[str] = []
for item in focus_briefs[:6]:
    brief_items.append(
        f"""
        <div style="margin:0 0 16px;padding-bottom:14px;border-bottom:1px solid #e2e8f0;">
          <a href="{escape(safe_url(item.get("url")), quote=True)}" style="font-size:15px;line-height:1.5;font-weight:700;color:#0f4c81;text-decoration:none;">{escape(str(item.get("title", "")))}</a>
          <div style="font-size:14px;line-height:1.75;color:#475569;margin-top:6px;">{escape(str(item.get("summary", "")))}</div>
          <div style="font-size:12px;color:#94a3b8;margin-top:5px;">{escape(str(item.get("source", "")))}</div>
        </div>
        """
    )

risk_caveat = str(
    data.get("trading", {}).get(
        "risk_caveat",
        "本报告仅对公开信息与行情指标做客观整理，不构成投资建议。",
    )
)

email_html = f"""<!doctype html>
<html lang="zh-CN">
<body style="margin:0;padding:0;background:#eef2f7;color:#0f172a;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#eef2f7;">
    <tr><td align="center" style="padding:24px 12px;">
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:760px;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 6px 22px rgba(15,23,42,0.08);">
        <tr>
          <td style="background:#0f172a;padding:28px 30px;color:#ffffff;">
            <div style="font-size:12px;letter-spacing:2px;color:#f4c95d;font-weight:700;">DAILY BRIEF</div>
            <h1 style="margin:8px 0 6px;font-size:26px;line-height:1.35;color:#ffffff;">{escape(headline)}</h1>
            <div style="font-size:13px;color:#cbd5e1;">{report_date} · A股 · 黄金 · 加密货币</div>
          </td>
        </tr>
        <tr>
          <td style="padding:28px 30px 18px;">
            <h2 style="margin:0 0 10px;font-size:19px;color:#0f172a;">今日速览</h2>
            <p style="margin:0;font-size:15px;line-height:1.85;color:#334155;">{escape(overview)}</p>
          </td>
        </tr>
        {
          f'''<tr>
          <td style="padding:2px 30px 20px;">
            <div style="padding:18px 20px;background:#fff8e7;border:1px solid #f0d38a;border-left:4px solid #c58a12;border-radius:8px;">
              <div style="font-size:12px;font-weight:700;letter-spacing:1px;color:#8a5a08;margin-bottom:6px;">今日专业观点</div>
              <div style="font-size:15px;line-height:1.8;color:#3f3f46;">{escape(daily_view)}</div>
            </div>
          </td>
        </tr>''' if daily_view else ""
        }
        {
          f'''<tr>
          <td style="padding:0 30px 20px;">
            <div style="padding:18px 20px;background:#eef6ff;border:1px solid #bfdbfe;border-left:4px solid #2563a8;border-radius:8px;">
              <div style="font-size:12px;font-weight:700;letter-spacing:1px;color:#1d4f91;margin-bottom:8px;">操作判断</div>
              <div style="font-size:14px;font-weight:700;color:#0f172a;margin-bottom:8px;">抄底：{escape(action_dip)} &nbsp;·&nbsp; 卖出：{escape(action_sell)}</div>
              <div style="font-size:14px;line-height:1.8;color:#3f3f46;">{escape(action_summary)}</div>
            </div>
          </td>
        </tr>''' if action_summary else ""
        }
        <tr>
          <td style="padding:4px 30px 10px;">
            <h2 style="margin:0 0 16px;font-size:19px;color:#0f172a;">重点行情</h2>
            {''.join(ticker_sections)}
          </td>
        </tr>
        <tr>
          <td style="padding:6px 30px 12px;">
            <h2 style="margin:0 0 14px;font-size:19px;color:#0f172a;">技术面关注</h2>
            {''.join(watch_items)}
          </td>
        </tr>
        <tr>
          <td style="padding:8px 30px 22px;">
            <h2 style="margin:0 0 14px;font-size:19px;color:#0f172a;">重点资讯</h2>
            {''.join(brief_items)}
          </td>
        </tr>
        <tr>
          <td style="padding:0 30px 26px;">
            <a href="{escape(report_url, quote=True)}" style="display:inline-block;background:#0f4c81;color:#ffffff;text-decoration:none;font-weight:700;padding:12px 20px;border-radius:6px;">查看在线完整日报</a>
          </td>
        </tr>
        <tr>
          <td style="background:#f8fafc;padding:20px 30px;border-top:1px solid #e2e8f0;">
            <div style="font-size:12px;line-height:1.7;color:#64748b;">{escape(risk_caveat)}</div>
            <div style="font-size:12px;color:#94a3b8;margin-top:8px;">本邮件由 GitHub Actions 自动发送 · 完整交互版报告已作为附件附上</div>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>"""

plain_lines = [
    f"每日简报 {report_date}",
    headline,
    "",
    overview,
    "",
]
if daily_view:
    plain_lines.extend(["今日专业观点：", daily_view, ""])
if action_summary:
    plain_lines.extend(
        [
            f"操作判断：抄底 {action_dip}；卖出 {action_sell}",
            action_summary,
            "",
        ]
    )
plain_lines.append("重点行情：")
for item in tickers:
    if item.get("group") not in group_titles:
        continue
    day_text, _ = format_pct(item.get("pct1Day"))
    plain_lines.append(
        f"- {item.get('displayName', '')} ({item.get('symbol', '')}): "
        f"{format_price(item.get('currentPrice'), item.get('currency'))}, "
        f"当日 {day_text}"
    )
plain_lines.extend(["", "重点资讯："])
for item in focus_briefs[:6]:
    plain_lines.append(f"- {item.get('title', '')}：{item.get('summary', '')}")
plain_lines.extend(["", f"完整日报：{report_url}", "", risk_caveat])
plain_text = "\n".join(plain_lines)

message = EmailMessage()
message["Subject"] = f"每日简报 {report_date}｜A股 · 黄金 · 加密货币"
message["From"] = sender
message["To"] = recipient
message["Date"] = formatdate(localtime=True)
message["Content-Language"] = "zh-CN"
message.set_content(plain_text)
message.add_alternative(email_html, subtype="html")
message.add_attachment(
    raw_report.encode("utf-8"),
    maintype="text",
    subtype="html",
    filename=f"DailyBrief-{report_date}.html",
)

context = ssl.create_default_context()
with smtplib.SMTP_SSL("smtp.qq.com", 465, context=context, timeout=30) as smtp:
    smtp.login(sender, password)
    smtp.send_message(message, from_addr=sender, to_addrs=[recipient])

print(f"Emailed readable Daily Brief {report_date} to {recipient}")
