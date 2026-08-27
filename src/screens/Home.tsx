import { useEffect, useState } from "react";
import { message } from "@tauri-apps/plugin-dialog";
import { getDb } from "../lib/db";
import { isSignedIn, signIn } from "../lib/oauth";
import { catchUpAfterSignIn } from "../lib/pipeline";
import { SignInIcon, PlusIcon } from "../components/icons";

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

  return (
    <div>
      <h2>Home</h2>
      {signedIn === false && (
        <div className="card card--row">
          <div className="icon-circle icon-circle--accent">
            <SignInIcon />
          </div>
          <div className="card-text">
            <strong>Connect your Yoto account</strong>
            <p className="muted">
              Sign in once — after that, cards update automatically. You can
              also use export-only mode without signing in.
            </p>
          </div>
          <button
            className="primary"
            onClick={() =>
              signIn()
                .then(() => {
                  setSignedIn(true);
                  return catchUpAfterSignIn();
                })
                .catch((e) => message(e.message, { title: "Sign-in failed", kind: "error" }))
            }
          >
            Sign in to Yoto
          </button>
        </div>
      )}
      {counts.podcasts === 0 && (
        <div className="card card--row">
          <div className="icon-circle icon-circle--secondary">
            <PlusIcon />
          </div>
          <div className="card-text">
            <strong>Add your first podcast</strong>
            <p className="muted">Paste an RSS link on the Podcasts screen to get started.</p>
          </div>
        </div>
      )}
      {counts.attention > 0 && (
        <div className="card">
          <strong className="error">{counts.attention} episode(s) need attention</strong>
          <p className="muted">See Activity for what happened and what to do.</p>
        </div>
      )}
      <div className="row">
        <div className="stat-tile">
          <strong>{counts.podcasts}</strong>
          <span>podcasts</span>
        </div>
        <div className="stat-tile">
          <strong>{counts.jobs}</strong>
          <span>jobs in progress</span>
        </div>
      </div>
    </div>
  );
}
