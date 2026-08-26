// Job handlers wiring feeds → downloader → Yoto sync (SPEC.md §5, §12).
import Database from "@tauri-apps/plugin-sql";
import { getDb, logEvent, now, uuid } from "./db";
import { canonicalKey, fetchFeed } from "./feeds";
import { downloadEpisode } from "./downloader";
import {
  uploadEpisode,
  waitForTranscode,
  writeCardContent,
  getContent,
  uploadCoverImage,
  CardTrack,
} from "./yoto";
import { enqueue, registerHandler, JobType } from "./jobs";
import { DEFAULT_KEEP_COUNT } from "../config";
import { remove } from "@tauri-apps/plugin-fs";

// Held off until conflict detection (the write path this shares) was proven
// live — confirmed 2026-08-25 (a real CONFLICT correctly caught and resolved
// on a test card). Enabled now; metadata.cover's shape is still a guess
// (see the fallback noted on writeCardContent in yoto.ts).
const COVER_ART_ENABLED = true;

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

/** Selection + hash of what a card's content should be, per its podcast's rules. */
async function computeDesired(
  card: any,
  podcast: any,
  rules: Rules,
): Promise<{ tracks: CardTrack[]; desiredHash: string; coverImageUrl?: string }> {
  const d = await getDb();
  // Manual mode: the user's own choices are the whole selection, uncapped —
  // `keep` is only an advisory number shown in the episode picker there.
  const ready =
    rules.keepMode === "manual"
      ? await d.select<any[]>(
          `SELECT * FROM episodes
           WHERE podcast_id=$1 AND transcoded_sha256 IS NOT NULL AND state != 'EXCLUDED'
           ORDER BY published_at DESC`,
          [podcast.id],
        )
      : await d.select<any[]>(
          `SELECT * FROM episodes
           WHERE podcast_id=$1 AND transcoded_sha256 IS NOT NULL AND state != 'EXCLUDED'
           ORDER BY published_at DESC LIMIT $2`,
          [podcast.id, rules.keep],
        );
  if (rules.order === "oldest-first") ready.reverse();
  const tracks: CardTrack[] = ready.map((ep) => ({
    title: ep.title,
    transcodedSha256: ep.transcoded_sha256,
    durationSeconds: ep.transcoded_duration_seconds ?? ep.duration_seconds ?? undefined,
    fileSizeBytes: ep.transcoded_file_size ?? undefined,
    channels: ep.transcoded_channels ?? undefined,
    format: ep.transcoded_format ?? undefined,
  }));
  const coverImageUrl = COVER_ART_ENABLED
    ? await ensureCoverImageUrl(card, podcast.artwork_url ?? null)
    : undefined;
  const desiredHash = await hashDesired(tracks, coverImageUrl ?? null);
  return { tracks, desiredHash, coverImageUrl };
}

/**
 * Reuse the podcast's own RSS artwork as the card cover. Caches the upload
 * by source URL so a sync only re-uploads it when the artwork actually
 * changes, not on every sync. A failed upload doesn't block the episode
 * sync — cover art is cosmetic — it just falls back to whatever cover
 * reference (if any) is already cached and logs why.
 * The `cover_media_id` column holds the resolved `metadata.cover` value —
 * currently the upload's CDN `mediaUrl` (see the note on `writeCardContent`
 * in yoto.ts for why), despite the column's name.
 */
async function ensureCoverImageUrl(card: any, artworkUrl: string | null): Promise<string | undefined> {
  if (!artworkUrl) return undefined;
  // cover_source_url matching means this exact URL was already attempted —
  // whether that attempt succeeded (cover_media_id set) or failed
  // (cover_media_id still NULL). Either way, don't retry every job tick; a
  // genuinely new artwork URL is what re-triggers an attempt.
  if (card.cover_source_url === artworkUrl) return card.cover_media_id || undefined;
  const d = await getDb();
  try {
    const coverImageUrl = await uploadCoverImage(artworkUrl);
    await d.execute(`UPDATE cards SET cover_media_id=$2, cover_source_url=$3 WHERE id=$1`, [
      card.id,
      coverImageUrl,
      artworkUrl,
    ]);
    card.cover_media_id = coverImageUrl;
    card.cover_source_url = artworkUrl;
    return coverImageUrl;
  } catch (e: any) {
    await d.execute(`UPDATE cards SET cover_source_url=$2 WHERE id=$1`, [card.id, artworkUrl]);
    card.cover_source_url = artworkUrl;
    await logEvent("warning", `Couldn't set cover art for "${card.title}": ${e?.message ?? e}`, {
      entityType: "card",
      entityId: card.id,
    });
    return card.cover_media_id || undefined;
  }
}

