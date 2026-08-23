import { useEffect, useState } from "react";
import { getDb } from "../lib/db";
import { isSignedIn, signIn } from "../lib/oauth";

export default function Home() {
  const [signedIn, setSignedIn] = useState<boolean | null>(null);
  const [counts, setCounts] = useState({ podcasts: 0, jobs: 0, attention: 0 });

  async function refresh() {
    setSignedIn(await isSignedIn());
    const d = await getDb();
    const [p] = await d.select<any[]>(`SELECT COUNT(*) n FROM podcasts`);
    const [j] = await d.select<any[]>(
      `SELECT COUNT(*) n FROM jobs WHERE state IN ('PENDING','RUNNING')`,
    );
    const [a] = await d.select<any[]>(
      `SELECT COUNT(*) n FROM episodes WHERE state='NEEDS_ATTENTION'`,
    );
    setCounts({ podcasts: p.n, jobs: j.n, attention: a.n });
  }

  useEffect(() => {
    void refresh();
    const t = setInterval(refresh, 5000);
    return () => clearInterval(t);
  }, []);

  return (
    <div>
      <h2>Home</h2>
      {signedIn === false && (
        <div className="card">
          <strong>Connect your Yoto account</strong>
          <p className="muted">
            Sign in once — after that, cards update automatically. You can also
            use export-only mode without signing in.
          </p>
          <button
            className="primary"
            onClick={() => signIn().then(refresh).catch((e) => alert(e.message))}
          >
            Sign in to Yoto
          </button>
        </div>
      )}
      {counts.podcasts === 0 && (
        <div className="card">
          <strong>Add your first podcast</strong>
          <p className="muted">Paste an RSS link on the Podcasts screen to get started.</p>
        </div>
      )}
      {counts.attention > 0 && (
        <div className="card">
          <strong className="error">{counts.attention} episode(s) need attention</strong>
          <p className="muted">See Activity for what happened and what to do.</p>
        </div>
      )}
      <p className="muted">
        {counts.podcasts} podcast(s) · {counts.jobs} job(s) in progress
      </p>
    </div>
  );
}
