import { useEffect, useState } from "react";
import { appDataDir } from "@tauri-apps/api/path";
import { message } from "@tauri-apps/plugin-dialog";
import { check, Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { isSignedIn, signIn, signOut } from "../lib/oauth";
import { catchUpAfterSignIn } from "../lib/pipeline";

type UpdateStatus =
  | { kind: "checking" }
  | { kind: "up-to-date" }
  | { kind: "available"; update: Update }
  | { kind: "installing" }
  // No release has ever been published yet, so a 404 against the
  // GitHub-Releases endpoint is the expected steady state, not a real
  // error — never worth an alarming dialog.
  | { kind: "unknown" };

export default function Settings() {
  const [signedIn, setSignedIn] = useState<boolean | null>(null);
  const [dataDir, setDataDir] = useState("");
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus>({ kind: "unknown" });

  async function checkForUpdate() {
    setUpdateStatus({ kind: "checking" });
    try {
      const update = await check();
      setUpdateStatus(update ? { kind: "available", update } : { kind: "up-to-date" });
    } catch {
      setUpdateStatus({ kind: "unknown" });
    }
  }

  async function installUpdate(update: Update) {
    setUpdateStatus({ kind: "installing" });
    try {
      await update.downloadAndInstall();
      await relaunch();
    } catch (e: any) {
      setUpdateStatus({ kind: "available", update });
      await message(e.message, { title: "Update failed", kind: "error" });
    }
  }

  useEffect(() => {
    void isSignedIn().then(setSignedIn);
    void appDataDir().then(setDataDir);
    // Silent — see UpdateStatus's "unknown" case for why a failed check
    // here must never surface as an error.
    void checkForUpdate();
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
        )}
      </div>
      <div className="card">
        <strong>Updates</strong>
        {updateStatus.kind === "checking" && <p className="muted">Checking…</p>}
        {updateStatus.kind === "unknown" && <p className="muted">No update info available.</p>}
        {updateStatus.kind === "up-to-date" && <p className="muted">You're on the latest version.</p>}
        {updateStatus.kind === "installing" && <p className="muted">Downloading and installing…</p>}
        {updateStatus.kind === "available" && (
          <>
            <p className="muted">Version {updateStatus.update.version} is available.</p>
            <button className="primary" onClick={() => installUpdate(updateStatus.update)}>
              Install and restart
            </button>
          </>
        )}
        {(updateStatus.kind === "unknown" || updateStatus.kind === "up-to-date") && (
          <button onClick={checkForUpdate} style={{ marginTop: 8 }}>
            Check for updates
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
