import { useEffect, useState } from "react";
import { getJobSummary, JobSummary } from "../lib/jobs";
import { getCurrentActivity } from "../lib/pipeline";
import { detectDirection } from "../lib/text";

export default function StatusBar() {
  const [summary, setSummary] = useState<JobSummary>({ running: 0, pending: 0, failed: 0 });
  const [activity, setActivity] = useState<string[]>([]);

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
  const label =
    active === 0
      ? "All caught up"
      : activity.length > 0
        ? activity.join(" · ")
        : `${active} job(s) queued`;

  return (
    <div className="status-bar">
      {active > 0 && <span className="status-dot" />}
      <span dir={detectDirection(label)}>{label}</span>
      {summary.pending > 0 && activity.length > 0 && (
        <span className="muted"> · {summary.pending} more queued</span>
      )}
      {summary.failed > 0 && (
        <span className="error"> · {summary.failed} job(s) need attention — see Activity</span>
      )}
    </div>
  );
}
