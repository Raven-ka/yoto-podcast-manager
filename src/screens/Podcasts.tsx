import { useEffect, useState } from "react";
import { ask, message } from "@tauri-apps/plugin-dialog";
import { getDb, now, uuid } from "../lib/db";
import { fetchFeed, FeedPreview } from "../lib/feeds";
import { enqueue } from "../lib/jobs";
import { detectDirection } from "../lib/text";
import { initialOf, tintFor } from "../lib/palette";
import { DEFAULT_RULES, Rules, removePodcast } from "../lib/pipeline";
import { exportPodcast } from "../lib/export";
import { DEFAULT_SCAN_INTERVAL_HOURS } from "../config";

export default function Podcasts({ onOpenPodcast }: { onOpenPodcast: (id: string) => void }) {
  const [podcasts, setPodcasts] = useState<any[]>([]);
  const [url, setUrl] = useState("");
  const [preview, setPreview] = useState<FeedPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [exportingId, setExportingId] = useState<string | null>(null);
  const [localTitle, setLocalTitle] = useState("");

  async function refresh() {
    const d = await getDb();
    setPodcasts(await d.select<any[]>(`SELECT * FROM podcasts ORDER BY title`));
  }
  useEffect(() => void refresh(), []);

  async function loadPreview() {
    setBusy(true);
    setError(null);
    setPreview(null);
    try {
      setPreview(await fetchFeed(url.trim()));
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function confirmAdd() {
    if (!preview) return;
    const d = await getDb();
    const id = uuid();
    // Deliberately NOT storing preview.etag/lastModified here: the preview
    // fetch just hit the server, so seeding those would make the very first
    // scan-feed job get a 304 Not Modified and skip populating episodes
    // entirely. The real etag/lastModified get set after that first scan.
    await d.execute(
      `INSERT INTO podcasts (id,title,source_type,feed_url,artwork_url,rules_json,
         scan_interval_hours,created_at,updated_at)
       VALUES ($1,$2,'rss',$3,$4,$5,$6,$7,$7)`,
      [id, preview.title, url.trim(), preview.artworkUrl ?? null,
       JSON.stringify(DEFAULT_RULES), DEFAULT_SCAN_INTERVAL_HOURS, now()],
    );
    // Create the linked card record (user links/reorders on the Cards screen).
    await d.execute(
      `INSERT INTO cards (id, title, podcast_id) VALUES ($1,$2,$3)`,
      [uuid(), preview.title, id],
    );
    await enqueue("scan-feed", { podcastId: id });
    setPreview(null);
    setUrl("");
    await refresh();
  }

  async function confirmAddLocal() {
    const title = localTitle.trim();
    if (!title) return;
    const d = await getDb();
    const id = uuid();
    // No feed = no auto-discovery: every episode is a deliberate drop, so
    // manual mode (the user's own choices are authoritative) fits local
    // podcasts better than the RSS default of auto keep-N.
    const localRules: Rules = { ...DEFAULT_RULES, keepMode: "manual" };
    await d.execute(
      `INSERT INTO podcasts (id,title,source_type,rules_json,scan_interval_hours,created_at,updated_at)
       VALUES ($1,$2,'local',$3,$4,$5,$5)`,
      [id, title, JSON.stringify(localRules), DEFAULT_SCAN_INTERVAL_HOURS, now()],
    );
    await d.execute(`INSERT INTO cards (id, title, podcast_id) VALUES ($1,$2,$3)`, [
      uuid(),
      title,
      id,
    ]);
    setLocalTitle("");
    await refresh();
  }

  async function handleRemove(p: any) {
    // Native window.confirm() silently no-ops in this webview (returns
    // false without ever showing a dialog) — @tauri-apps/plugin-dialog's
    // ask() goes through Tauri's own IPC-driven dialog instead. See
    // CLAUDE.md: browser-native confirm/alert must not be used here.
    const confirmed = await ask(
      `Remove "${p.title}"? This deletes it and its downloaded episodes from this app. ` +
        `It does NOT delete the card content already on your Yoto account.`,
      { title: "Remove podcast", kind: "warning" },
    );
    if (!confirmed) return;
    await removePodcast(p.id);
    await refresh();
  }

  async function handleExport(p: any) {
    setExportingId(p.id);
    try {
      await exportPodcast(p.id);
    } catch (e: any) {
      await message(e.message, { title: "Export failed", kind: "error" });
    } finally {
      setExportingId(null);
    }
  }

  return (
    <div className="page">
      <header className="page-header">
        <h2>Podcasts</h2>
        <p>Add a show by its RSS link, or make your own from audio files.</p>
      </header>
      <div className="grid-2">
        <div className="card">
          <h3>Add a podcast</h3>
          <p className="muted">New episodes are picked up automatically.</p>
          <div className="row">
            <input
              type="url"
              aria-label="RSS feed link"
              placeholder="Paste an RSS feed link…"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
            />
            <button className="primary" disabled={!url || busy} onClick={loadPreview}>
              {busy ? "Checking…" : "Preview"}
            </button>
          </div>
          {error && <p className="error">{error}</p>}
        </div>
        <div className="card">
          <h3>Add local files</h3>
          <p className="muted">
            No RSS feed — you drag audio files in yourself. Create the podcast
            here, then open it to drop files onto it.
          </p>
          <div className="row">
            <input
              type="text"
              aria-label="Local podcast name"
              placeholder="Name (e.g. a kid's name, or the story collection)"
              value={localTitle}
              onChange={(e) => setLocalTitle(e.target.value)}
            />
            <button className="primary" disabled={!localTitle.trim()} onClick={confirmAddLocal}>
              Create
            </button>
          </div>
        </div>
      </div>
      {preview && (
        <div className="card" style={{ marginTop: 16 }}>
          <div className="card--row">
            {preview.artworkUrl && <img className="artwork artwork--lg" src={preview.artworkUrl} alt="" />}
            <div className="card-text">
              <h3 dir={detectDirection(preview.title)}>{preview.title}</h3>
              <p className="muted">{preview.episodes.length} episodes found. Latest:</p>
              <ul className="muted">
                {preview.episodes.slice(0, 5).map((e, i) => (
                  <li key={i} dir={detectDirection(e.title)}>{e.title}</li>
                ))}
              </ul>
            </div>
          </div>
          <div className="row">
            <button className="primary" onClick={confirmAdd}>
              Add “{preview.title}”
            </button>
            <button onClick={() => setPreview(null)}>Cancel</button>
          </div>
        </div>
      )}
      {podcasts.length > 0 && <h3 className="section-title">Your podcasts</h3>}
      <div className="tile-grid">
        {podcasts.map((p) => (
          <div className={"podcast-tile " + tintFor(p.id)} key={p.id}>
            <div className="tile-art">
              {p.artwork_url ? (
                <img src={p.artwork_url} alt="" />
              ) : (
                <span className="art-initial" aria-hidden="true">{initialOf(p.title)}</span>
              )}
            </div>
            <div className="tile-body">
              <strong dir={detectDirection(p.title)}>{p.title}</strong>
              {p.source_type === "local" ? (
                <span className="chip chip--plain">Local files</span>
              ) : (
                <span className={"chip " + (p.health === "ok" ? "chip--ok" : "chip--bad")}>
                  {p.health === "ok" ? "Healthy" : "Needs attention"} · every {p.scan_interval_hours}h
                </span>
              )}
              <div className="tile-actions">
                {p.source_type === "local" ? (
                  <button className="small" onClick={() => onOpenPodcast(p.id)}>Add / manage files</button>
                ) : (
                  <>
                    <button className="small" onClick={() => onOpenPodcast(p.id)}>Choose episodes</button>
                    <button className="small" onClick={() => enqueue("scan-feed", { podcastId: p.id })}>
                      Check now
                    </button>
                  </>
                )}
                <button className="small" disabled={exportingId === p.id} onClick={() => handleExport(p)}>
                  {exportingId === p.id ? "Exporting…" : "Export files"}
                </button>
                <button className="small danger" onClick={() => handleRemove(p)}>
                  Remove
                </button>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
