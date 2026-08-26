import { useEffect, useState } from "react";
import { getDb, now, uuid } from "../lib/db";
import { fetchFeed, FeedPreview } from "../lib/feeds";
import { enqueue } from "../lib/jobs";
import { detectDirection } from "../lib/text";
import { DEFAULT_RULES, removePodcast } from "../lib/pipeline";
import { DEFAULT_SCAN_INTERVAL_HOURS } from "../config";

export default function Podcasts({ onOpenPodcast }: { onOpenPodcast: (id: string) => void }) {
  const [podcasts, setPodcasts] = useState<any[]>([]);
  const [url, setUrl] = useState("");
  const [preview, setPreview] = useState<FeedPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

  async function handleRemove(p: any) {
    if (
      !confirm(
        `Remove "${p.title}"? This deletes it and its downloaded episodes from this app. ` +
          `It does NOT delete the card content already on your Yoto account.`,
      )
    ) {
      return;
    }
    await removePodcast(p.id);
    await refresh();
  }

  return (
    <div>
      <h2>Podcasts</h2>
      <div className="card">
        <strong>Add a podcast</strong>
        <div className="row" style={{ marginTop: 10 }}>
          <input
            type="url"
            placeholder="Paste an RSS feed link…"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
          />
          <button className="primary" disabled={!url || busy} onClick={loadPreview}>
            {busy ? "Checking…" : "Preview"}
          </button>
        </div>
        {error && <p className="error">{error}</p>}
        {preview && (
          <div style={{ marginTop: 12 }}>
            <div className="card--row">
              {preview.artworkUrl && <img className="artwork" src={preview.artworkUrl} alt="" />}
              <div className="card-text">
                <strong dir={detectDirection(preview.title)}>{preview.title}</strong>
                <p className="muted">{preview.episodes.length} episodes found. Latest:</p>
              </div>
            </div>
            <ul>
              {preview.episodes.slice(0, 5).map((e, i) => (
                <li key={i} dir={detectDirection(e.title)}>{e.title}</li>
              ))}
            </ul>
            <button className="primary" onClick={confirmAdd}>
              Add “{preview.title}”
            </button>
          </div>
        )}
      </div>
      {podcasts.map((p) => (
        <div className="card card--row" key={p.id}>
          {p.artwork_url && <img className="artwork" src={p.artwork_url} alt="" />}
          <div className="card-text">
            <strong dir={detectDirection(p.title)}>{p.title}</strong>
            <p className="muted">
              {p.health === "ok" ? "Healthy" : "Needs attention"} · checks every{" "}
              {p.scan_interval_hours}h
            </p>
            <div className="row" style={{ marginTop: 10 }}>
              <button onClick={() => enqueue("scan-feed", { podcastId: p.id })}>
                Check now
              </button>
              <button onClick={() => onOpenPodcast(p.id)}>Choose episodes</button>
              <button className="danger" onClick={() => handleRemove(p)}>
                Remove
              </button>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
