import { useEffect, useState } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getDb, now } from "../lib/db";
import { enqueue } from "../lib/jobs";
import { DEFAULT_RULES, setEpisodeIncluded, Rules } from "../lib/pipeline";
import { importLocalFiles } from "../lib/localImport";
import { detectDirection } from "../lib/text";
import { APPROX_CARD_TRACK_LIMIT, APPROX_CARD_BYTE_LIMIT } from "../config";

const STATE_LABEL: Record<string, string> = {
  DISCOVERED: "Not selected",
  INCLUDED: "Queued",
  DOWNLOADING: "Downloading…",
  DOWNLOADED: "Downloaded",
  UPLOADING: "Uploading…",
  ON_CARD: "On card",
  NEEDS_ATTENTION: "Needs attention",
  EXCLUDED: "Excluded",
};

// Anything past DISCOVERED/EXCLUDED is "selected for the card" in some form.
const SELECTED_STATES = new Set([
  "INCLUDED",
  "DOWNLOADING",
  "DOWNLOADED",
  "UPLOADING",
  "ON_CARD",
  "NEEDS_ATTENTION",
]);

export default function PodcastDetail({
  podcastId,
  onBack,
}: {
  podcastId: string;
  onBack: () => void;
}) {
  const [title, setTitle] = useState("");
  const [sourceType, setSourceType] = useState("rss");
  const [rules, setRules] = useState<Rules>(DEFAULT_RULES);
  const [episodes, setEpisodes] = useState<any[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [cardConflicted, setCardConflicted] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importMsg, setImportMsg] = useState<string | null>(null);

  async function refresh() {
    const d = await getDb();
    const [p] = await d.select<any[]>(
      `SELECT title, source_type, rules_json FROM podcasts WHERE id=$1`,
      [podcastId],
    );
    setTitle(p?.title ?? "");
    setSourceType(p?.source_type ?? "rss");
    setRules({ ...DEFAULT_RULES, ...JSON.parse(p?.rules_json ?? "{}") });
    setEpisodes(
      // Position-aware so a manual podcast's drag order (once set) is what
      // renders and what the move buttons operate on — episodes never
      // positioned (or podcasts that have never been reordered) fall back
      // to plain recency, same as before this ordering existed.
      await d.select<any[]>(
        `SELECT e.* FROM episodes e
         LEFT JOIN cards c ON c.podcast_id = e.podcast_id
         LEFT JOIN card_items ci ON ci.card_id = c.id AND ci.episode_id = e.id
         WHERE e.podcast_id=$1
         ORDER BY CASE WHEN ci.position IS NULL THEN 1 ELSE 0 END, ci.position, e.published_at DESC`,
        [podcastId],
      ),
    );
    const [c] = await d.select<any[]>(
      `SELECT sync_state FROM cards WHERE podcast_id=$1`,
      [podcastId],
    );
    setCardConflicted(c?.sync_state === "CONFLICT");
  }

  useEffect(() => {
    void refresh();
    const t = setInterval(refresh, 5000);
    return () => clearInterval(t);
  }, [podcastId]);

  // Webview-level event, not per-DOM-element — safe here because this
  // screen only ever shows one podcast at a time, so any drop while it's
  // mounted unambiguously means "add these files to this podcast."
  useEffect(() => {
    if (sourceType !== "local") return;
    let unlisten: (() => void) | undefined;
    void getCurrentWebview()
      .onDragDropEvent((event) => {
        if (event.payload.type === "drop") {
          setDragOver(false);
          setImporting(true);
          setImportMsg(null);
          importLocalFiles(podcastId, event.payload.paths)
            .then(({ added, skipped }) => {
              setImportMsg(
                `Added ${added} file(s)` + (skipped ? `, skipped ${skipped}` : "") + ".",
              );
              return refresh();
            })
            .catch((e: any) => setImportMsg(`Import failed: ${e.message}`))
            .finally(() => setImporting(false));
        } else if (event.payload.type === "enter" || event.payload.type === "over") {
          setDragOver(true);
        } else {
          setDragOver(false);
        }
      })
      .then((fn) => {
        unlisten = fn;
      });
    return () => unlisten?.();
  }, [podcastId, sourceType]);

  async function setAutoUpdate(autoUpdate: boolean) {
    const d = await getDb();
    const nextRules: Rules = { ...rules, autoUpdate };
    await d.execute(`UPDATE podcasts SET rules_json=$2, updated_at=$3 WHERE id=$1`, [
      podcastId,
      JSON.stringify(nextRules),
      now(),
    ]);
    setRules(nextRules);
  }

  // SPEC §17 "drag reorder" — implemented as move buttons rather than literal
  // drag-and-drop: Tauri v2 captures HTML5 drag events at the webview level
  // (already relied on above for OS file drops onto this screen), which
  // would make native in-page `draggable` reordering unreliable here.
  async function moveEpisode(epId: string, direction: -1 | 1) {
    const ids = selectedEpisodes.map((e) => e.id);
    const i = ids.indexOf(epId);
    const j = i + direction;
    if (i === -1 || j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    const d = await getDb();
    const [c] = await d.select<any[]>(`SELECT id FROM cards WHERE podcast_id=$1`, [podcastId]);
    if (!c) return;
    // Rewrite every position, not just the swapped pair — the first move on
    // a podcast with no card_items yet establishes the whole order at once.
    for (let k = 0; k < ids.length; k++) {
      await d.execute(
        `INSERT INTO card_items (card_id, episode_id, position) VALUES ($1,$2,$3)
         ON CONFLICT(card_id, episode_id) DO UPDATE SET position=excluded.position`,
        [c.id, ids[k], k],
      );
    }
    await enqueue("sync-card", { cardId: c.id });
    await refresh();
  }

  async function toggle(ep: any) {
    setBusyId(ep.id);
    try {
      await setEpisodeIncluded(ep.id, !SELECTED_STATES.has(ep.state));
      await refresh();
    } finally {
      setBusyId(null);
    }
  }

  const selectedEpisodes = episodes.filter((e) => SELECTED_STATES.has(e.state));
  const selected = selectedEpisodes.length;
  const totalBytes = selectedEpisodes.reduce(
    (sum, e) => sum + (e.transcoded_file_size ?? 0),
    0,
  );
  const trackPct = selected / APPROX_CARD_TRACK_LIMIT;
  const bytePct = totalBytes / APPROX_CARD_BYTE_LIMIT;
  // Whichever limit is closer is the one that actually matters right now.
  const byTracksIsBinding = trackPct >= bytePct;
  const pct = Math.min(100, Math.round(Math.max(trackPct, bytePct) * 100));
  const atCapacity = pct >= 100;
  const overCapacity = trackPct > 1 || bytePct > 1;
  const mb = (n: number) => (n / (1024 * 1024)).toFixed(0);

  return (
    <div>
      <button onClick={onBack} className="back-link">
        ← Back to Podcasts
      </button>
      <h2 dir={detectDirection(title)}>{title}</h2>
      <p className="muted">
        Choose which episodes should be uploaded to the card. Excluding an
        episode that's already on the card removes it right away.
      </p>

      {sourceType === "local" && (
        <div className={"card drop-zone" + (dragOver ? " drop-zone--active" : "")}>
          <strong>{importing ? "Importing…" : "Drop audio files here"}</strong>
          <p className="muted">
            MP3, M4A, AAC, WAV, OGG, FLAC, or Opus. Track titles come from the
            filename — rename the file first if you want a different title.
          </p>
          {importMsg && <p className="muted">{importMsg}</p>}
        </div>
      )}

      {cardConflicted && (
        <p className="muted error">
          This card was changed in the Yoto app and needs your decision before
          any change here reaches it — resolve it on the Cards screen first.
        </p>
      )}

      <div className="card">
        <label className="row" style={{ alignItems: "center", gap: 8 }}>
          <input
            type="checkbox"
            checked={!rules.autoUpdate}
            onChange={(e) => setAutoUpdate(!e.target.checked)}
          />
          Ask before updating the card (don't sync automatically)
        </label>
        {!rules.autoUpdate && (
          <p className="muted" style={{ marginTop: 6 }}>
            Changes here won't reach the card until you hit "Sync now" on the
            Cards screen.
          </p>
        )}
      </div>

      <div className="card capacity-card">
        <div className="row" style={{ justifyContent: "space-between" }}>
          <strong>
            {selected} / ~{APPROX_CARD_TRACK_LIMIT} episodes · ~{mb(totalBytes)} /{" "}
            ~{mb(APPROX_CARD_BYTE_LIMIT)} MB
          </strong>
          {rules.keepMode === "manual" && <span className="muted">Manual selection</span>}
        </div>
        <div className="progress-bar">
          <div
            className={"progress-fill" + (overCapacity ? " warning" : "")}
            style={{ width: `${pct}%` }}
          />
        </div>
        <p className="muted" style={{ marginTop: 6 }}>
          Yoto doesn't publish an exact per-card limit — this is based on
          SPEC's historical guideline (~{APPROX_CARD_TRACK_LIMIT} tracks / ~
          {mb(APPROX_CARD_BYTE_LIMIT)} MB), not a hard cutoff Yoto enforces.
        </p>
        {overCapacity && (
          <p className="muted error" style={{ marginTop: 6 }}>
            You're over the {byTracksIsBinding ? "episode-count" : "size"}{" "}
            guideline. This isn't blocked here, but if the card fails to sync,
            try excluding a few episodes.
          </p>
        )}
        {atCapacity && !overCapacity && (
          <p className="muted" style={{ marginTop: 6 }}>
            At the guideline limit — including another episode will go over it.
          </p>
        )}
      </div>

      <div className="episode-list">
        {episodes.map((ep) => {
          const included = SELECTED_STATES.has(ep.state);
          const canReorder = rules.keepMode === "manual" && included;
          const selIndex = canReorder ? selectedEpisodes.findIndex((e) => e.id === ep.id) : -1;
          return (
            <div className={"card episode-row" + (included ? "" : " excluded")} key={ep.id}>
              <div className="episode-info">
                <strong dir={detectDirection(ep.title)}>{ep.title}</strong>
                <p className="muted">
                  {ep.published_at && new Date(ep.published_at).toLocaleDateString()}
                  {" · "}
                  {STATE_LABEL[ep.state] ?? ep.state}
                </p>
              </div>
              <div className="row" style={{ gap: 6 }}>
                {canReorder && (
                  <>
                    <button
                      disabled={selIndex <= 0}
                      onClick={() => moveEpisode(ep.id, -1)}
                      aria-label="Move up"
                    >
                      ↑
                    </button>
                    <button
                      disabled={selIndex === -1 || selIndex >= selectedEpisodes.length - 1}
                      onClick={() => moveEpisode(ep.id, 1)}
                      aria-label="Move down"
                    >
                      ↓
                    </button>
                  </>
                )}
                <button
                  className={included ? "" : "primary"}
                  disabled={busyId === ep.id}
                  onClick={() => toggle(ep)}
                >
                  {included ? "Exclude" : "Include"}
                </button>
              </div>
            </div>
          );
        })}
        {episodes.length === 0 && <p className="muted">No episodes discovered yet.</p>}
      </div>
    </div>
  );
}
