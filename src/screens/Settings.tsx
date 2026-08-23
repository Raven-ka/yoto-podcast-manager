import { useEffect, useState } from "react";
import { appDataDir } from "@tauri-apps/api/path";
import { isSignedIn, signIn, signOut } from "../lib/oauth";

export default function Settings() {
  const [signedIn, setSignedIn] = useState<boolean | null>(null);
  const [dataDir, setDataDir] = useState("");

  useEffect(() => {
    void isSignedIn().then(setSignedIn);
    void appDataDir().then(setDataDir);
  }, []);

  return (
    <div>
      <h2>Settings</h2>
      <div className="card">
        <strong>Yoto account</strong>
        <p className="muted">
          {signedIn ? "Connected." : "Not connected — export-only mode."}
        </p>
        {signedIn ? (
          <button onClick={() => signOut().then(() => setSignedIn(false))}>
            Sign out
          </button>
        ) : (
          <button
            className="primary"
            onClick={() =>
              signIn().then(() => setSignedIn(true)).catch((e) => alert(e.message))
            }
          >
            Sign in to Yoto
          </button>
        )}
      </div>
      <div className="card">
        <strong>Your data</strong>
        <p className="muted">
          Everything (database + downloaded audio) lives in:
          <br />
          <code>{dataDir}</code>
          <br />
          Backing up = copying that folder.
        </p>
      </div>
    </div>
  );
}
