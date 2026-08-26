import { useEffect, useState } from "react";
import { ask, message } from "@tauri-apps/plugin-dialog";
import { getDb } from "../lib/db";
import { enqueue } from "../lib/jobs";
import { removeCard, resolveConflict } from "../lib/pipeline";
import { detectDirection } from "../lib/text";

export default function Cards() {
  const [cards, setCards] = useState<any[]>([]);
  const [resolvingId, setResolvingId] = useState<string | null>(null);

  async function refresh() {
    const d = await getDb();
    setCards(
      await d.select<any[]>(
        `SELECT c.*, (SELECT COUNT(*) FROM episodes e
            WHERE e.podcast_id=c.podcast_id AND e.state='ON_CARD') AS on_card
         FROM cards c ORDER BY c.title`,
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
    CONFLICT: "Changed in the Yoto app — needs your decision",
    NEEDS_ATTENTION: "Needs attention",
  };

  return (
    <div>
      <h2>Cards</h2>
      {cards.length === 0 && (
        <p className="muted">Add a podcast first — its card appears here.</p>
      )}
      {cards.map((c) => (
        <div className="card" key={c.id}>
          <strong dir={detectDirection(c.title)}>{c.title}</strong>
          <p className="muted">
            {stateLabel[c.sync_state] ?? c.sync_state} · {c.on_card} episode(s) on card
            {c.last_synced_at && ` · last updated ${new Date(c.last_synced_at).toLocaleString()}`}
          </p>
          {c.sync_state === "CONFLICT" ? (
            <>
              <p className="muted error" style={{ marginTop: 6 }}>
                Someone changed this card in the Yoto app since this app last updated it.
                Choose how to proceed.
              </p>
              <div className="row" style={{ marginTop: 10 }}>
                <button disabled={resolvingId === c.id} onClick={() => handleResolve(c, "keep-mine")}>
                  Keep my Yoto app changes
                </button>
                <button
                  className="primary"
                  disabled={resolvingId === c.id}
                  onClick={() => handleResolve(c, "let-app-manage")}
                >
                  Let this app manage the card
                </button>
              </div>
            </>
          ) : (
            <div className="row" style={{ marginTop: 10 }}>
              <button onClick={() => enqueue("sync-card", { cardId: c.id, force: true })}>
                Sync now
              </button>
              <button className="danger" onClick={() => handleRemove(c)}>
                Remove
              </button>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
