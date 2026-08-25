import { useEffect, useState } from "react";
import { getDb } from "../lib/db";
import { DEFAULT_RULES, setEpisodeIncluded, Rules } from "../lib/pipeline";
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
  const [rules, setRules] = useState<Rules>(DEFAULT_RULES);
  const [episodes, setEpisodes] = useState<any[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);

  async function refresh() {
    const d = await getDb();
    const [p] = await d.select<any[]>(`SELECT title, rules_json FROM podcasts WHERE id=$1`, [
      podcastId,
    ]);
    setTitle(p?.title ?? "");
    setRules({ ...DEFAULT_RULES, ...JSON.parse(p?.rules_json ?? "{}") });
    setEpisodes(
      await d.select<any[]>(
        `SELECT * FROM episodes WHERE podcast_id=$1 ORDER BY published_at DESC`,
        [podcastId],
      ),
    );
  }

  useEffect(() => {
    void refresh();
    const t = setInterval(refresh, 5000);
    return () => clearInterval(t);
  }, [podcastId]);

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
              <button
                className={included ? "" : "primary"}
                disabled={busyId === ep.id}
                onClick={() => toggle(ep)}
              >
                {included ? "Exclude" : "Include"}
              </button>
            </div>
          );
        })}
        {episodes.length === 0 && <p className="muted">No episodes discovered yet.</p>}
      </div>
    </div>
  );
}
