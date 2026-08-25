// SQLite access + migrations (SPEC.md §9). Uses @tauri-apps/plugin-sql.
import Database from "@tauri-apps/plugin-sql";

let db: Database | null = null;

const MIGRATIONS: string[] = [
  // v1 — initial schema
  `
  CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);

  CREATE TABLE IF NOT EXISTS podcasts (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    source_type TEXT NOT NULL CHECK (source_type IN ('rss','local')),
    feed_url TEXT,
    artwork_url TEXT,
    rules_json TEXT NOT NULL DEFAULT '{}',
    scan_interval_hours INTEGER NOT NULL DEFAULT 6,
    etag TEXT,
    last_modified TEXT,
    health TEXT NOT NULL DEFAULT 'ok',
    paused INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS episodes (
    id TEXT PRIMARY KEY,
    podcast_id TEXT NOT NULL REFERENCES podcasts(id),
    canonical_key TEXT NOT NULL,
    guid TEXT,
    title TEXT NOT NULL,
    published_at TEXT,
    duration_seconds INTEGER,
    description TEXT,
    enclosure_url TEXT,
    artwork_url TEXT,
    season INTEGER,
    episode_number INTEGER,
    state TEXT NOT NULL DEFAULT 'DISCOVERED',
    error_code TEXT,
    error_message TEXT,
    transcoded_sha256 TEXT,
    UNIQUE (podcast_id, canonical_key)
  );
  CREATE INDEX IF NOT EXISTS idx_episodes_podcast
    ON episodes (podcast_id, published_at DESC);

  CREATE TABLE IF NOT EXISTS files (
    id TEXT PRIMARY KEY,
    episode_id TEXT NOT NULL REFERENCES episodes(id),
    path TEXT NOT NULL,
    bytes INTEGER NOT NULL,
    sha256 TEXT NOT NULL,
    ref_count INTEGER NOT NULL DEFAULT 1,
    downloaded_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS yoto_account (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    label TEXT,
    capabilities_json TEXT,
    last_verified_at TEXT
  );

  CREATE TABLE IF NOT EXISTS cards (
    id TEXT PRIMARY KEY,
    remote_content_id TEXT,
    title TEXT NOT NULL,
    podcast_id TEXT REFERENCES podcasts(id),
    desired_hash TEXT,
    confirmed_hash TEXT,
    sync_state TEXT NOT NULL DEFAULT 'OUT_OF_DATE',
    last_synced_at TEXT
  );

  CREATE TABLE IF NOT EXISTS card_items (
    card_id TEXT NOT NULL REFERENCES cards(id),
    episode_id TEXT NOT NULL REFERENCES episodes(id),
    position INTEGER NOT NULL,
    transcoded_sha256 TEXT,
    confirmed INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (card_id, episode_id)
  );

  CREATE TABLE IF NOT EXISTS jobs (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    payload_json TEXT NOT NULL DEFAULT '{}',
    state TEXT NOT NULL DEFAULT 'PENDING',
    attempts INTEGER NOT NULL DEFAULT 0,
    max_attempts INTEGER NOT NULL DEFAULT 5,
    next_run_at TEXT NOT NULL,
    last_error TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_jobs_state ON jobs (state, next_run_at);

  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at TEXT NOT NULL,
    type TEXT NOT NULL,
    entity_type TEXT,
    entity_id TEXT,
    message TEXT NOT NULL,
    support_code TEXT,
    detail_json TEXT
  );
  `,
  // v2 — store Yoto's actual transcode result per episode (SPEC.md §5:
  // card content must describe the transcoded file, not the RSS-reported one).
  `
  ALTER TABLE episodes ADD COLUMN transcoded_duration_seconds INTEGER;
  ALTER TABLE episodes ADD COLUMN transcoded_file_size INTEGER;
  ALTER TABLE episodes ADD COLUMN transcoded_channels INTEGER;
  ALTER TABLE episodes ADD COLUMN transcoded_format TEXT;
  `,
];

export async function getDb(): Promise<Database> {
  if (db) return db;
  db = await Database.load("sqlite:yoto-podcast-manager.db");
  await db.execute("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;");
  const row = await db
    .select<{ value: string }[]>(`SELECT value FROM meta WHERE key='schema_version'`)
    .catch(() => []);
  const current = row.length ? parseInt(row[0].value, 10) : 0;
  for (let v = current; v < MIGRATIONS.length; v++) {
    await db.execute(MIGRATIONS[v]);
    await db.execute(
      `INSERT INTO meta(key,value) VALUES('schema_version', $1)
       ON CONFLICT(key) DO UPDATE SET value=$1`,
      [String(v + 1)],
    );
  }
  return db;
}

export function uuid(): string {
  return crypto.randomUUID();
}

export function now(): string {
  return new Date().toISOString();
}

export async function logEvent(
  type: string,
  message: string,
  opts: {
    entityType?: string;
    entityId?: string;
    supportCode?: string;
    detail?: unknown;
  } = {},
): Promise<void> {
  const d = await getDb();
  await d.execute(
    `INSERT INTO events (at, type, entity_type, entity_id, message, support_code, detail_json)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [
      now(),
      type,
      opts.entityType ?? null,
      opts.entityId ?? null,
      message,
      opts.supportCode ?? null,
      opts.detail ? JSON.stringify(opts.detail) : null,
    ],
  );
}