async function syncCard({ cardId }: { cardId: string }): Promise<void> {
  const d = await getDb();
  const [card] = await d.select<any[]>(`SELECT * FROM cards WHERE id=$1`, [cardId]);
  if (!card) return;
  // A detected conflict is only cleared by the user via resolveConflict —
  // routine rescans must not silently re-decide it.
  if (card.sync_state === "CONFLICT") return;
  const [p] = await d.select<any[]>(`SELECT * FROM podcasts WHERE id=$1`, [card.podcast_id]);
  const rules: Rules = { ...DEFAULT_RULES, ...JSON.parse(p?.rules_json ?? "{}") };
  const { tracks, desiredHash, coverImageUrl } = await computeDesired(card, p, rules);
  if (!tracks.length) return;
  if (desiredHash === card.confirmed_hash) return; // nothing changed locally — skip the remote check

  // SPEC §5: never blindly overwrite. Fetch what's actually live and compare
  // it against the baseline we recorded after our own last write; a mismatch
  // means it was edited outside this app. No remote_content_id yet means
  // this card has never been written, so there's nothing to conflict with.
  const remoteHash = card.remote_content_id
    ? await hashRemoteOrNull(card.remote_content_id)
    : undefined;
  const action = decideSyncAction({
    desiredHash,
    confirmedHash: card.confirmed_hash,
    remoteBaselineHash: card.confirmed_remote_hash,
    remoteHash,
  });

  if (action === "card-missing") {
    await d.execute(`UPDATE cards SET sync_state='NEEDS_ATTENTION' WHERE id=$1`, [cardId]);
    await logEvent(
      "error",
      `Card "${card.title}" was deleted on Yoto — can't sync (E_YOTO_CARD_MISSING)`,
      { entityType: "card", entityId: cardId, supportCode: "E_YOTO_CARD_MISSING" },
    );
    return;
  }
  if (action === "conflict") {
    await d.execute(
      `UPDATE cards SET sync_state='CONFLICT', pending_desired_hash=$2 WHERE id=$1`,
      [cardId, desiredHash],
    );
    await logEvent(
      "warning",
      `Card "${card.title}" was changed in the Yoto app — resolve before it syncs again`,
      { entityType: "card", entityId: cardId },
    );
    return;
  }
  await writeDesiredState(cardId, card, tracks, desiredHash, coverImageUrl);
}

