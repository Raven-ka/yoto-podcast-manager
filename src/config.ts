// Yoto app registration (public client — the ID is not a secret).
// Registered by Eran, 2026-08-23. Scopes: user:content:manage, user:icons:manage, offline_access.
export const YOTO_CLIENT_ID = "OnSLBpp6bazLuLyxhmt6t5XfmTzL3KXC";

// NOTE: verify these against https://yoto.dev before first run.
// Yoto auth is Auth0-based; the audience must be the API host.
export const YOTO_AUTH_DOMAIN = "https://login.yotoplay.com";
export const YOTO_API_BASE = "https://api.yotoplay.com";
export const YOTO_AUDIENCE = "https://api.yotoplay.com";

export const OAUTH_CALLBACK = "yotopm://oauth/callback";
export const OAUTH_SCOPES =
  "user:content:manage user:icons:manage offline_access";

// Downloader defaults (SPEC.md §7). Advanced settings may override per source.
export const DEFAULT_MAX_EPISODE_BYTES = 500 * 1024 * 1024;
export const DEFAULT_KEEP_COUNT = 10;
export const DEFAULT_SCAN_INTERVAL_HOURS = 6;
export const ORIGINALS_GRACE_DAYS = 30;

// SPEC.md §5: "MYO limits are enforced by Yoto per card (verify current
// numbers at build time; historically ~100 tracks / ~500 MB per card)."
// Yoto doesn't publish an exact number and the app must surface real API
// errors rather than hard-block on this — it's shown to the user as an
// approximate guideline only, not enforced.
export const APPROX_CARD_TRACK_LIMIT = 100;
export const APPROX_CARD_BYTE_LIMIT = 500 * 1024 * 1024;
