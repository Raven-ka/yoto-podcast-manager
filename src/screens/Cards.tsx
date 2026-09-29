import { useEffect, useState } from "react";
import { ask, message } from "@tauri-apps/plugin-dialog";
import { getDb } from "../lib/db";
import { enqueue } from "../lib/jobs";
import { removeCard, resolveConflict } from "../lib/pipeline";
import { detectDirection } from "../lib/text";
import { initialOf, tintFor } from "../lib/palette";

export default function Cards() {
  const [cards, setCards] = useState<any[]>([]);
  const [resolvingId, setResolvingId] = useState<string | null>(null);

  async function refresh() {
    const d = await getDb();
    setCards(
      await d.select<any[]>(
        `SELECT c.*, p.artwork_url, (SELECT COUNT(*) FROM episodes e
            WHERE e.podcast_id=c.podcast_id AND e.state='ON_CARD') AS on_card
         FROM cards c LEFT JOIN podcasts p ON p.id=c.podcast_id ORDER BY c.title`,
      ),
    );
  }
  useEffect(() => {
    void refresh();
    const t = setInterval(refresh, 5000);
    return () => clearInterval(t);
  }, []);

  async function handleRemove(c: any) {
    const confirmed = await ask(
      `Remove "${c.title}" from this app? This stops it from being synced here. ` +
        `It does NOT delete the card content already on your Yoto account.`,
      { title: "Remove card", kind: "warning" },
    );
    if (!confirmed) return;
    await removeCard(c.id);
    await refresh();
  }

  async function handleResolve(c: any, choice: "keep-mine" | "let-app-manage") {
    setResolvingId(c.id);
    try {
      await resolveConflict(c.id, choice);
    } catch (e: any) {
      await message(e.message, { title: "Couldn't resolve conflict", kind: "error" });
    } finally {
      await refresh();
      setResolvingId(null);
    }
  }

  const stateLabel: Record<string, string> = {
    IN_SYNC: "Up to date",
    OUT_OF_DATE: "Update pending",
    SYNCING: "Updating…",
    CONFLICT: "Changed in the Yoto app",
    NEEDS_ATTENTION: "Needs attention",
  };
  const stateChip: Record<string, string> = {
    IN_SYNC: "chip--ok",
    OUT_OF_DATE: "chip--warn",
    SYNCING: "chip--info",
    CONFLICT: "chip--bad",
    NEEDS_ATTENTION: "chip--bad",
  };

  return (
    <div className="page">
      <header className="page-header">
        <h2>Cards</h2>
        <p>Each podcast gets its own Make Your Own card.</p>
      </header>
      {cards.length === 0 && (
        <div className="empty">
          <strong>No cards yet</strong>
          Add a podcast first — its card appears here.
        </div>
      )}
      <div className="myo-grid">
        {cards.map((c) => (
          <div className={"myo-item " + tintFor(c.podcast_id ?? c.id)} key={c.id}>
            <div className="myo-card">
              <div className="myo-art">
                {c.artwork_url ? (
                  <img src={c.artwork_url} alt="" />
                ) : (
                  <span className="art-initial" aria-hidden="true">{initialOf(c.title)}</span>
                )}
              </div>
              <div className="myo-label" dir={detectDirection(c.title)}>{c.title}</div>
            </div>
            <div className="myo-meta">
              <span className={"chip " + (stateChip[c.sync_state] ?? "")}>
                {stateLabel[c.sync_state] ?? c.sync_state}
              </span>
              <p className="muted" style={{ margin: 0 }}>
                {c.on_card} episode(s) on card
                {c.last_synced_at && ` · updated ${new Date(c.last_synced_at).toLocaleString()}`}
              </p>
              {c.sync_state === "CONFLICT" ? (
                <>
                  <p className="muted error" style={{ margin: 0 }}>
                    Someone changed this card in the Yoto app since this app last updated it.
                    Choose how to proceed.
                  </p>
                  <button
                    className="primary small"
                    disabled={resolvingId === c.id}
                    onClick={() => handleResolve(c, "let-app-manage")}
                  >
                    Let this app manage the card
                  </button>
                  <button
                    className="small"
                    disabled={resolvingId === c.id}
                    onClick={() => handleResolve(c, "keep-mine")}
                  >
                    Keep my Yoto app changes
                  </button>
                </>
              ) : (
                <div className="row">
                  <button className="small" onClick={() => enqueue("sync-card", { cardId: c.id, force: true })}>
                    Sync now
                  </button>
                  <button className="small danger" onClick={() => handleRemove(c)}>
                    Remove
                  </button>
                </div>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
