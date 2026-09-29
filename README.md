# Podcast Manager for Yoto

by Edrion. A desktop app (macOS and Windows) that keeps Yoto MYO cards
stocked with fresh podcast episodes. Independent app, not made by or
affiliated with Yoto. See `SPEC.md` for the full specification.

## Prerequisites (macOS)

```sh
xcode-select --install                 # Xcode Command Line Tools
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh   # Rust
# Node 20+ (e.g. via https://nodejs.org or brew install node)
```

## Run in development

```sh
npm install
npm run tauri dev
```

First build compiles the Rust shell — expect ~5 minutes once, fast after that.

## Tests

```sh
npm test
```

## Project layout

```
SPEC.md                  product spec (source of truth)
src/                     React UI + app logic (TypeScript)
  config.ts              Yoto client ID, endpoints, defaults
  lib/db.ts              SQLite schema + migrations
  lib/oauth.ts           PKCE sign-in, tokens in the OS keychain
  lib/yoto.ts            Yoto API client (upload → transcode → card update)
  lib/feeds.ts           RSS/Atom parsing, dedup canonical keys
  lib/jobs.ts            persistent job queue (survives restarts)
  lib/pipeline.ts        job handlers: scan → download → upload → sync
  lib/downloader.ts      wrapper for the Rust safe downloader
  screens/               Home, Podcasts, Cards, Activity, Settings
src-tauri/               Rust shell
  src/downloader.rs      SSRF-safe streaming downloader (SPEC §7)
  src/lib.rs             keychain commands + plugin setup
```

## Release builds

- **macOS:** fill in `scripts/release-env.local.sh` (copy from
  `release-env.example.sh`), then
  `source scripts/release-env.local.sh && npx tauri build`, then
  `scripts/notarize-dmg.sh` (Tauri notarizes the app but not the `.dmg`).
  Output: `src-tauri/target/release/bundle/dmg/`.
- **Windows:** build on a Windows PC, see `docs/building-windows.md`.
