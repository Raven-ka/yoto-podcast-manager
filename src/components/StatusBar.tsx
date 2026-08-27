import { useEffect, useState } from "react";
import { getJobSummary, JobSummary } from "../lib/jobs";
import { getCurrentActivity, ActivityLine } from "../lib/pipeline";
import { detectDirection } from "../lib/text";

export default function StatusBar() {
  const [summary, setSummary] = useState<JobSummary>({ running: 0, pending: 0, failed: 0 });
  const [activity, setActivity] = useState<ActivityLine[]>([]);

  useEffect(() => {
    const refresh = () => {
      void getJobSummary().then(setSummary);
      void getCurrentActivity().then(setActivity);
    };
    refresh();
    const t = setInterval(refresh, 2000); // matches the job runner's own tick rate
    return () => clearInterval(t);
  }, []);

  const active = summary.running + summary.pending;
  const retryCount = activity.filter((a) => a.isRetry).length; // always PENDING, never RUNNING
  const hasRetry = retryCount > 0;
  // Cap how many detail lines get spelled out — with several jobs retrying
  // at once this would otherwise become one unreadable concatenated string,
  // which defeats the point of naming them at all. The rest fold into the
  // "more queued" count below.
  const MAX_DETAIL_LINES = 2;
  const shown = activity.slice(0, MAX_DETAIL_LINES);
  const foldedCount = summary.pending - Math.min(retryCount, MAX_DETAIL_LINES);
  // Unexplained silent jobs are exactly the confusing case this fixes: a
  // pending job with no detail line (no error yet) just waits its turn —
  // only a genuinely stuck-retrying job or a running one gets spelled out.
  const label =
    active === 0
      ? "All caught up"
      : shown.length > 0
        ? shown.map((a) => a.text).join(" · ")
        : `${active} job(s) queued`;

  return (
    <div className="status-bar" role="status" aria-live="polite">
      {active > 0 && <span className={hasRetry ? "status-dot status-dot--warning" : "status-dot"} />}
      <span dir={detectDirection(label)} className={hasRetry ? "error" : undefined}>
        {label}
      </span>
      {foldedCount > 0 && <span className="muted"> · {foldedCount} more queued</span>}
      {summary.failed > 0 && (
        <span className="error"> · {summary.failed} job(s) need attention — see Activity</span>
      )}
    </div>
  );
}
