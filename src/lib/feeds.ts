// RSS/Atom parsing + canonical keys + dedup (SPEC.md §6).
import { fetch } from "@tauri-apps/plugin-http";

export type EpisodeCandidate = {
  guid?: string;
  title: string;
  publishedAt?: string;
  durationSeconds?: number;
  description?: string;
  enclosureUrl?: string;
  artworkUrl?: string;
  season?: number;
  episodeNumber?: number;
};

export type FeedPreview = {
  title: string;
  description?: string;
  artworkUrl?: string;
  language?: string;
  episodes: EpisodeCandidate[];
  etag?: string;
  lastModified?: string;
  notModified?: boolean;
};

function text(el: Element | null | undefined): string | undefined {
  const t = el?.textContent?.trim();
  return t || undefined;
}

function parseDuration(raw?: string): number | undefined {
  if (!raw) return undefined;
  if (/^\d+$/.test(raw)) return parseInt(raw, 10);
  const parts = raw.split(":").map((p) => parseInt(p, 10));
  if (parts.some(isNaN)) return undefined;
  return parts.reduce((acc, p) => acc * 60 + p, 0);
}

/** Strip tracking-prefix variance so the same enclosure dedupes (SPEC §6). */
export function normalizeEnclosureUrl(u: string): string {
  try {
    const url = new URL(u);
    url.protocol = "https:";
    url.hash = "";
    return url.toString();
  } catch {
    return u;
  }
}

/** Dedup order: 1) GUID  2) normalized enclosure URL  3) title+date fallback. */
export function canonicalKey(c: EpisodeCandidate): string {
  if (c.guid) return `guid:${c.guid}`;
  if (c.enclosureUrl) return `url:${normalizeEnclosureUrl(c.enclosureUrl)}`;
  return `td:${c.title}|${c.publishedAt ?? ""}`;
}

export function parseFeedXml(xml: string): Omit<FeedPreview, "etag" | "lastModified"> {
  const doc = new DOMParser().parseFromString(xml, "text/xml");
  if (doc.querySelector("parsererror")) {
    throw new Error("This doesn't look like a valid podcast feed (E_FEED_PARSE)");
  }
  const ITUNES = "http://www.itunes.com/dtds/podcast-1.0.dtd";
  const chan = doc.querySelector("channel");
  if (chan) {
    // RSS 2.0
    const episodes: EpisodeCandidate[] = [...chan.querySelectorAll("item")].map(
      (item) => {
        const enclosure = item.querySelector("enclosure");
        const itunesImg = item.getElementsByTagNameNS(ITUNES, "image")[0];
        return {
          guid: text(item.querySelector("guid")),
          title: text(item.querySelector("title")) ?? "(untitled)",
          publishedAt: toIso(text(item.querySelector("pubDate"))),
          durationSeconds: parseDuration(
            text(item.getElementsByTagNameNS(ITUNES, "duration")[0]),
          ),
          description:
            text(item.getElementsByTagNameNS(ITUNES, "summary")[0]) ??
            text(item.querySelector("description")),
          enclosureUrl: enclosure?.getAttribute("url") ?? undefined,
          artworkUrl: itunesImg?.getAttribute("href") ?? undefined,
          season: num(text(item.getElementsByTagNameNS(ITUNES, "season")[0])),
          episodeNumber: num(text(item.getElementsByTagNameNS(ITUNES, "episode")[0])),
        };
      },
    );
    const chanImg =
      chan.getElementsByTagNameNS(ITUNES, "image")[0]?.getAttribute("href") ??
      text(chan.querySelector("image > url"));
    return {
      title: text(chan.querySelector("title")) ?? "(untitled feed)",
      description: text(chan.querySelector("description")),
      artworkUrl: chanImg ?? undefined,
      language: text(chan.querySelector("language")),
      episodes,
    };
  }
  // Atom
  const feed = doc.querySelector("feed");
  if (!feed) throw new Error("Unsupported feed format (E_FEED_FORMAT)");
  const episodes: EpisodeCandidate[] = [...feed.querySelectorAll("entry")].map((e) => ({
    guid: text(e.querySelector("id")),
    title: text(e.querySelector("title")) ?? "(untitled)",
    publishedAt: toIso(text(e.querySelector("published")) ?? text(e.querySelector("updated"))),
    enclosureUrl:
      e.querySelector('link[rel="enclosure"]')?.getAttribute("href") ?? undefined,
    description: text(e.querySelector("summary")),
  }));
  return {
    title: text(feed.querySelector("title")) ?? "(untitled feed)",
    episodes,
  };
}

function toIso(raw?: string): string | undefined {
  if (!raw) return undefined;
  const d = new Date(raw);
  return isNaN(d.getTime()) ? undefined : d.toISOString();
}

function num(raw?: string): number | undefined {
  if (!raw) return undefined;
  const n = parseInt(raw, 10);
  return isNaN(n) ? undefined : n;
}

/** Fetch a feed with conditional-request support (ETag / Last-Modified). */
export async function fetchFeed(
  url: string,
  cache: { etag?: string; lastModified?: string } = {},
): Promise<FeedPreview> {
  const headers: Record<string, string> = { Accept: "application/rss+xml, application/atom+xml, application/xml, text/xml" };
  if (cache.etag) headers["If-None-Match"] = cache.etag;
  if (cache.lastModified) headers["If-Modified-Since"] = cache.lastModified;
  const res = await fetch(url, { headers });
  if (res.status === 304) {
    return { title: "", episodes: [], notModified: true, ...cache };
  }
  if (!res.ok) throw new Error(`Feed returned HTTP ${res.status} (E_FEED_HTTP)`);
  const parsed = parseFeedXml(await res.text());
  return {
    ...parsed,
    etag: res.headers.get("ETag") ?? undefined,
    lastModified: res.headers.get("Last-Modified") ?? undefined,
  };
}
