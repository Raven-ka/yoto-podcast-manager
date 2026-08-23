// Job handlers wiring feeds → downloader → Yoto sync (SPEC.md §5, §12).
import { getDb, logEvent, now, uuid } from "./db";
import { canonicalKey, fetchFeed } from "./feeds";
import { downloadEpisode } from "./downloader";
import { uploadEpisode, waitForTranscode, writeCardContent, CardTrack } from "./yoto";
import { enqueue, registerHandler } from "./jobs";
import { DEFAULT_KEEP_COUNT } from "../config";

export type Rules = {
  keep: number; // latest N on card
  order: "newest-first" | "oldest-first" | "manual";
  autoUpdate: boolean;
};

export const DEFAULT_RULES: Rules = {
  keep: DEFAULT_KEEP_COUNT,
  order: "newest-first",
  autoUpdate: true,
};

export function registerAllHandlers(): void {
  registerHandler("scan-feed", scanFeed);
  registerHandler("download-episode", downloadEpisodeJob);
  registerHandler("upload-episode", uploadEpisodeJob);
  registerHandler("sync-card", syncCard);
}

async function scanFeed({ podcastId }: { podcastId: string }): Promise<void> {
  const d = await getDb();
  const [p] = await d.select<any[]>(`SELECT * FROM podcasts WHERE id=$1`, [podcastId]);
  if (!p || p.paused || p.source_type !== "rss") return;
  const feed = await fetchFeed(p.feed_url, {
    etag: p.etag ?? undefined,
    lastModified: p.last_modified ?? undefined,
  });
  if (feed.notModified) return;
  await d.execute(
    `UPDATE podcasts SET etag=$2, last_modified=$3, health='ok', updated_at=$4 WHERE id=$1`,
    [podcastId, feed.etag ?? null, feed.lastModified ?? null, now()],
  );
  for (const c of feed.episodes) {
    const key = canonicalKey(c);
    await d.execute(
      `INSERT INTO episodes (id, podcast_id, canonical_key, guid, title, published_at,
         duration_seconds, description, enclosure_url, artwork_url, season, episode_number, state)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'DISCOVERED')
       ON CONFLICT (podcast_id, canonical_key) DO UPDATE SET
         title=excluded.title, published_at=excluded.published_at,
         duration_seconds=excluded.duration_seconds, description=excluded.description`,
      [uuid(), podcastId, key, c.guid ?? null, c.title, c.publishedAt ?? null,
       c.durationSeconds ?? null, c.description ?? null, c.enclosureUrl ?? null,
       c.artworkUrl ?? null, c.season ?? null, c.episodeNumber ?? null],
    );
  }
  await logEvent("scan", `Checked "${p.title}" — ${feed.episodes.length} episodes in feed`, {
    entityType: "podcast",
    entityId: podcastId,
  });
  await planPodcast(podcastId);
}

/** Decide which episodes should be on the card, download what's missing. */
export async function planPodcast(podcastId: string): Promise<void> {
  const d = await getDb();
  const [p] = await d.select<any[]>(`SELECT * FROM podcasts WHERE id=$1`, [podcastId]);
  const rules: Rules = { ...DEFAULT_RULES, ...JSON.parse(p.rules_json ?? "{}") };
  const order = rules.order === "oldest-first" ? "ASC" : "DESC";
  const wanted = await d.select<any[]>(
    `SELECT id, state FROM episodes
     WHERE podcast_id=$1 AND state != 'EXCLUDED' AND enclosure_url IS NOT NULL
     ORDER BY published_at ${order} LIMIT $2`,
    [podcastId, rules.keep],
  );
  for (const ep of wanted) {
    if (ep.state === "DISCOVERED") {
      await d.execute(`UPDATE episodes SET state='INCLUDED' WHERE id=$1`, [ep.id]);
      await enqueue("download-episode", { episodeId: ep.id });
    }
  }
}

