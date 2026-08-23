import { useEffect, useState } from "react";
import { getDb } from "../lib/db";
import { enqueue } from "../lib/jobs";
import { detectDirection } from "../lib/text";

export default function Cards() {
  const [cards, setCards] = useState<any[]>([]);

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
          <button onClick={() => enqueue("sync-card", { cardId: c.id })}>Sync now</button>
        </div>
      ))}
    </div>
  );
}
