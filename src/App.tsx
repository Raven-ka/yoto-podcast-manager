import { useEffect, useState, ComponentType } from "react";
import Home from "./screens/Home";
import Podcasts from "./screens/Podcasts";
import PodcastDetail from "./screens/PodcastDetail";
import Cards from "./screens/Cards";
import Activity from "./screens/Activity";
import Settings from "./screens/Settings";
import StatusBar from "./components/StatusBar";
import { HomeIcon, PodcastsIcon, CardsIcon, ActivityIcon, SettingsIcon, LogoMark } from "./components/icons";
import { startRunner } from "./lib/jobs";
import { registerAllHandlers } from "./lib/pipeline";
import { getDb } from "./lib/db";

const SCREENS = {
  home: { label: "Home", el: Home, Icon: HomeIcon },
  podcasts: { label: "Podcasts", el: Podcasts, Icon: PodcastsIcon },
  cards: { label: "Cards", el: Cards, Icon: CardsIcon },
  activity: { label: "Activity", el: Activity, Icon: ActivityIcon },
  settings: { label: "Settings", el: Settings, Icon: SettingsIcon },
} as const;

type ScreenKey = keyof typeof SCREENS;

export default function App() {
  const [screen, setScreen] = useState<ScreenKey>("home");
  const [openPodcastId, setOpenPodcastId] = useState<string | null>(null);
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

  // Podcasts is rendered separately below (it takes an onOpenPodcast prop);
  // this only ever backs the other, prop-less screens.
  const Active = SCREENS[screen].el as ComponentType;
  return (
    <div className="shell">
      <div className="body">
        <nav aria-label="Main">
          <div className="nav-header">
            <div className="nav-logo">
              <LogoMark />
            </div>
            <span className="nav-title">
              Podcast
              <br />
              Manager
            </span>
          </div>
          {(Object.keys(SCREENS) as ScreenKey[]).map((k) => {
            const { label, Icon } = SCREENS[k];
            return (
              <button
                key={k}
                className={k === screen ? "active" : ""}
                aria-current={k === screen ? "page" : undefined}
                onClick={() => {
                  setScreen(k);
                  setOpenPodcastId(null);
                }}
              >
                <Icon />
                {label}
              </button>
            );
          })}
        </nav>
        <main>
          {openPodcastId ? (
            <PodcastDetail podcastId={openPodcastId} onBack={() => setOpenPodcastId(null)} />
          ) : screen === "podcasts" ? (
            <Podcasts onOpenPodcast={setOpenPodcastId} />
          ) : (
            <Active />
          )}
        </main>
      </div>
      <StatusBar />
    </div>
  );
}
