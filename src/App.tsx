import { useEffect, useState } from "react";
import Home from "./screens/Home";
import Podcasts from "./screens/Podcasts";
import Cards from "./screens/Cards";
import Activity from "./screens/Activity";
import Settings from "./screens/Settings";
import { startRunner } from "./lib/jobs";
import { registerAllHandlers } from "./lib/pipeline";
import { getDb } from "./lib/db";

const SCREENS = {
  home: { label: "Home", el: Home },
  podcasts: { label: "Podcasts", el: Podcasts },
  cards: { label: "Cards", el: Cards },
  activity: { label: "Activity", el: Activity },
  settings: { label: "Settings", el: Settings },
} as const;

type ScreenKey = keyof typeof SCREENS;

export default function App() {
  const [screen, setScreen] = useState<ScreenKey>("home");
  const [ready, setReady] = useState(false);
  const [bootError, setBootError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        await getDb();
        registerAllHandlers();
        await startRunner();
        setReady(true);
      } catch (e: any) {
        setBootError(String(e?.message ?? e));
      }
    })();
  }, []);

  if (bootError) {
    return (
      <div className="boot-error">
        <h1>Something went wrong starting the app</h1>
        <p>{bootError}</p>
        <p>Support code: E_BOOT. Restarting the app is safe — no data is lost.</p>
      </div>
    );
  }
  if (!ready) return <div className="boot">Starting…</div>;

  const Active = SCREENS[screen].el;
  return (
    <div className="shell">
      <nav>
        <h1>Yoto Podcast Manager</h1>
        {(Object.keys(SCREENS) as ScreenKey[]).map((k) => (
          <button
            key={k}
            className={k === screen ? "active" : ""}
            onClick={() => setScreen(k)}
          >
            {SCREENS[k].label}
          </button>
        ))}
      </nav>
      <main>
        <Active />
      </main>
    </div>
  );
}
