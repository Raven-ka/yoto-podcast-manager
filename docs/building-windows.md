# Building the Windows installer

The Windows installer has to be built on a Windows PC (Tauri can't reliably
cross-compile it from a Mac). The output is a single NSIS installer:
`Podcast Manager for Yoto_<version>_x64-setup.exe`.

Windows-specific settings live in `src-tauri/tauri.windows.conf.json` (merged
over `tauri.conf.json` automatically when building on Windows).

## 1. One-time setup on the PC

Install, in this order:

1. **Microsoft C++ Build Tools** — https://visualstudio.microsoft.com/visual-cpp-build-tools/
   In the installer, tick **"Desktop development with C++"**.
2. **Rust** — https://rustup.rs (download `rustup-init.exe`, accept the defaults).
3. **Node.js 20+** — https://nodejs.org (LTS installer).
4. **Git** — https://git-scm.com/download/win (only needed if cloning from GitHub).

WebView2 is already part of Windows 10 (recent updates) and 11 — nothing to install.

Open a **new** PowerShell window afterwards so the PATH changes apply, and check:

```powershell
rustc --version; node --version; npm --version
```

## 2. Get the code onto the PC

Either clone it:

```powershell
git clone https://github.com/Raven-ka/yoto-podcast-manager.git
cd yoto-podcast-manager
```

or copy the project folder over (skip `node_modules/` and `src-tauri/target/`).

**Also copy `scripts/updater-key.local`** from the Mac into the same place
(`scripts\updater-key.local`). It is deliberately not in git — it's the private
key that signs auto-updates. Copy it by USB stick or similar, never by
committing it or pasting it into chat/email.

## 3. Build

```powershell
npm install
$env:TAURI_SIGNING_PRIVATE_KEY = "scripts\updater-key.local"
$env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = ""
npx tauri build
```

The first build compiles all the Rust code (~5–10 minutes); later builds are
much faster. The installer lands in:

```
src-tauri\target\release\bundle\nsis\
  Podcast Manager for Yoto_1.0.0_x64-setup.exe      <- give this to users
  Podcast Manager for Yoto_1.0.0_x64-setup.exe.sig  <- for auto-update (latest.json)
```

## 4. Test before shipping

Install the `.exe` on the PC and check at least:

- The app opens, and the sidebar shows "by Edrion".
- **Sign in to Yoto** completes and returns to the app (this exercises the
  `yotopm://` deep link + single-instance handoff, which only exist on Windows
  after installing).
- Quit and reopen the app: it should still be signed in (tokens are stored
  in Windows Credential Manager under `com.erank.yotopodcastmanager`).
- Add a podcast and let one episode reach a card.

## Known: "Windows protected your PC"

The installer is not code-signed (that needs a paid code-signing certificate),
so Windows SmartScreen shows a blue "Windows protected your PC" warning on
first run. Users click **More info → Run anyway**. Tell users this on the
download page. The warning goes away once the installer is signed with a
certificate (or builds reputation over time).

## Auto-update entry

When publishing a release, add a Windows entry to `latest.json` next to the
macOS one:

```json
"windows-x86_64": {
  "signature": "<contents of the .exe.sig file>",
  "url": "https://github.com/Raven-ka/yoto-podcast-manager/releases/download/v1.0.0/Podcast.Manager.for.Yoto_1.0.0_x64-setup.exe"
}
```

(GitHub replaces spaces in uploaded asset names with dots — copy the real URL
from the release page rather than typing it.)
