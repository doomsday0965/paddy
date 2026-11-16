import { useState } from "react";
import { api, type Config, type OwnerOpResult, type Session } from "../api";
import { countdown, short, toUnits, tusd8, units, wat } from "../format";
import { Icon, Meter, Pill, Sheet, Spinner, TxLink, useAsync, useToast } from "./ui";

export function Limits({ cfg, onChanged }: { cfg: Config; onChanged: () => void }) {
  const q = useAsync(() => api<{ session: Session | null; history: { address: string; createdAt: string; label: string }[] }>("/session"), []);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [last, setLast] = useState<OwnerOpResult | null>(null);
  const [showNew, setShowNew] = useState(false);
  const toast = useToast();
  const s = q.data?.session;
  const state = !s || !s.exists ? "none" : s.revoked ? "revoked" : s.live ? "live" : "expired";

  async function revoke() {
    setBusy(true);
    try {
      const r = await api<OwnerOpResult>("/session/revoke", { body: {} });
      setLast(r);
      toast(r.simulated ? r.note! : "Paddy is revoked. Its key no longer works.", r.simulated ? "info" : "ok");
      setConfirm(false);
      await q.reload();
      onChanged();
    } catch (e: any) {
      toast(e.message, "err");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="page">
      <header className="page-head">
        <h2>Paddy's limits</h2>
        <button className="icon-btn" aria-label="Refresh" onClick={() => q.reload()}>
          <Icon name="refresh" />
        </button>
      </header>
      <p className="lead">These rules live in your smart account on Aevum. Even if Paddy were tricked, the chain refuses anything outside them.</p>
      {q.loading && !q.data && <Spinner label="Reading the chain…" />}
      {q.error && <div className="banner err">{q.error}</div>}

      {s && s.exists && (
        <div className={`card session session-${state}`}>
          <div className="session-top">
            <div>
              <div className="session-label">{s.label}</div>
              <div className="muted small mono">key {short(s.address)}</div>
            </div>
            <Pill tone={state === "live" ? "green" : "red"} icon={state === "live" ? "bolt" : "ban"}>
              {state === "live" ? "Active" : state === "revoked" ? "Revoked" : "Expired"}
            </Pill>
          </div>
          <Meter label="Max per payment" used={0} display={tusd8(s.perPaymentCap)} sub="Bigger payments wait for your approval" />
          <Meter
            label="Spent today"
            used={Number(units(s.dailyBudget) - units(s.remainingToday))}
            total={Number(units(s.dailyBudget))}
            display={`${tusd8(units(s.dailyBudget) - units(s.remainingToday), { symbol: false })} / ${tusd8(s.dailyBudget)}`}
            sub="Resets at midnight UTC (01:00 WAT)"
          />
          <Meter label="Spent this session" used={Number(units(s.totalSpent))} total={Number(units(s.totalBudget))} display={`${tusd8(s.totalSpent, { symbol: false })} / ${tusd8(s.totalBudget)}`} />
          <div className="session-expiry">
            <Icon name="clock" size={16} />
            <span>
              {state === "live" ? countdown(s.validUntil!) : "Ended"} · until {wat(s.validUntil!)}
            </span>
          </div>
          <h4 className="sub">Who Paddy may pay</h4>
          <ul className="payees">
            {s.payees?.map((p) => (
              <li key={p.wallet} className={p.allowed ? "" : "off"}>
                <div className="payee-avatar">{p.name[0]}</div>
                <div className="payee-main">
                  <div>{p.name}</div>
                  <div className="muted small mono">{short(p.wallet)}</div>
                </div>
                {p.allowed ? (
                  p.cop === "Match" ? (
                    <Pill tone="green" icon="check">
                      Verified
                    </Pill>
                  ) : (
                    <Pill tone="red">{p.cop}</Pill>
                  )
                ) : (
                  <Pill tone="grey">Not allowed</Pill>
                )}
              </li>
            ))}
          </ul>
          {s.requireVerifiedPayee && (
            <div className="muted small lockline">
              <Icon name="lock" size={14} /> Only payees with a valid Confirmation of Payee attestation
            </div>
          )}
        </div>
      )}

      {state === "live" ? (
        <button className="btn-revoke" onClick={() => setConfirm(true)}>
          <Icon name="power" size={26} />
          <span>
            Revoke Paddy now
            <small>Stops all AI payments in one block</small>
          </span>
        </button>
      ) : (
        !showNew && (
          <button className="btn btn-green btn-block" onClick={() => setShowNew(true)}>
            <Icon name="bolt" size={18} /> Open a new session for Paddy
          </button>
        )
      )}
      {last?.tx && (
        <div className="banner ok">
          Done on-chain. <TxLink explorer={cfg.explorer} tx={last.tx} />
        </div>
      )}
      {showNew && (
        <NewSession
          cfg={cfg}
          onDone={async (r) => {
            setLast(r);
            setShowNew(false);
            await q.reload();
            onChanged();
          }}
        />
      )}

      <Sheet open={confirm} onClose={() => !busy && setConfirm(false)} title="Revoke Paddy?">
        <p>Paddy's session key stops working immediately. Pending approvals stay for you to decide. You can open a new session any time.</p>
        <div className="btn-row">
          <button className="btn btn-ghost" disabled={busy} onClick={() => setConfirm(false)}>
            Cancel
          </button>
          <button className="btn btn-red" disabled={busy} onClick={revoke}>
            {busy ? <Spinner /> : "Revoke now"}
          </button>
        </div>
      </Sheet>
    </div>
  );
}

function NewSession({ cfg, onDone }: { cfg: Config; onDone: (r: OwnerOpResult) => void }) {
  const [cap, setCap] = useState("0.03");
  const [daily, setDaily] = useState("0.06");
  const [total, setTotal] = useState("0.10");
  const [days, setDays] = useState(7);
  const [payees, setPayees] = useState<string[]>(cfg.contacts.map((c) => c.wallet));
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const c = toUnits(cap), d = toUnits(daily), t = toUnits(total);
  const err = !c || !d || !t ? "Enter amounts like 0.05" : d < c ? "Daily budget must be ≥ the per-payment cap" : t < d ? "Total must be ≥ the daily budget" : !payees.length ? "Pick at least one payee" : "";

  async function submit() {
    setBusy(true);
    try {
      const r = await api<OwnerOpResult>("/session", { body: { perPaymentCap: cap, dailyBudget: daily, totalBudget: total, days, payees, requireVerifiedPayee: true, label: "Paddy AI clerk" } });
      toast(r.simulated ? r.note! : "New session is live on-chain", r.simulated ? "info" : "ok");
      onDone(r);
    } catch (e: any) {
      toast(e.message, "err");
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="card form">
      <h3>New session</h3>
      <p className="muted small">A fresh key is created on the server; the old one can never be reused.</p>
      <div className="grid3">
        <label>
          Per payment
          <input inputMode="decimal" value={cap} onChange={(e) => setCap(e.target.value)} />
        </label>
        <label>
          Per day
          <input inputMode="decimal" value={daily} onChange={(e) => setDaily(e.target.value)} />
        </label>
        <label>
          In total
          <input inputMode="decimal" value={total} onChange={(e) => setTotal(e.target.value)} />
        </label>
      </div>
      <div className="field-label">Expires after</div>
      <div className="seg">
        {[1, 3, 7, 14, 30].map((n) => (
          <button key={n} type="button" className={n === days ? "on" : ""} onClick={() => setDays(n)}>
            {n}d
          </button>
        ))}
      </div>
      <div className="field-label">Approved payees</div>
      {cfg.contacts.map((p) => (
        <label key={p.wallet} className="check">
          <input type="checkbox" checked={payees.includes(p.wallet)} onChange={(e) => setPayees((x) => (e.target.checked ? [...x, p.wallet] : x.filter((w) => w !== p.wallet)))} />
          <span>{p.name}</span>
          <span className="muted small mono">{short(p.wallet)}</span>
        </label>
      ))}
      {err && <div className="form-err">{err}</div>}
      <button className="btn btn-green btn-block" disabled={!!err || busy} onClick={submit}>
        {busy ? <Spinner label="Signing & sending (gas sponsored)…" /> : "Create session"}
      </button>
    </div>
  );
}
