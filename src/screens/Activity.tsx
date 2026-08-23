import { useEffect, useState } from "react";
import { getDb } from "../lib/db";

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
    <div>
      <h2>Activity</h2>
      {events.length === 0 && <p className="muted">Nothing yet.</p>}
      {events.map((e) => (
        <div className="card" key={e.id}>
          <span>{e.message}</span>
          <p className="muted">
            {new Date(e.at).toLocaleString()}
            {e.support_code && ` · support code ${e.support_code}`}
          </p>
        </div>
      ))}
    </div>
  );
}
