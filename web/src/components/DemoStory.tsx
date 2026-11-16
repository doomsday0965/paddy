import { useEffect, useRef, useState } from "react";
import { api, type Config, type StoryStep } from "../api";
import { flagLabel } from "../format";
import { DECISION } from "./PlanCard";
import { Icon, Pill, Spinner, TxLink, useAsync } from "./ui";

/** Judge demo: replays the poisoned-invoice story from real recorded Aevum transactions. Read-only. */
export function DemoStory({ cfg, onExit }: { cfg: Config | null; onExit: () => void }) {
  const q = useAsync(() => api<StoryStep[]>("/demo/story"), []);
  const [shown, setShown] = useState(0);
  const [playing, setPlaying] = useState(true);
  const end = useRef<HTMLDivElement>(null);
  const steps = q.data ?? [];
  const explorer = cfg?.explorer ?? "https://explorer-test.qday.info";
  const params = new URLSearchParams(location.search);
  const speed = Number(params.get("speed") ?? 1);

  useEffect(() => {
    if (!playing || shown >= steps.length) return;
    const next = steps[shown];
    const delay = (next?.kind === "narrator" ? 2600 : next?.kind === "owner" ? 1400 : 2000) / speed;
    const t = setTimeout(() => setShown((n) => n + 1), shown === 0 ? 400 : delay);
    return () => clearTimeout(t);
  }, [playing, shown, steps, speed]);
  useEffect(() => {
    if (params.get("all") === "1" && steps.length) setShown(steps.length);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [steps.length]);
  useEffect(() => {
    // block body: newer browsers return a Promise from scrollIntoView, which React would treat as a cleanup
    end.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [shown]);

  return (
    <div className="demo">
      <header className="demo-head">
        <button className="icon-btn light" aria-label="Exit demo" onClick={onExit}>
          <Icon name="x" />
        </button>
        <div>
          <div className="demo-title">The poisoned invoice</div>
          <div className="demo-sub">Replay of real Aevum transactions · nothing is sent</div>
        </div>
        <button className="icon-btn light" aria-label={playing ? "Pause" : "Play"} onClick={() => (shown >= steps.length ? (setShown(0), setPlaying(true)) : setPlaying((p) => !p))}>
          <Icon name={shown >= steps.length ? "refresh" : playing ? "pause" : "play"} />
        </button>
        <div className="demo-progress">
          <span style={{ width: `${steps.length ? (shown / steps.length) * 100 : 0}%` }} />
        </div>
      </header>
      <div className="demo-scroll">
        {q.loading && <Spinner label="Loading story…" />}
        {steps.slice(0, shown).map((s, i) => (
          <Step key={i} s={s} explorer={explorer} />
        ))}
        {shown < steps.length && playing && steps.length > 0 && (
          <div className="demo-typing">
            <span />
            <span />
            <span />
          </div>
        )}
        {shown >= steps.length && steps.length > 0 && (
          <div className="demo-end">
            <button className="btn btn-green btn-block" onClick={onExit}>
              Try Paddy yourself
            </button>
            <button className="btn btn-ghost btn-block" onClick={() => setShown(0)}>
              Replay
            </button>
          </div>
        )}
        <div ref={end} />
      </div>
      {!playing && shown < steps.length && (
        <button className="demo-next" onClick={() => setShown((n) => n + 1)}>
          Next step
        </button>
      )}
    </div>
  );
}

function Step({ s, explorer }: { s: StoryStep; explorer: string }) {
  if (s.kind === "narrator") return <div className="narrator">{s.text}</div>;
  if (s.kind === "owner")
    return (
      <div className="bubble-row me">
        <div className="bubble me">
          {s.text}
          {s.attachment && (
            <div className="attachment">
              <div className="attachment-head">
                <Icon name="clip" size={13} /> Forwarded invoice · read as data only
              </div>
              <pre>{s.attachment}</pre>
            </div>
          )}
        </div>
      </div>
    );
  if (s.kind === "paddy") {
    const d = DECISION[s.decision ?? "clarify"];
    return (
      <div className="bubble-row">
        <div className="avatar">P</div>
        <div className={`bubble paddy plan plan-${d.tone}`}>
          <Pill tone={d.tone} icon={d.icon}>
            {d.label}
          </Pill>
          <p className="plan-summary">{s.text}</p>
          {s.flags && s.flags.length > 0 && (
            <div className="flags">
              {s.flags.map((f) => (
                <span key={f} className="flag">
                  <Icon name="alert" size={12} /> {flagLabel(f)}
                </span>
              ))}
            </div>
          )}
          <TxLink explorer={explorer} tx={s.tx} label="On-chain" />
        </div>
      </div>
    );
  }
  return (
    <div className={`chainstep ${s.events?.includes("SessionActionBlocked") || s.events?.includes("SessionRevoked") ? "red" : s.kind === "approval" ? "amber" : ""}`}>
      <div className="chainstep-head">
        <Icon name={s.kind === "approval" ? "clock" : s.events?.includes("SessionActionBlocked") ? "ban" : "shield"} size={16} />
        {s.kind === "approval" ? "Owner approval" : "Smart account on Aevum"}
        {s.events?.length ? <span className="ev">{s.events.join(" · ")}</span> : null}
      </div>
      <div>{s.text}</div>
      <TxLink explorer={explorer} tx={s.tx} />
    </div>
  );
}
