// Job handlers wiring feeds → downloader → Yoto sync (SPEC.md §5, §12).
import { getDb, logEvent, now, uuid } from "./db";
import { canonicalKey, fetchFeed } from "./feeds";
import { downloadEpisode } from "./downloader";
import { uploadEpisode, waitForTranscode, writeCardContent, CardTrack } from "./yoto";
import { enqueue, registerHandler, JobType } from "./jobs";
import { DEFAULT_KEEP_COUNT } from "../config";
import { remove } from "@tauri-apps/plugin-fs";

export type Rules = {
  keep: number; // latest N on card (auto mode), or the advisory cap shown in the picker (manual mode)
  order: "newest-first" | "oldest-first";
  autoUpdate: boolean;
  // "auto": keep the most recent `keep` episodes. "manual": the user's own
  // include/exclude choices are authoritative (SPEC §"manual — I pick").
  // A podcast switches to "manual" the first time its episodes are touched
  // via setEpisodeIncluded.
  keepMode: "auto" | "manual";
};

export const DEFAULT_RULES: Rules = {
  keep: DEFAULT_KEEP_COUNT,
  order: "oldest-first",
  autoUpdate: true,
  keepMode: "auto",
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
  // A cached etag/lastModified is only meaningful once we've actually parsed
  // episodes from a prior successful scan of this feed — otherwise a stale
  // or prematurely-seeded value (e.g. from the add-podcast preview fetch)
  // would 304 the very first scan and leave the podcast with zero episodes.
  const [{ n: episodeCount }] = await d.select<{ n: number }[]>(
    `SELECT COUNT(*) n FROM episodes WHERE podcast_id=$1`,
    [podcastId],
  );
  const feed = await fetchFeed(p.feed_url, {
    etag: episodeCount > 0 ? p.etag ?? undefined : undefined,
    lastModified: episodeCount > 0 ? p.last_modified ?? undefined : undefined,
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

/**
 * Decide which episodes should be on the card, download what's missing.
 * Auto mode: selection is always "the most recent `keep` eligible episodes" —
 * `rules.order` only decides the sequence they're placed on the card in (see
 * syncCard), never which ones are kept. Otherwise an "oldest-first" podcast
 * with more than `keep` episodes would keep selecting the same oldest N
 * forever. Manual mode: the user's own choices are authoritative, so this
 * auto-selection is skipped entirely — see setEpisodeIncluded.
 */
export async function planPodcast(podcastId: string): Promise<void> {
  const d = await getDb();
  const [p] = await d.select<any[]>(`SELECT * FROM podcasts WHERE id=$1`, [podcastId]);
  const rules: Rules = { ...DEFAULT_RULES, ...JSON.parse(p.rules_json ?? "{}") };
  if (rules.keepMode === "manual") return;
  const wanted = await d.select<any[]>(
    `SELECT id, state FROM episodes
     WHERE podcast_id=$1 AND state != 'EXCLUDED' AND enclosure_url IS NOT NULL
     ORDER BY published_at DESC LIMIT $2`,
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
    `UPDATE episodes SET state='DOWNLOADED', transcoded_sha256=$2,
       transcoded_duration_seconds=$3, transcoded_file_size=$4,
       transcoded_channels=$5, transcoded_format=$6 WHERE id=$1`,
    [
      episodeId,
      t.transcodedSha256,
      t.transcodedInfo?.duration ?? null,
      t.transcodedInfo?.fileSize ?? null,
      t.transcodedInfo?.channels != null ? Number(t.transcodedInfo.channels) : null,
      t.transcodedInfo?.format ?? null,
    ],
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
  // Manual mode: the user's own choices are the whole selection, uncapped —
  // `keep` is only an advisory number shown in the episode picker there.
  const ready =
    rules.keepMode === "manual"
      ? await d.select<any[]>(
          `SELECT * FROM episodes
           WHERE podcast_id=$1 AND transcoded_sha256 IS NOT NULL AND state != 'EXCLUDED'
           ORDER BY published_at DESC`,
          [card.podcast_id],
        )
      : await d.select<any[]>(
          `SELECT * FROM episodes
           WHERE podcast_id=$1 AND transcoded_sha256 IS NOT NULL AND state != 'EXCLUDED'
           ORDER BY published_at DESC LIMIT $2`,
          [card.podcast_id, rules.keep],
        );
  if (!ready.length) return;
  if (rules.order === "oldest-first") ready.reverse();
  const tracks: CardTrack[] = ready.map((ep) => ({
    title: ep.title,
    transcodedSha256: ep.transcoded_sha256,
    durationSeconds: ep.transcoded_duration_seconds ?? ep.duration_seconds ?? undefined,
    fileSizeBytes: ep.transcoded_file_size ?? undefined,
    channels: ep.transcoded_channels ?? undefined,
    format: ep.transcoded_format ?? undefined,
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
  const input = tracks
    .map((t) => `${t.transcodedSha256}:${t.title}:${t.durationSeconds}:${t.fileSizeBytes}:${t.channels}:${t.format}`)
    .join("|");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * User-driven include/exclude (SPEC §17 checklist). Excluding an episode that
 * was ever uploaded resyncs its card(s) immediately so it drops off right
 * away; including one either resumes the download/upload pipeline (never
 * uploaded yet) or resyncs immediately (already has a cached upload).
 */
export async function setEpisodeIncluded(episodeId: string, included: boolean): Promise<void> {
  const d = await getDb();
  const [ep] = await d.select<any[]>(`SELECT * FROM episodes WHERE id=$1`, [episodeId]);
  if (!ep) return;

  // Touching any episode's selection makes the user's choices authoritative
  // for this podcast from now on (SPEC "manual — I pick"), instead of the
  // automatic most-recent-`keep` window.
  const [p] = await d.select<any[]>(`SELECT rules_json FROM podcasts WHERE id=$1`, [ep.podcast_id]);
  const rules: Rules = { ...DEFAULT_RULES, ...JSON.parse(p?.rules_json ?? "{}") };
  if (rules.keepMode !== "manual") {
    await d.execute(`UPDATE podcasts SET rules_json=$2 WHERE id=$1`, [
      ep.podcast_id,
      JSON.stringify({ ...rules, keepMode: "manual" }),
    ]);
  }

  async function resyncCards() {
    const cards = await d.select<any[]>(`SELECT id FROM cards WHERE podcast_id=$1`, [ep.podcast_id]);
    for (const c of cards) await enqueue("sync-card", { cardId: c.id });
  }

  if (!included) {
    await d.execute(`UPDATE episodes SET state='EXCLUDED' WHERE id=$1`, [episodeId]);
    if (ep.transcoded_sha256) await resyncCards();
    return;
  }
  if (ep.transcoded_sha256) {
    await d.execute(`UPDATE episodes SET state='DOWNLOADED' WHERE id=$1`, [episodeId]);
    await resyncCards();
  } else {
    // Bypass the automatic recency window entirely — an explicit include
    // downloads this episode regardless of where it falls chronologically.
    await d.execute(`UPDATE episodes SET state='INCLUDED' WHERE id=$1`, [episodeId]);
    await enqueue("download-episode", { episodeId });
  }
}

/**
 * Remove a card locally (stops it from being synced). Does NOT delete the
 * card's content on the user's actual Yoto account — that's a separate,
 * external action the user can take from the Yoto app if they want it.
 */
export async function removeCard(cardId: string): Promise<void> {
  const d = await getDb();
  await d.execute(`DELETE FROM card_items WHERE card_id=$1`, [cardId]);
  await d.execute(`DELETE FROM cards WHERE id=$1`, [cardId]);
}

/**
 * Remove a podcast and everything local tied to it: its cards, episodes, and
 * downloaded audio files on disk. Like removeCard, this never touches the
 * actual card content on the user's Yoto account.
 */
export async function removePodcast(podcastId: string): Promise<void> {
  const d = await getDb();
  const episodes = await d.select<{ id: string }[]>(
    `SELECT id FROM episodes WHERE podcast_id=$1`,
    [podcastId],
  );
  const cards = await d.select<{ id: string }[]>(`SELECT id FROM cards WHERE podcast_id=$1`, [
    podcastId,
  ]);
  const files = await d.select<{ path: string }[]>(
    `SELECT path FROM files WHERE episode_id IN (SELECT id FROM episodes WHERE podcast_id=$1)`,
    [podcastId],
  );
  for (const f of files) {
    await remove(f.path).catch(() => {}); // best-effort; DB cleanup proceeds regardless
  }
  for (const c of cards) {
    await d.execute(`DELETE FROM card_items WHERE card_id=$1`, [c.id]);
  }
  await d.execute(`DELETE FROM cards WHERE podcast_id=$1`, [podcastId]);
  await d.execute(
    `DELETE FROM files WHERE episode_id IN (SELECT id FROM episodes WHERE podcast_id=$1)`,
    [podcastId],
  );
  await d.execute(`DELETE FROM episodes WHERE podcast_id=$1`, [podcastId]);
  await d.execute(`DELETE FROM podcasts WHERE id=$1`, [podcastId]);

  // Best-effort cleanup of any queued work referencing what we just deleted
  // (handlers already no-op safely on missing rows, so this is tidiness,
  // not correctness).
  const ids = [podcastId, ...episodes.map((e) => e.id), ...cards.map((c) => c.id)];
  for (const id of ids) {
    await d.execute(`DELETE FROM jobs WHERE state='PENDING' AND payload_json LIKE $1`, [`%${id}%`]);
  }
}

const ACTIVITY_LABEL: Record<JobType, string> = {
  "scan-feed": "Checking",
  "download-episode": "Downloading",
  "upload-episode": "Uploading",
  "sync-card": "Updating card",
  cleanup: "Cleaning up",
};

/** Human-readable description of what's currently running, for the status bar. */
export async function getCurrentActivity(): Promise<string[]> {
  const d = await getDb();
  const running = await d.select<{ type: JobType; payload_json: string }[]>(
    `SELECT type, payload_json FROM jobs WHERE state='RUNNING' ORDER BY created_at`,
  );
  const lines: string[] = [];
  for (const job of running) {
    const payload = JSON.parse(job.payload_json);
    let title = "";
    if (payload.episodeId) {
      const [ep] = await d.select<any[]>(`SELECT title FROM episodes WHERE id=$1`, [
        payload.episodeId,
      ]);
      title = ep?.title ?? "";
    } else if (payload.cardId) {
      const [c] = await d.select<any[]>(`SELECT title FROM cards WHERE id=$1`, [payload.cardId]);
      title = c?.title ?? "";
    } else if (payload.podcastId) {
      const [p] = await d.select<any[]>(`SELECT title FROM podcasts WHERE id=$1`, [
        payload.podcastId,
      ]);
      title = p?.title ?? "";
    }
    lines.push(title ? `${ACTIVITY_LABEL[job.type]} "${title}"` : ACTIVITY_LABEL[job.type]);
  }
  return lines;
}