async function downloadEpisodeJob({ episodeId }: { episodeId: string }): Promise<void> {
  const d = await getDb();
  const [ep] = await d.select<any[]>(`SELECT * FROM episodes WHERE id=$1`, [episodeId]);
  if (!ep || !ep.enclosure_url) return;
  await d.execute(`UPDATE episodes SET state='DOWNLOADING' WHERE id=$1`, [episodeId]);
  try {
    const r = await downloadEpisode(ep.enclosure_url);
    await d.execute(
      `INSERT INTO files (id, episode_id, path, bytes, sha256, downloaded_at)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [uuid(), episodeId, r.path, r.bytes, r.sha256, now()],
    );
    await d.execute(`UPDATE episodes SET state='DOWNLOADED' WHERE id=$1`, [episodeId]);
    await enqueue("upload-episode", { episodeId });
  } catch (e: any) {
    await d.execute(
      `UPDATE episodes SET state='NEEDS_ATTENTION', error_message=$2 WHERE id=$1`,
      [episodeId, String(e?.message ?? e)],
    );
    throw e;
  }
}

async function uploadEpisodeJob({ episodeId }: { episodeId: string }): Promise<void> {
  const d = await getDb();
  const [ep] = await d.select<any[]>(`SELECT * FROM episodes WHERE id=$1`, [episodeId]);
  if (!ep) return;
  if (ep.transcoded_sha256) return; // idempotent: already uploaded
  const [file] = await d.select<any[]>(
    `SELECT * FROM files WHERE episode_id=$1 ORDER BY downloaded_at DESC LIMIT 1`,
    [episodeId],
  );
  if (!file) throw Object.assign(new Error("No downloaded file (E_NO_FILE)"), { permanent: true });
  await d.execute(`UPDATE episodes SET state='UPLOADING' WHERE id=$1`, [episodeId]);
  const uploadId = await uploadEpisode(file.path);
  const t = await waitForTranscode(uploadId);
  await d.execute(
    `UPDATE episodes SET state='DOWNLOADED', transcoded_sha256=$2 WHERE id=$1`,
    [episodeId, t.transcodedSha256],
  );
  await logEvent("upload", `Uploaded "${ep.title}" to Yoto`, {
    entityType: "episode",
    entityId: episodeId,
  });
  // Any card containing this podcast is now out of date.
  const cards = await d.select<any[]>(`SELECT id FROM cards WHERE podcast_id=$1`, [ep.podcast_id]);
  for (const c of cards) await enqueue("sync-card", { cardId: c.id });
}

async function syncCard({ cardId }: { cardId: string }): Promise<void> {
  const d = await getDb();
  const [card] = await d.select<any[]>(`SELECT * FROM cards WHERE id=$1`, [cardId]);
  if (!card) return;
  const [p] = await d.select<any[]>(`SELECT * FROM podcasts WHERE id=$1`, [card.podcast_id]);
  const rules: Rules = { ...DEFAULT_RULES, ...JSON.parse(p?.rules_json ?? "{}") };
  const order = rules.order === "oldest-first" ? "ASC" : "DESC";
  const ready = await d.select<any[]>(
    `SELECT * FROM episodes
     WHERE podcast_id=$1 AND transcoded_sha256 IS NOT NULL AND state != 'EXCLUDED'
     ORDER BY published_at ${order} LIMIT $2`,
    [card.podcast_id, rules.keep],
  );
  if (!ready.length) return;
  const tracks: CardTrack[] = ready.map((ep) => ({
    title: ep.title,
    transcodedSha256: ep.transcoded_sha256,
    durationSeconds: ep.duration_seconds ?? undefined,
  }));
  const desiredHash = await hashDesired(tracks);
  if (desiredHash === card.confirmed_hash) return; // nothing to do
  await d.execute(`UPDATE cards SET sync_state='SYNCING' WHERE id=$1`, [cardId]);
  try {
    const res = await writeCardContent({
      contentId: card.remote_content_id ?? undefined,
      title: card.title,
      tracks,
    });
    await d.execute(
      `UPDATE cards SET remote_content_id=$2, desired_hash=$3, confirmed_hash=$3,
         sync_state='IN_SYNC', last_synced_at=$4 WHERE id=$1`,
      [cardId, res.cardId, desiredHash, now()],
    );
    await d.execute(
      `UPDATE episodes SET state='ON_CARD' WHERE transcoded_sha256 IN (${tracks
        .map((_, i) => `$${i + 1}`)
        .join(",")})`,
      tracks.map((t) => t.transcodedSha256),
    );
    await logEvent("sync", `Card "${card.title}" updated — ${tracks.length} episodes`, {
      entityType: "card",
      entityId: cardId,
    });
  } catch (e) {
    await d.execute(`UPDATE cards SET sync_state='NEEDS_ATTENTION' WHERE id=$1`, [cardId]);
    throw e;
  }
}

async function hashDesired(tracks: CardTrack[]): Promise<string> {
  const input = tracks.map((t) => `${t.transcodedSha256}:${t.title}`).join("|");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
