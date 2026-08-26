// Persistent in-process job queue (SPEC.md §4). Replaces v1.1's Redis/BullMQ.
// Jobs live in the SQLite `jobs` table so they survive app restarts.
import { getDb, logEvent, now, uuid } from "./db";

export type JobType =
  | "scan-feed" // payload: { podcastId }
  | "download-episode" // payload: { episodeId }
  | "upload-episode" // payload: { episodeId }
  | "sync-card" // payload: { cardId }
  | "cleanup"; // payload: {}

export type JobHandler = (payload: any) => Promise<void>;

const handlers = new Map<JobType, JobHandler>();
export function registerHandler(type: JobType, h: JobHandler): void {
  handlers.set(type, h);
}

const GLOBAL_CONCURRENCY = 2;
// Yoto API calls are serialized (SPEC §4): these job types never run in parallel.
const SERIALIZED_TYPES: JobType[] = ["upload-episode", "sync-card"];

export async function enqueue(
  type: JobType,
  payload: unknown,
  opts: { delaySeconds?: number; maxAttempts?: number; dedupeKey?: boolean } = {},
): Promise<string> {
  const d = await getDb();
  if (opts.dedupeKey !== false) {
    // Coalesce: skip if an identical pending job exists.
    const dup = await d.select<{ id: string }[]>(
      `SELECT id FROM jobs WHERE type=$1 AND payload_json=$2 AND state IN ('PENDING','RUNNING')`,
      [type, JSON.stringify(payload)],
    );
    if (dup.length) return dup[0].id;
  }
  const id = uuid();
  const at = new Date(Date.now() + (opts.delaySeconds ?? 0) * 1000).toISOString();
  await d.execute(
    `INSERT INTO jobs (id,type,payload_json,state,attempts,max_attempts,next_run_at,created_at)
     VALUES ($1,$2,$3,'PENDING',0,$4,$5,$6)`,
    [id, type, JSON.stringify(payload), opts.maxAttempts ?? 5, at, now()],
  );
  return id;
}

function backoffSeconds(attempt: number): number {
  const base = Math.min(2 ** attempt * 30, 3600);
  return base + Math.floor(Math.random() * base * 0.3); // jitter
}

let running = 0;
let yotoBusy = false;
let timer: ReturnType<typeof setInterval> | null = null;

async function tick(): Promise<void> {
  if (running >= GLOBAL_CONCURRENCY) return;
  const d = await getDb();
  const rows = await d.select<
    { id: string; type: JobType; payload_json: string; attempts: number; max_attempts: number }[]
  >(
    `SELECT id, type, payload_json, attempts, max_attempts FROM jobs
     WHERE state='PENDING' AND next_run_at <= $1 ORDER BY next_run_at LIMIT 50`,
    [now()],
  );
  for (const job of rows) {
    if (running >= GLOBAL_CONCURRENCY) break;
    const serialized = SERIALIZED_TYPES.includes(job.type);
    if (serialized && yotoBusy) continue;
    const handler = handlers.get(job.type);
    if (!handler) continue;
    running++;
    if (serialized) yotoBusy = true;
    await d.execute(`UPDATE jobs SET state='RUNNING', attempts=attempts+1 WHERE id=$1`, [job.id]);
    void (async () => {
      try {
        await handler(JSON.parse(job.payload_json));
        await d.execute(`UPDATE jobs SET state='DONE' WHERE id=$1`, [job.id]);
      } catch (e: any) {
        const attempt = job.attempts + 1;
        const permanent =
          e?.permanent === true || attempt >= job.max_attempts;
        const retryAfter: number | undefined = e?.retryAfterSeconds;
        if (permanent) {
          await d.execute(
            `UPDATE jobs SET state='FAILED', last_error=$2 WHERE id=$1`,
            [job.id, String(e?.message ?? e)],
          );
          await logEvent("job-failed", `${job.type} failed permanently: ${e?.message ?? e}`, {
            entityType: "job",
            entityId: job.id,
            supportCode: e?.message?.match(/\(E_[A-Z_]+\)/)?.[0] ?? "(E_UNKNOWN)",
          });
        } else {
          const delay = retryAfter ?? backoffSeconds(attempt);
          await d.execute(
            `UPDATE jobs SET state='PENDING', next_run_at=$2, last_error=$3 WHERE id=$1`,
            [job.id, new Date(Date.now() + delay * 1000).toISOString(), String(e?.message ?? e)],
          );
          // SPEC §14: Activity is the primary observability surface — a job
          // silently retrying in the background for minutes with nothing
          // visible anywhere until it either succeeds or exhausts attempts
          // is exactly the "no idea what's going on" gap this closes.
          await logEvent(
            "job-retry",
            `${job.type} hit an error, retrying (attempt ${attempt}/${job.max_attempts} in ${delay}s): ${e?.message ?? e}`,
            {
              entityType: "job",
              entityId: job.id,
              supportCode: e?.message?.match(/\(E_[A-Z_]+\)/)?.[0] ?? "(E_UNKNOWN)",
            },
          );
        }
      } finally {
        running--;
        if (serialized) yotoBusy = false;
      }
    })();
  }
}

export async function startRunner(): Promise<void> {
  if (timer) return;
  const d = await getDb();
  // Recover jobs that were RUNNING when the app was killed.
  await d.execute(`UPDATE jobs SET state='PENDING' WHERE state='RUNNING'`);
  timer = setInterval(() => void tick(), 2000);
}

export function stopRunner(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

export type JobSummary = { running: number; pending: number; failed: number };

export async function getJobSummary(): Promise<JobSummary> {
  const d = await getDb();
  const rows = await d.select<{ state: string; n: number }[]>(
    `SELECT state, COUNT(*) n FROM jobs WHERE state IN ('RUNNING','PENDING','FAILED') GROUP BY state`,
  );
  const byState = Object.fromEntries(rows.map((r) => [r.state, r.n]));
  return {
    running: byState.RUNNING ?? 0,
    pending: byState.PENDING ?? 0,
    failed: byState.FAILED ?? 0,
  };
}