async function writeDesiredState(
  cardId: string,
  card: any,
  tracks: CardTrack[],
  desiredHash: string,
  coverImageUrl?: string,
): Promise<void> {
  const d = await getDb();
  await d.execute(`UPDATE cards SET sync_state='SYNCING' WHERE id=$1`, [cardId]);
  try {
    const res = await writeCardContent({
      contentId: card.remote_content_id ?? undefined,
      title: card.title,
      tracks,
      coverImageUrl,
    });
    if (!res.cardId) {
      throw new Error(`content write returned no card id (E_YOTO_CONTENT_SHAPE)`);
    }
    // Re-fetch what actually landed rather than trusting our own request —
    // Yoto may normalize fields, and this becomes the baseline the next
    // conflict check compares against. A NULL baseline reads as "no prior
    // baseline" (adopt-silently), so recording one here on a failed re-fetch
    // would turn conflict detection off for this card without telling
    // anyone — throw instead and let the existing catch mark NEEDS_ATTENTION.
    const remote = await getContent(res.cardId);
    if (!remote) {
      throw new Error(`card vanished immediately after write (E_YOTO_GET_CONTENT)`);
    }
    const remoteHash = await hashRemoteChapters(remote.chapters);
    await d.execute(
      `UPDATE cards SET remote_content_id=$2, desired_hash=$3, confirmed_hash=$3,
         confirmed_remote_hash=$4, sync_state='IN_SYNC', last_synced_at=$5,
         pending_desired_hash=NULL WHERE id=$1`,
      [cardId, res.cardId, desiredHash, remoteHash, now()],
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

/**
 * User's decision on a detected conflict (SPEC §5): "keep-mine" leaves the
 * card exactly as the user left it in the Yoto app and accepts that as the
 * new baseline; "let-app-manage" overwrites it with this app's own desired
 * state. Either way clears CONFLICT so routine syncs resume afterward.
 */
export async function resolveConflict(
  cardId: string,
  choice: "keep-mine" | "let-app-manage",
): Promise<void> {
  const d = await getDb();
  const [card] = await d.select<any[]>(`SELECT * FROM cards WHERE id=$1`, [cardId]);
  if (!card || card.sync_state !== "CONFLICT") return;

  if (choice === "let-app-manage") {
    const [p] = await d.select<any[]>(`SELECT * FROM podcasts WHERE id=$1`, [card.podcast_id]);
    const rules: Rules = { ...DEFAULT_RULES, ...JSON.parse(p?.rules_json ?? "{}") };
    const { tracks, desiredHash, coverImageUrl } = await computeDesired(card, p, rules);
    if (!tracks.length) {
      await d.execute(`UPDATE cards SET sync_state='IN_SYNC', pending_desired_hash=NULL WHERE id=$1`, [
        cardId,
      ]);
      return;
    }
    await writeDesiredState(cardId, card, tracks, desiredHash, coverImageUrl);
    return;
  }

  // keep-mine: adopt whatever is live on Yoto right now as the new baseline,
  // and record this podcast's current desired state as if we'd already
  // written it — otherwise the very next routine sync would recompute the
  // same desired state, see it doesn't match confirmed_hash, and silently
  // overwrite the change the user just chose to keep.
  const remote = card.remote_content_id ? await getContent(card.remote_content_id) : null;
  if (!remote) {
    // Nothing to "keep" — either never written, or deleted on Yoto since the
    // conflict was flagged. Leave CONFLICT state alone rather than writing a
    // NULL baseline, which would silently turn detection off for this card.
    await d.execute(`UPDATE cards SET sync_state='NEEDS_ATTENTION' WHERE id=$1`, [cardId]);
    await logEvent(
      "error",
      `Card "${card.title}" was deleted on Yoto — nothing to keep (E_YOTO_CARD_MISSING)`,
      { entityType: "card", entityId: cardId, supportCode: "E_YOTO_CARD_MISSING" },
    );
    return;
  }
  const remoteHash = await hashRemoteChapters(remote.chapters);
  await d.execute(
    `UPDATE cards SET confirmed_hash=COALESCE(pending_desired_hash, confirmed_hash),
       confirmed_remote_hash=$2, sync_state='IN_SYNC', pending_desired_hash=NULL WHERE id=$1`,
    [cardId, remoteHash],
  );
  await logEvent("sync", `Kept your Yoto app changes to "${card.title}"`, {
    entityType: "card",
    entityId: cardId,
  });
}

export type SyncAction = "write" | "conflict" | "card-missing" | "noop";

/**
 * Pure decision of what to do given the local desired state, our own record
 * of what we last confirmed on both sides, and what's actually live now.
 * `remoteHash === undefined` means there's no remote card yet (first write —
 * nothing to conflict with); `remoteHash === null` means the card existed
 * before but is now gone (404). `remoteBaselineHash === null` means we have
 * no prior baseline to compare against (e.g. a pre-migration card) — treated
 * as "adopt now, don't flag," matching SPEC's intent of never blocking a
 * currently-fine card on its first check under this feature.
 */
export function decideSyncAction(params: {
  desiredHash: string;
  confirmedHash: string | null;
  remoteBaselineHash: string | null;
  remoteHash: string | null | undefined;
}): SyncAction {
  if (params.desiredHash === params.confirmedHash) return "noop";
  if (params.remoteHash === undefined) return "write";
  if (params.remoteHash === null) return "card-missing";
  if (params.remoteBaselineHash !== null && params.remoteHash !== params.remoteBaselineHash) {
    return "conflict";
  }
  return "write";
}

async function hashRemoteOrNull(contentId: string): Promise<string | null> {
  const remote = await getContent(contentId);
  return remote ? hashRemoteChapters(remote.chapters) : null;
}

/**
 * Hash Yoto's own returned chapters, not what we sent — both sides of every
 * comparison go through this, so server-side normalization (e.g. filled-in
 * defaults) never looks like drift. Only projects down to the fields this
 * app actually writes (title/trackUrl/format/duration/fileSize) — the raw
 * response may carry fields this app doesn't control (icons, play state,
 * timestamps) that could change on their own and would otherwise register
 * as a false conflict on every sync.
 */
async function hashRemoteChapters(chapters: unknown): Promise<string> {
  return sha256Hex(JSON.stringify(normalizeChaptersForHash(chapters)));
}

function normalizeChaptersForHash(chapters: unknown): unknown {
  if (!Array.isArray(chapters)) return chapters;
  return chapters.map((c: any) => ({
    title: c?.title,
    tracks: Array.isArray(c?.tracks)
      ? c.tracks.map((t: any) => ({
          title: t?.title,
          trackUrl: t?.trackUrl,
          format: t?.format,
          duration: t?.duration,
          fileSize: t?.fileSize,
        }))
      : c?.tracks,
  }));
}

async function hashDesired(tracks: CardTrack[], coverImageUrl: string | null): Promise<string> {
  // Only append the cover segment when there is one, so a card with no
  // artwork keeps hashing exactly as it did before this field existed —
  // no format-change resync (and no interference with the conflict-check
  // baseline) for cards this doesn't apply to.
  const coverPart = coverImageUrl ? `::cover=${coverImageUrl}` : "";
  const input =
    tracks
      .map((t) => `${t.transcodedSha256}:${t.title}:${t.durationSeconds}:${t.fileSizeBytes}:${t.channels}:${t.format}`)
      .join("|") + coverPart;
  return sha256Hex(input);
}

async function sha256Hex(input: string): Promise<string> {
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

async function resolveJobTitle(d: Database, payload: any): Promise<string> {
  if (payload.episodeId) {
    const [ep] = await d.select<any[]>(`SELECT title FROM episodes WHERE id=$1`, [payload.episodeId]);
    return ep?.title ?? "";
  }
  if (payload.cardId) {
    const [c] = await d.select<any[]>(`SELECT title FROM cards WHERE id=$1`, [payload.cardId]);
    return c?.title ?? "";
  }
  if (payload.podcastId) {
    const [p] = await d.select<any[]>(`SELECT title FROM podcasts WHERE id=$1`, [payload.podcastId]);
    return p?.title ?? "";
  }
  return "";
}

export type ActivityLine = { text: string; isRetry: boolean };

/**
 * Human-readable description of what's currently running or stuck retrying,
 * for the status bar. A PENDING job with no recorded error yet is a normal,
 * brief wait for its turn and isn't detailed here — only jobs that have
 * already failed at least once (a `last_error`) get surfaced, since those
 * are exactly the ones that otherwise look like an unexplained stuck queue.
 */
export async function getCurrentActivity(): Promise<ActivityLine[]> {
  const d = await getDb();
  const jobs = await d.select<
    {
      type: JobType;
      payload_json: string;
      state: "RUNNING" | "PENDING";
      last_error: string | null;
      next_run_at: string;
      attempts: number;
      max_attempts: number;
    }[]
  >(
    `SELECT type, payload_json, state, last_error, next_run_at, attempts, max_attempts FROM jobs
     WHERE state='RUNNING' OR (state='PENDING' AND last_error IS NOT NULL)
     ORDER BY created_at`,
  );
  const lines: ActivityLine[] = [];
  for (const job of jobs) {
    const payload = JSON.parse(job.payload_json);
    const title = await resolveJobTitle(d, payload);
    const label = title ? `${ACTIVITY_LABEL[job.type]} "${title}"` : ACTIVITY_LABEL[job.type];
    if (job.state === "RUNNING") {
      lines.push({ text: label, isRetry: false });
      continue;
    }
    const code = job.last_error?.match(/\(E_[A-Z_]+\)/)?.[0] ?? "(E_UNKNOWN)";
    const secondsLeft = Math.max(
      0,
      Math.round((new Date(job.next_run_at).getTime() - Date.now()) / 1000),
    );
    lines.push({
      text: `${label} — retrying after an error ${code} (attempt ${job.attempts}/${job.max_attempts}, next try in ${secondsLeft}s)`,
      isRetry: true,
    });
  }
  return lines;
}
