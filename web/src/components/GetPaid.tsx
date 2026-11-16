import { useState } from "react";
import { api, type Config, type OwnerOpResult } from "../api";
import { naira, toUnits } from "../format";
import { QR } from "./QR";
import { Icon, Spinner, TxLink, useToast } from "./ui";

const RECENT = "paddy.invoices";

export function GetPaid({ cfg }: { cfg: Config }) {
  const [amount, setAmount] = useState("0.01");
  const [label, setLabel] = useState("2 crates of eggs");
  const [ref, setRef] = useState(() => `PDY-${Math.floor(1000 + Math.random() * 9000)}`);
  const [busy, setBusy] = useState(false);
  const [made, setMade] = useState<{ id: string; tx: string } | null>(null);
  const [recent, setRecent] = useState<{ id: string; label: string }[]>(() => JSON.parse(localStorage.getItem(RECENT) ?? "[]"));
  const toast = useToast();
  const u = toUnits(amount);
  const url = made ? `${location.origin}/pay/${made.id}` : "";

  async function create() {
    setBusy(true);
    try {
      const r = await api<OwnerOpResult & { id?: string }>("/invoices", { body: { amount, label, reference: ref } });
      if (r.simulated) toast(r.note!, "info");
      else if (r.id) {
        setMade({ id: r.id, tx: r.tx! });
        const next = [{ id: r.id, label }, ...recent].slice(0, 8);
        setRecent(next);
        localStorage.setItem(RECENT, JSON.stringify(next));
      }
    } catch (e: any) {
      toast(e.message, "err");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="page">
      <header className="page-head">
        <h2>Get paid</h2>
      </header>
      <p className="lead">Create an invoice and show the QR. Your customer pays from their phone with no gas, and sees your name confirmed on-chain.</p>
      {!made ? (
        <div className="card form">
          {!cfg.features.merchant && !cfg.demoMode && <div className="banner warn">The merchant wallet isn't configured on this server.</div>}
          <label>
            Amount (tUSD8)
            <input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
          </label>
          <div className="muted small">{u ? `≈ ${naira(u, cfg.ngnPerUsd)} at the demo rate` : "Enter an amount like 0.05"}</div>
          <label>
            What it's for
            <input value={label} onChange={(e) => setLabel(e.target.value)} maxLength={80} />
          </label>
          <label>
            Your reference
            <input value={ref} onChange={(e) => setRef(e.target.value.toUpperCase())} maxLength={30} />
          </label>
          <button className="btn btn-green btn-block" disabled={!u || busy || !label.trim()} onClick={create}>
            {busy ? <Spinner label="Issuing on-chain…" /> : "Create invoice & QR"}
          </button>
        </div>
      ) : (
        <div className="card center">
          <QR value={url} size={220} />
          <div className="big-amount">{amount} tUSD8</div>
          <div className="muted">{label}</div>
          <div className="btn-row">
            <button
              className="btn btn-ghost"
              onClick={() => {
                void navigator.clipboard?.writeText(url);
                toast("Link copied", "ok");
              }}
            >
              <Icon name="copy" size={16} /> Copy link
            </button>
            {"share" in navigator && (
              <button className="btn btn-ghost" onClick={() => navigator.share({ title: "Pay with Paddy", url })}>
                <Icon name="share" size={16} /> Share
              </button>
            )}
          </div>
          <a className="btn btn-green btn-block" href={`/pay/${made.id}`}>
            Open the customer page
          </a>
          <TxLink explorer={cfg.explorer} tx={made.tx} label="Invoice on-chain" />
          <button className="linkish" onClick={() => setMade(null)}>
            New invoice
          </button>
        </div>
      )}
      {recent.length > 0 && (
        <>
          <h3 className="section">Recent invoices</h3>
          <div className="card list">
            {recent.map((r) => (
              <a key={r.id} className="list-row" href={`/pay/${r.id}`}>
                <span>
                  #{r.id} · {r.label}
                </span>
                <Icon name="qr" size={18} />
              </a>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
