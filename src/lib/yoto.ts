// Yoto API client (SPEC.md §5). Endpoints per https://yoto.dev/myo/uploading-to-cards/
// Upload flow: uploadUrl → PUT file → poll transcoded → POST /content.
import { fetch } from "@tauri-apps/plugin-http";
import { readFile } from "@tauri-apps/plugin-fs";
import { YOTO_API_BASE } from "../config";
import { getAccessToken } from "./oauth";

async function api(path: string, init: RequestInit = {}): Promise<Response> {
  const token = await getAccessToken();
  const res = await fetch(`${YOTO_API_BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      ...(init.headers ?? {}),
    },
  });
  if (res.status === 429) {
    const retryAfter = parseInt(res.headers.get("Retry-After") ?? "30", 10);
    const err: any = new Error(`Rate limited (E_RATE_LIMIT)`);
    err.retryAfterSeconds = retryAfter;
    throw err;
  }
  return res;
}

export type TranscodedInfo = {
  transcodedSha256: string;
  transcodedInfo?: {
    duration?: number;
    fileSize?: number;
    channels?: string;
    format?: string;
  };
};

/** Step 1+2: get a temporary upload URL and PUT the local file to it. */
export async function uploadEpisode(localPath: string): Promise<string> {
  const res = await api(`/media/transcode/audio/uploadUrl`);
  if (!res.ok) throw new Error(`uploadUrl failed: ${res.status} (E_YOTO_UPLOADURL)`);
  const { upload } = (await res.json()) as {
    upload: { uploadUrl: string; uploadId: string };
  };
  const bytes = await readFile(localPath);
  const put = await fetch(upload.uploadUrl, {
    method: "PUT",
    headers: { "Content-Type": "audio/mpeg" },
    body: new Uint8Array(bytes),
  });
  if (!put.ok) throw new Error(`upload PUT failed: ${put.status} (E_YOTO_PUT)`);
  return upload.uploadId;
}

/** Step 3: poll until Yoto finishes server-side transcoding. */
export async function waitForTranscode(
  uploadId: string,
  { intervalMs = 3000, timeoutMs = 10 * 60 * 1000 } = {},
): Promise<TranscodedInfo> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await api(`/media/upload/${uploadId}/transcoded?loudnorm=false`);
    if (res.ok) {
      const body = (await res.json()) as { transcode?: TranscodedInfo };
      if (body.transcode?.transcodedSha256) return body.transcode;
    } else if (res.status !== 404 && res.status !== 202) {
      throw new Error(`transcode poll failed: ${res.status} (E_YOTO_TRANSCODE)`);
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error("Yoto transcoding timed out (E_YOTO_TRANSCODE_TIMEOUT)");
}

export type CardTrack = {
  title: string;
  transcodedSha256: string;
  durationSeconds?: number;
  fileSizeBytes?: number;
  format?: string;
  channels?: number;
};

/**
 * Upload a cover image by URL — used to reuse the podcast's own RSS artwork
 * as the card cover instead of asking the user to supply one separately.
 * The upload itself is confirmed working live (2026-08-25). Returns the CDN
 * `mediaUrl` — the `yoto:#<mediaId>` reference (the same scheme tracks use)
 * was tried first and confirmed live to produce a blank cover in the Yoto
 * app; `mediaUrl` is the fallback per yoto.dev's response shape.
 */
export async function uploadCoverImage(imageUrl: string): Promise<string> {
  const res = await api(
    `/media/coverImage/user/me/upload?imageUrl=${encodeURIComponent(imageUrl)}&coverType=myo`,
    { method: "POST" },
  );
  if (!res.ok) throw new Error(`cover upload failed: ${res.status} (E_YOTO_COVER_UPLOAD)`);
  const json = (await res.json()) as { coverImage?: { mediaUrl?: string } };
  if (!json.coverImage?.mediaUrl) {
    throw new Error(`cover upload response missing mediaUrl (E_YOTO_COVER_UPLOAD_SHAPE)`);
  }
  return json.coverImage.mediaUrl;
}

/**
 * Step 4: create or update the playlist/card content object.
 * One chapter per track (podcast-episode model: skip = next episode).
 * Pass `contentId` to update an existing card's content.
 */
export async function writeCardContent(opts: {
  contentId?: string;
  title: string;
  tracks: CardTrack[];
  coverImageUrl?: string;
}): Promise<{ cardId: string }> {
  const chapters = opts.tracks.map((t, i) => {
    const key = String(i + 1).padStart(2, "0");
    return {
      key,
      title: t.title,
      overlayLabel: String(i + 1),
      tracks: [
        {
          key,
          title: t.title,
          trackUrl: `yoto:#${t.transcodedSha256}`,
          type: "audio",
          format: t.format ?? "aac",
          duration: t.durationSeconds,
          fileSize: t.fileSizeBytes,
          channels: t.channels,
        },
      ],
    };
  });
  const body = {
    ...(opts.contentId ? { cardId: opts.contentId } : {}),
    title: opts.title,
    content: { chapters },
    metadata: {
      media: {
        duration: opts.tracks.reduce((s, t) => s + (t.durationSeconds ?? 0), 0),
        fileSize: opts.tracks.reduce((s, t) => s + (t.fileSizeBytes ?? 0), 0),
      },
      // Shape unverified against the live API (yoto.dev doesn't document
      // it). `imageL` as a `yoto:#<mediaId>` reference (the same scheme
      // tracks use) was tried first and confirmed live to render a blank
      // cover in the Yoto app; this is the second guess (the CDN URL
      // straight from the upload response).
      ...(opts.coverImageUrl ? { cover: { imageL: opts.coverImageUrl } } : {}),
    },
  };
  const res = await api(`/content`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`content write failed: ${res.status} (E_YOTO_CONTENT)`);
  }
  const json = (await res.json()) as { card?: { cardId: string } };
  return { cardId: json.card?.cardId ?? opts.contentId ?? "" };
}

/**
 * Fetch a card's current live content (SPEC.md §5 conflict detection).
 * Returns null if the card no longer exists on Yoto (deleted remotely).
 */
export async function getContent(
  cardId: string,
): Promise<{ chapters: unknown } | null> {
  const res = await api(`/content/${cardId}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`get content failed: ${res.status} (E_YOTO_GET_CONTENT)`);
  const json = (await res.json()) as { card?: { content?: { chapters?: unknown } } };
  if (json.card?.content?.chapters === undefined) {
    // Don't default to []: that hashes to a stable value and conflict
    // detection would read a shape mismatch as "no drift, forever."
    throw new Error(`get content response missing chapters (E_YOTO_GET_CONTENT_SHAPE)`);
  }
  return { chapters: json.card.content.chapters };
}

/** List the user's MYO content (for the card picker + conflict detection). */
export async function listMyoContent(): Promise<
  { cardId: string; title: string; updatedAt?: string }[]
> {
  const res = await api(`/content/mine`);
  if (!res.ok) throw new Error(`list content failed: ${res.status} (E_YOTO_LIST)`);
  const json = (await res.json()) as any;
  const cards = json.cards ?? json.content ?? [];
  return cards.map((c: any) => ({
    cardId: c.cardId ?? c.id,
    title: c.title,
    updatedAt: c.updatedAt,
  }));
}
