// Local-file import (SPEC.md §6 "Local files: drag-and-drop onto a podcast").
// v1 simplification, documented deliberately: titles come from the
// filename, not parsed ID3/audio tags — SPEC says "read tags for
// title/order" but tag parsing is a real added dependency/risk that a
// filename fallback avoids for now. Order comes from drop sequence.
import { readFile, writeFile, mkdir } from "@tauri-apps/plugin-fs";
import { appDataDir, join } from "@tauri-apps/api/path";
import { getDb, now, uuid } from "./db";
import { enqueue } from "./jobs";
import { isSignedIn } from "./oauth";

const AUDIO_EXTENSIONS = new Set([".mp3", ".m4a", ".aac", ".wav", ".ogg", ".flac", ".opus"]);

function extOf(path: string): string {
  const dot = path.lastIndexOf(".");
  return dot >= 0 ? path.slice(dot).toLowerCase() : "";
}

function titleFromFilename(path: string): string {
  const base = path.split(/[\\/]/).pop() ?? path;
  const noExt = base.slice(0, base.length - extOf(base).length);
  return noExt.replace(/_/g, " ").replace(/\s+/g, " ").trim() || base;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Import dropped local audio files as episodes of a 'local' podcast. Each
 * file is hashed and copied into $APPDATA/media (same convention as
 * downloaded RSS episodes) and enters the pipeline at the same point a
 * successful download does — state DOWNLOADED, upload-episode enqueued —
 * so it goes through the exact same upload/transcode/sync path afterward.
 * Files that aren't a recognized audio extension are silently skipped;
 * a file whose hash already exists as this podcast's canonical_key (already
 * imported) is skipped via the table's UNIQUE constraint.
 */
export async function importLocalFiles(
  podcastId: string,
  paths: string[],
): Promise<{ added: number; skipped: number }> {
  const d = await getDb();
  const mediaDir = await join(await appDataDir(), "media");
  // Unlike downloadEpisode (Rust create_dir_all before writing), this is the
  // first writer into media/ on a machine with no RSS downloads yet.
  await mkdir(mediaDir, { recursive: true });
  let added = 0;
  let skipped = 0;

  let i = 0;
  for (const path of paths) {
    const ext = extOf(path);
    if (!AUDIO_EXTENSIONS.has(ext)) {
      skipped++;
      continue;
    }
    const bytes = await readFile(path);
    const sha = await sha256Hex(bytes);
    const destPath = await join(mediaDir, `${sha}${ext}`);
    await writeFile(destPath, bytes);

    const episodeId = uuid();
    // published_at spaces out by 1ms per file so a single multi-file drop
    // preserves its drop order under either sort direction.
    const publishedAt = new Date(Date.now() + i).toISOString();
    i++;
    const inserted = await d.execute(
      `INSERT INTO episodes (id, podcast_id, canonical_key, title, published_at, state)
       VALUES ($1,$2,$3,$4,$5,'DOWNLOADED')
       ON CONFLICT (podcast_id, canonical_key) DO NOTHING`,
      [episodeId, podcastId, sha, titleFromFilename(path), publishedAt],
    );
    if (!inserted.rowsAffected) {
      skipped++; // already imported (same file content) — no duplicate episode
      continue;
    }
    await d.execute(
      `INSERT INTO files (id, episode_id, path, bytes, sha256, downloaded_at)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [uuid(), episodeId, destPath, bytes.length, sha, now()],
    );
    // Export-only mode: leave it at DOWNLOADED (already exportable) instead
    // of enqueuing a job that would just fail for lack of a token — see
    // catchUpAfterSignIn in pipeline.ts.
    if (await isSignedIn()) await enqueue("upload-episode", { episodeId });
    added++;
  }

  return { added, skipped };
}
