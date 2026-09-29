import { useEffect, useState } from "react";
import { message } from "@tauri-apps/plugin-dialog";
import { getDb } from "../lib/db";
import { isSignedIn, signIn } from "../lib/oauth";
import { catchUpAfterSignIn } from "../lib/pipeline";
import { PlusIcon } from "../components/icons";

export default function Home() {
  const [signedIn, setSignedIn] = useState<boolean | null>(null);
  const [counts, setCounts] = useState({ podcasts: 0, jobs: 0, attention: 0 });

  async function refreshCounts() {
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
    void isSignedIn().then(setSignedIn);
    void refreshCounts();
    const t = setInterval(refreshCounts, 5000);
    return () => clearInterval(t);
  }, []);

  function handleSignIn() {
    signIn()
      .then(() => {
        setSignedIn(true);
        return catchUpAfterSignIn();
      })
      .catch((e) => message(e.message, { title: "Sign-in failed", kind: "error" }));
  }

  return (
    <div className="page">
      <section className="hero">
        <div className="hero-text">
          {signedIn === false ? (
            <>
              <h2>Connect your Yoto account</h2>
              <p>
                Sign in once — after that, cards update automatically. You can
                also use export-only mode without signing in.
              </p>
              <div className="row">
                <button className="on-accent" onClick={handleSignIn}>
                  Sign in to Yoto
                </button>
              </div>
            </>
          ) : (
            <>
              <h2>Hi there!</h2>
              <p>
                {counts.jobs > 0
                  ? "Your cards are being updated in the background."
                  : "Everything's up to date. New episodes land on your cards automatically."}
              </p>
            </>
          )}
        </div>
      </section>
      {counts.attention > 0 && (
        <div className="card card--attention">
          <strong>{counts.attention} episode(s) need attention</strong>
          <p className="muted">See Activity for what happened and what to do.</p>
        </div>
      )}
      {counts.podcasts === 0 && (
        <div className="card card--row">
          <div className="icon-circle">
            <PlusIcon />
          </div>
          <div className="card-text">
            <strong>Add your first podcast</strong>
            <p className="muted">Paste an RSS link on the Podcasts screen to get started.</p>
          </div>
        </div>
      )}
      <div className="stat-grid">
        <div className="stat-tile tint-orange">
          <strong>{counts.podcasts}</strong>
          <span>podcasts</span>
        </div>
        <div className="stat-tile tint-sky">
          <strong>{counts.jobs}</strong>
          <span>jobs in progress</span>
        </div>
        <div className="stat-tile tint-green">
          <strong>{counts.attention}</strong>
          <span>need attention</span>
        </div>
      </div>
    </div>
  );
}
