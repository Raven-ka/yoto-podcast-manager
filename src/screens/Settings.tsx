import { useEffect, useState } from "react";
import { appDataDir } from "@tauri-apps/api/path";
import { message } from "@tauri-apps/plugin-dialog";
import { check, Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { isSignedIn, signIn, signOut } from "../lib/oauth";
import { catchUpAfterSignIn } from "../lib/pipeline";
import { getVersion } from "@tauri-apps/api/app";
import { EdrionLockup } from "../components/Brand";

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
  const [version, setVersion] = useState("");
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
    void getVersion().then(setVersion);
    // Silent — see UpdateStatus's "unknown" case for why a failed check
    // here must never surface as an error.
    void checkForUpdate();
  }, []);

  return (
    <div className="page">
      <header className="page-header">
        <h2>Settings</h2>
      </header>
      <div className="card">
        <h3>Yoto account</h3>
        <p>
          <span className={"chip " + (signedIn ? "chip--ok" : "chip--warn")}>
            {signedIn ? "Connected" : "Not connected — export-only mode"}
          </span>
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
        <h3>Updates</h3>
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
          <button onClick={checkForUpdate}>
            Check for updates
          </button>
        )}
      </div>
      <div className="card">
        <h3>Your data</h3>
        <p className="muted">
          Everything (database + downloaded audio) lives in this folder —
          backing up is just copying it.
        </p>
        <p>
          <code>{dataDir}</code>
        </p>
      </div>
      <div className="card about-card">
        <EdrionLockup className="about-brand" />
        <h3>Podcast Manager for Yoto</h3>
        <p className="muted">
          Version {version} · © 2026 Edrion
          <br />
          An independent app, not made by or affiliated with Yoto.
        </p>
      </div>
    </div>
  );
}
