import { useEffect, useState } from "react";
import { getDb } from "../lib/db";
import { detectDirection } from "../lib/text";

export default function Activity() {
  const [events, setEvents] = useState<any[]>([]);

  useEffect(() => {
    const load = async () => {
      const d = await getDb();
      setEvents(
        await d.select<any[]>(`SELECT * FROM events ORDER BY id DESC LIMIT 100`),
      );
    };
    void load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, []);

  return (
    <div className="page">
      <header className="page-header">
        <h2>Activity</h2>
        <p>What the app has been doing, newest first.</p>
      </header>
      {events.length === 0 ? (
        <div className="empty">
          <strong>Nothing yet</strong>
          Syncs, downloads and problems will show up here.
        </div>
      ) : (
        <div className="card list-card">
          {events.map((e) => (
            <div className="activity-row" key={e.id}>
              <span className={"activity-dot" + (e.support_code ? " activity-dot--bad" : "")} />
              <div>
                <span dir={detectDirection(e.message)}>{e.message}</span>
                <p className="muted">
                  {new Date(e.at).toLocaleString()}
                  {e.support_code && ` · support code ${e.support_code}`}
                </p>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
