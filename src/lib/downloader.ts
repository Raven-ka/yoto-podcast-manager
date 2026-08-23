// TS wrapper around the Rust safe-downloader command (SPEC.md §7).
import { invoke } from "@tauri-apps/api/core";
import { appDataDir, join } from "@tauri-apps/api/path";
import { DEFAULT_MAX_EPISODE_BYTES } from "../config";

export type DownloadResult = {
  path: string;
  bytes: number;
  sha256: string;
  final_url: string;
  content_type: string | null;
  redirect_chain: string[];
};

export async function downloadEpisode(
  url: string,
  opts: { maxBytes?: number; allowHttp?: boolean } = {},
): Promise<DownloadResult> {
  const destDir = await join(await appDataDir(), "media");
  return invoke<DownloadResult>("download_file", {
    url,
    destDir,
    maxBytes: opts.maxBytes ?? DEFAULT_MAX_EPISODE_BYTES,
    allowHttp: opts.allowHttp ?? false,
  });
}
