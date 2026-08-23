import { describe, expect, it } from "vitest";
import { canonicalKey, parseFeedXml } from "./feeds";
import { detectDirection } from "./text";

const HEBREW_RSS = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd">
  <channel>
    <title>הסכתות</title>
    <language>he</language>
    <item>
      <title>פרק 1 — התחלה</title>
      <guid>ep-001</guid>
      <pubDate>Mon, 03 Aug 2026 06:00:00 GMT</pubDate>
      <itunes:duration>25:30</itunes:duration>
      <enclosure url="https://example.com/ep1.mp3" type="audio/mpeg" length="12345"/>
    </item>
    <item>
      <title>Episode 2 (English title)</title>
      <enclosure url="http://example.com/ep2.mp3?token=abc" type="audio/mpeg"/>
    </item>
  </channel>
</rss>`;

describe("parseFeedXml", () => {
  it("parses a Hebrew RSS feed", () => {
    const feed = parseFeedXml(HEBREW_RSS);
    expect(feed.title).toBe("הסכתות");
    expect(feed.episodes).toHaveLength(2);
    expect(feed.episodes[0].guid).toBe("ep-001");
    expect(feed.episodes[0].durationSeconds).toBe(25 * 60 + 30);
    expect(feed.episodes[0].publishedAt).toContain("2026-08-03");
  });

  it("rejects non-feed content", () => {
    expect(() => parseFeedXml("<html><body>nope</body></html>")).toThrow();
  });
});

describe("canonicalKey (dedup order, SPEC §6)", () => {
  it("prefers guid over enclosure", () => {
    expect(canonicalKey({ title: "t", guid: "g", enclosureUrl: "https://x/y.mp3" })).toBe(
      "guid:g",
    );
  });
  it("normalizes http→https in enclosure keys", () => {
    expect(canonicalKey({ title: "t", enclosureUrl: "http://x.com/y.mp3" })).toBe(
      "url:https://x.com/y.mp3",
    );
  });
  it("falls back to title+date", () => {
    expect(canonicalKey({ title: "t", publishedAt: "2026-01-01" })).toBe("td:t|2026-01-01");
  });
});

describe("detectDirection", () => {
  it("detects Hebrew as rtl", () => {
    expect(detectDirection("פרק ראשון")).toBe("rtl");
  });
  it("detects English as ltr", () => {
    expect(detectDirection("Episode one")).toBe("ltr");
  });
  it("mixed: first strong character wins", () => {
    expect(detectDirection("פרק 1 — Episode")).toBe("rtl");
    expect(detectDirection("Episode פרק")).toBe("ltr");
  });
});
