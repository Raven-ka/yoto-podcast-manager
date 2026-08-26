// Manual export package (SPEC.md §5 "Manual export fallback" / §17): a
// folder of the podcast's original downloaded audio, properly named, plus
// artwork and a plain-text manifest with manual-upload instructions. This
// is the "get my data out" guarantee — it works from local data only, no
// Yoto API call is made.
import { mkdir, copyFile, writeFile, writeTextFile, stat } from "@tauri-apps/plugin-fs";
import { fetch } from "@tauri-apps/plugin-http";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { appDataDir, join } from "@tauri-apps/api/path";
import { getDb } from "./db";
import { DEFAULT_RULES, Rules, selectDesiredEpisodes } from "./pipeline";

function sanitizeFilename(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, "_").trim();
}

/**
 * Export a podcast's currently-desired episode set (same selection/order as
 * the card sync) to $APPDATA/exports/<podcast>-<date>/, then reveal that
 * folder in Finder. Returns the export directory path.
 */
export async function exportPodcast(podcastId: string): Promise<string> {
  const d = await getDb();
  const [p] = await d.select<any[]>(`SELECT * FROM podcasts WHERE id=$1`, [podcastId]);
  if (!p) throw new Error("Podcast not found (E_EXPORT_NOT_FOUND)");
  const rules: Rules = { ...DEFAULT_RULES, ...JSON.parse(p.rules_json ?? "{}") };
  const episodes = await selectDesiredEpisodes(podcastId, rules);

  const dirName = `${sanitizeFilename(p.title) || "podcast"}-${new Date().toISOString().slice(0, 10)}`;
  const exportDir = await join(await appDataDir(), "exports", dirName);
  await mkdir(exportDir, { recursive: true });

  const manifest: string[] = [
    `${p.title} — manual export`,
    `Generated ${new Date().toLocaleString()}`,
    "",
    "These are the ORIGINAL downloaded audio files, not what plays on a Yoto",
    "card — Yoto transcodes audio server-side (to Opus) when you upload, and",
    "that transcoded copy isn't available for download. Uploading these",
    "originals through Yoto's own app or my.yotoplay.com re-runs that same",
    "transcode, so playback matches what this app would have produced.",
    "",
    "To use: open the Yoto app or my.yotoplay.com, create or edit a Make Your",
    "Own card, and upload these files in the numbered order below.",
    "",
    "This covers what's currently on (or due for) the card per this",
    "podcast's rules — not every file ever downloaded. An episode that was",
    "downloaded but never finished uploading to Yoto isn't included here.",
    "",
  ];

  let n = 0;
  let missing = 0;
  for (const ep of episodes) {
    n++;
    const idx = String(n).padStart(2, "0");
    const [file] = await d.select<any[]>(
      `SELECT * FROM files WHERE episode_id=$1 ORDER BY downloaded_at DESC LIMIT 1`,
      [ep.id],
    );
    if (!file) {
      missing++;
      manifest.push(`${idx}. [MISSING — not downloaded locally] ${ep.title}`);
      continue;
    }
    const dot = file.path.lastIndexOf(".");
    const ext = dot >= 0 ? file.path.slice(dot) : "";
    const destName = `${idx} - ${sanitizeFilename(ep.title) || ep.id}${ext}`;
    const destPath = await join(exportDir, destName);
    await copyFile(file.path, destPath);
    // Don't trust the copy just because it didn't throw — confirm the file
    // actually landed with real content before listing it as present. A
    // capability scope rejection on just one side of the copy wouldn't
    // necessarily throw in a way that's obvious from here.
    const info = await stat(destPath).catch(() => null);
    if (!info || info.size === 0) {
      missing++;
      manifest.push(`${idx}. [MISSING — copy failed] ${ep.title}`);
      continue;
    }
    manifest.push(`${idx}. ${destName}`);
  }

  if (p.artwork_url) {
    try {
      const res = await fetch(p.artwork_url);
      if (res.ok) {
        const bytes = new Uint8Array(await res.arrayBuffer());
        const ext = p.artwork_url.split("?")[0].match(/\.\w+$/)?.[0] ?? ".jpg";
        await writeFile(await join(exportDir, `artwork${ext}`), bytes);
        manifest.push("", `Artwork: artwork${ext}`);
      }
    } catch {
      // Cosmetic — the export is still complete and usable without it.
    }
  }

  if (missing > 0) {
    manifest.push(
      "",
      `${missing} episode(s) above are marked MISSING — their original file`,
      "isn't on disk (never downloaded, or removed by this app's cleanup job",
      "after being unwanted for 30+ days). Re-include them in Podcast",
      "Manager to re-download, then export again.",
    );
  }

  await writeTextFile(await join(exportDir, "manifest.txt"), manifest.join("\n"));
  await revealItemInDir(exportDir);
  return exportDir;
}
