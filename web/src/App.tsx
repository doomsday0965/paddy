import { useCallback, useEffect, useState } from "react";
import { api, ownerToken, type Config } from "./api";
import { Activity } from "./components/Activity";
import { Approvals } from "./components/Approvals";
import { Chat } from "./components/Chat";
import { DemoStory } from "./components/DemoStory";
import { GetPaid } from "./components/GetPaid";
import { Limits } from "./components/Limits";
import { PayPage } from "./components/PayPage";
import { Icon, Spinner, useAsync } from "./components/ui";
import { tusd8 } from "./format";

type Tab = "chat" | "approvals" | "limits" | "activity" | "getpaid";
const TABS: { id: Tab; label: string; icon: string }[] = [
  { id: "chat", label: "Chat", icon: "chat" },
  { id: "approvals", label: "Approvals", icon: "clock" },
  { id: "limits", label: "Limits", icon: "shield" },
  { id: "activity", label: "Activity", icon: "list" },
  { id: "getpaid", label: "Get paid", icon: "qr" },
];

function usePath() {
  const [path, setPath] = useState(location.pathname);
  useEffect(() => {
    const f = () => setPath(location.pathname);
    window.addEventListener("popstate", f);
    return () => window.removeEventListener("popstate", f);
  }, []);
  const go = useCallback((p: string) => {
    history.pushState(null, "", p);
    setPath(p);
    window.scrollTo(0, 0);
  }, []);
  return [path, go] as const;
}

export function App() {
  const [path, go] = usePath();
  const cfg = useAsync(() => api<Config>("/config"), []);
  const pay = /^\/pay\/(\d+)/.exec(path);
  if (pay) return <PayPage id={pay[1]} cfg={cfg.data ?? null} />;
  if (path === "/demo") return <DemoStory cfg={cfg.data ?? null} onExit={() => go("/")} />;
  if (cfg.loading && !cfg.data) return <div className="boot"><Spinner label="Starting Paddy…" /></div>;
  if (cfg.error || !cfg.data) return <div className="boot"><div className="banner err">Can't reach the Paddy server: {cfg.error}</div></div>;
  if (!cfg.data.isOwner) return <SignIn onDone={() => cfg.reload()} />;
  const tab = (path.replace(/^\//, "") || "chat") as Tab;
  return <Console cfg={cfg.data} tab={TABS.some((t) => t.id === tab) ? tab : "chat"} go={go} />;
}

function Console({ cfg, tab, go }: { cfg: Config; tab: Tab; go: (p: string) => void }) {
  const ov = useAsync(() => api<{ balance: string; pending: number; session: { live?: boolean } | null }>("/overview"), []);
  // re-read twice: the RPC node can lag a block behind the bundler's receipt
  const refresh = () => {
    void ov.reload();
    setTimeout(() => void ov.reload(), 4000);
  };
  useEffect(() => {
    const t = setInterval(() => void ov.reload(), 30_000);
    return () => clearInterval(t);
  }, [ov.reload]);
  const live = ov.data?.session?.live;
  return (
    <div className="app">
      <header className="top">
        <div className="brand">
          <img src="/icon.svg" alt="" width={30} height={30} />
          <div>
            <div className="brand-name">Paddy</div>
            <div className="brand-sub">
              <span className={`dot ${live ? "on" : "off"}`} /> {ov.data ? (live ? "Clerk active" : "Clerk off") : "…"} · Aevum Testnet
            </div>
          </div>
        </div>
        <div className="top-right">
          {tab !== "chat" && (
            <button className="icon-btn light" aria-label="Watch the judge demo" title="Judge demo" onClick={() => go("/demo")}>
              <Icon name="play" size={18} />
            </button>
          )}
          <div className="balance" title="Business account balance">
            <span>Balance</span>
            <strong>{ov.data ? tusd8(ov.data.balance) : "…"}</strong>
          </div>
        </div>
      </header>
      {cfg.demoMode && (
        <div className="demo-banner">
          <Icon name="eye" size={14} /> Judge demo mode: live chain data, actions are simulated.
        </div>
      )}
      {tab === "chat" && <button className="story-cta" onClick={() => go("/demo")}>
        <Icon name="play" size={16} />
        <span>
          <strong>Watch the poisoned-invoice story</strong>
          <small>60-second replay of real on-chain transactions</small>
        </span>
      </button>}
      <main className={tab === "chat" ? "main main-chat" : "main"}>
        {tab === "chat" && <Chat cfg={cfg} onChanged={refresh} />}
        {tab === "approvals" && <Approvals cfg={cfg} onChanged={refresh} />}
        {tab === "limits" && <Limits cfg={cfg} onChanged={refresh} />}
        {tab === "activity" && <Activity cfg={cfg} />}
        {tab === "getpaid" && <GetPaid cfg={cfg} />}
      </main>
      <nav className="tabs" aria-label="Sections">
        {TABS.map((t) => (
          <button key={t.id} className={t.id === tab ? "on" : ""} onClick={() => go(t.id === "chat" ? "/" : `/${t.id}`)} aria-current={t.id === tab ? "page" : undefined}>
            <span className="tab-icon">
              <Icon name={t.icon} size={22} />
              {t.id === "approvals" && (ov.data?.pending ?? 0) > 0 && <span className="badge">{ov.data!.pending}</span>}
            </span>
            <span>{t.label}</span>
          </button>
        ))}
      </nav>
    </div>
  );
}

function SignIn({ onDone }: { onDone: () => void }) {
  const [t, setT] = useState("");
  return (
    <div className="boot">
      <div className="card signin">
        <img src="/icon.svg" alt="" width={48} height={48} />
        <h2>Owner sign-in</h2>
        <p className="muted">Enter the owner token configured on your Paddy server. It's stored only on this device.</p>
        <input type="password" value={t} onChange={(e) => setT(e.target.value)} placeholder="Owner token" autoComplete="current-password" />
        <button
          className="btn btn-green btn-block"
          disabled={!t}
          onClick={() => {
            ownerToken.set(t);
            onDone();
          }}
        >
          Continue
        </button>
        <a className="linkish" href="/demo">
          Just looking? Watch the demo
        </a>
      </div>
    </div>
  );
}
