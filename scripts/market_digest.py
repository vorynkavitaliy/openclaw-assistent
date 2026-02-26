#!/usr/bin/env python3
"""market_digest.py

Produces a lightweight JSON digest without requiring web_search/web_fetch tools.
- Macro: ForexFactory calendar XML (unofficial but widely mirrored)
- Crypto news: RSS feeds (CoinDesk, Cointelegraph)

Usage:
  python3 scripts/market_digest.py --hours=48 --max-news=20

Output: JSON to stdout.
"""

from __future__ import annotations

import argparse
import json
import sys
import time
import urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta, timezone
from email.utils import parsedate_to_datetime


FF_XML_URLS = [
    # Unofficial public mirrors used by many calendar bots (may rate-limit).
    "https://nfs.faireconomy.media/ff_calendar_thisweek.xml",
    "https://nfs.faireconomy.media/ff_calendar_today.xml",
]

RSS_FEEDS = [
    ("CoinDesk", "https://www.coindesk.com/arc/outboundfeeds/rss/"),
    ("Cointelegraph", "https://cointelegraph.com/rss"),
]


def http_get(url: str, timeout: int = 20) -> bytes:
    req = urllib.request.Request(
        url,
        headers={
            "User-Agent": "openclaw-assistent/market-digest (+https://github.com/vorynkavitaliy/openclaw-assistent)",
            "Accept": "application/xml,text/xml,text/html,*/*",
        },
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read()


def parse_ff_calendar(xml_bytes: bytes) -> list[dict]:
    """Parse ForexFactory XML into normalized events."""
    root = ET.fromstring(xml_bytes)
    out: list[dict] = []

    # Expected shape: <weeklyevents><event>...</event></weeklyevents>
    for ev in root.findall(".//event"):
        def t(name: str) -> str:
            node = ev.find(name)
            return (node.text or "").strip() if node is not None else ""

        # ForexFactory XML often provides:
        # <date>02-26-2026</date> <time>14:30</time> <country>USD</country> ...
        date_s = t("date")
        time_s = t("time")

        # If time is "All Day" / "Tentative" - skip timestamp but keep info
        ts = None
        if date_s and time_s and time_s.lower() not in ("all day", "tentative"):
            # Heuristic: the mirror usually returns times in ET. We'll store naive as UTC? => cannot.
            # Many FF XML mirrors provide <timestamp> in seconds (preferred). Use if present.
            ts_s = t("timestamp")
            if ts_s.isdigit():
                ts = int(ts_s)
            else:
                # Fallback: parse as MM-DD-YYYY HH:MM with UTC assumption
                try:
                    dt = datetime.strptime(f"{date_s} {time_s}", "%m-%d-%Y %H:%M").replace(tzinfo=timezone.utc)
                    ts = int(dt.timestamp())
                except Exception:
                    ts = None

        out.append(
            {
                "title": t("title"),
                "country": t("country"),
                "currency": t("currency") or t("country"),
                "impact": t("impact"),
                "forecast": t("forecast"),
                "previous": t("previous"),
                "actual": t("actual"),
                "date": date_s,
                "time": time_s,
                "timestamp": ts,
            }
        )

    return out


def parse_rss(xml_bytes: bytes, source: str) -> list[dict]:
    root = ET.fromstring(xml_bytes)
    items = []

    for it in root.findall(".//channel/item"):
        title = (it.findtext("title") or "").strip()
        link = (it.findtext("link") or "").strip()
        pub = (it.findtext("pubDate") or "").strip()
        ts = None
        if pub:
            try:
                ts = int(parsedate_to_datetime(pub).timestamp())
            except Exception:
                ts = None

        items.append({"source": source, "title": title, "link": link, "pubDate": pub, "timestamp": ts})

    return items


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--hours", type=int, default=48)
    ap.add_argument("--max-news", type=int, default=20)
    ap.add_argument("--max-events", type=int, default=50)
    args = ap.parse_args()

    now = datetime.now(timezone.utc)
    since_ts = int((now - timedelta(hours=args.hours)).timestamp())
    until_ts = int((now + timedelta(hours=args.hours)).timestamp())

    macro_events: list[dict] = []
    macro_errors: list[str] = []

    for url in FF_XML_URLS:
        try:
            xml_bytes = http_get(url)
            macro_events.extend(parse_ff_calendar(xml_bytes))
        except Exception as e:
            macro_errors.append(f"{url}: {e}")

    # Filter + sort macro events around now..+hours (next window)
    upcoming = [
        e
        for e in macro_events
        if isinstance(e.get("timestamp"), int) and now.timestamp() <= e["timestamp"] <= until_ts
    ]
    upcoming.sort(key=lambda e: e["timestamp"])
    upcoming = upcoming[: args.max_events]

    # If timestamps are missing (or source rate-limited), still return a few raw events for visibility.
    raw_sample = [e for e in macro_events if e.get("title")][: args.max_events]

    news_items: list[dict] = []
    news_errors: list[str] = []
    for source, url in RSS_FEEDS:
        try:
            xml_bytes = http_get(url)
            news_items.extend(parse_rss(xml_bytes, source=source))
        except Exception as e:
            news_errors.append(f"{source} {url}: {e}")

    recent_news = [n for n in news_items if isinstance(n.get("timestamp"), int) and n["timestamp"] >= since_ts]
    recent_news.sort(key=lambda n: n["timestamp"], reverse=True)
    recent_news = recent_news[: args.max_news]

    out = {
        "status": "OK",
        "generatedAt": now.isoformat(),
        "windowHours": args.hours,
        "macro": {"upcoming": upcoming, "sample": raw_sample, "errors": macro_errors},
        "news": {"recent": recent_news, "errors": news_errors},
    }

    json.dump(out, sys.stdout, ensure_ascii=False, indent=2)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
