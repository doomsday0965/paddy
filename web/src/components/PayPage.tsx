import { useState } from "react";
import { api, type Config, type Invoice } from "../api";
import { naira, short, tusd8, wat } from "../format";
import { injected, payWithWallet } from "../wallet";
import { QR } from "./QR";
import { Icon, Pill, Spinner, TxLink, useAsync } from "./ui";

/** Public customer page: /pay/:id. No login. Customer signs, Paddy's relayer pays the gas. */
export function PayPage({ id, cfg }: { id: string; cfg: Config | null }) {
  const q = useAsync(() => api<Invoice>(`/invoices/${id}`), [id]);
  const [step, setStep] = useState("");
  const [done, setDone] = useState<{ tx: string } | null>(null);
  const [err, setErr] = useState("");
  const inv = q.data;
  const explorer = cfg?.explorer ?? "https://explorer-test.qday.info";
  const rate = cfg?.ngnPerUsd ?? 1500;
  const hasWallet = !!injected();

  async function run(kind: "wallet" | "demo") {
    setErr("");
    try {
      const r = kind === "wallet" ? await payWithWallet(id, setStep) : (setStep("Test customer is signing… Paddy relays it (no gas)"), await api<{ tx: string }>(`/invoices/${id}/demo-pay`, { body: {} }));
      setDone(r);
      await q.reload();
    } catch (e: any) {
      setErr(e?.message ?? String(e));
    } finally {
      setStep("");
    }
  }

  return (
    <div className="paypage">
      <header className="pay-head">
        <div className="brand">
          <img src="/icon.svg" alt="" width={28} height={28} />
          <span>Paddy Pay</span>
        </div>
        <Pill tone="blue">Aevum Testnet</Pill>
      </header>
      {q.loading && !inv && <Spinner label="Loading invoice…" />}
      {q.error && <div className="banner err">{q.error === "invoice not found" ? "This invoice doesn't exist." : q.error}</div>}
      {inv && (
        <div className="pay-card">
          <div className="merchant">
            <div className="merchant-avatar">{inv.merchant.name[0]}</div>
            <div>
              <div className="merchant-name">{inv.merchant.name}</div>
              {inv.merchant.verified ? (
                <div className="verified">
                  <Icon name="shield" size={14} /> Verified business · name confirmed on-chain
                </div>
              ) : (
                <div className="unverified">
                  <Icon name="alert" size={14} /> Not verified. Be careful.
                </div>
              )}
              <div className="muted small">
                {inv.merchant.settled} invoices settled · {inv.merchant.onTime} on time · <span className="mono">{short(inv.merchant.wallet)}</span>
              </div>
            </div>
          </div>
          <div className="pay-amount">
            <div className="label">{inv.meta?.label ?? `Invoice #${inv.id}`}</div>
            <div className="value">{tusd8(inv.status === "Paid" ? inv.amount : inv.remaining)}</div>
            <div className="muted">≈ {naira(inv.status === "Paid" ? inv.amount : inv.remaining, rate)}</div>
          </div>
          <dl className="pay-facts">
            <div>
              <dt>Invoice</dt>
              <dd>
                #{inv.id}
                {inv.meta?.reference ? ` · ${inv.meta.reference}` : ""}
              </dd>
            </div>
            <div>
              <dt>Due</dt>
              <dd>{wat(inv.dueDate)}</dd>
            </div>
            <div>
              <dt>Status</dt>
              <dd>
                <Pill tone={inv.status === "Paid" ? "green" : inv.status === "Open" ? (inv.payable ? "blue" : "amber") : "grey"}>{inv.status === "Open" && !inv.payable ? inv.payability : inv.status}</Pill>
              </dd>
            </div>
          </dl>

          {done || inv.status === "Paid" ? (
            <div className="paid">
              <div className="paid-check">
                <Icon name="check" size={36} />
              </div>
              <h3>Paid</h3>
              <p className="muted">The money went straight to {inv.merchant.name}'s verified wallet.</p>
              {done && <TxLink explorer={explorer} tx={done.tx} label="Receipt on-chain" />}
            </div>
          ) : inv.payable ? (
            <>
              {step ? (
                <div className="pay-progress">
                  <Spinner label={step} />
                </div>
              ) : (
                <div className="pay-actions">
                  <button className="btn btn-green btn-block btn-lg" disabled={!hasWallet} onClick={() => run("wallet")}>
                    <Icon name="bolt" size={18} /> Pay with my wallet · no gas
                  </button>
                  {!hasWallet && <div className="muted small center-text">Open this page in your wallet app's browser (MetaMask, Rabby, Coinbase Wallet) to pay.</div>}
                  {cfg?.features.demoCustomer && (
                    <button className="btn btn-ghost btn-block" onClick={() => run("demo")}>
                      <Icon name="play" size={16} /> Judge demo: pay as a test customer
                    </button>
                  )}
                </div>
              )}
              {err && <div className="banner err">{err}</div>}
              <div className="qr-block">
                <QR value={typeof location !== "undefined" ? location.href : ""} size={168} />
                <div className="muted small">Scan to open on another phone</div>
              </div>
            </>
          ) : null}
          <div className="safety">
            <Icon name="lock" size={14} /> You only sign a one-time authorization for exactly this amount to this invoice. Paddy will never ask for your seed phrase or private key.
          </div>
        </div>
      )}
      <footer className="pay-foot">
        Powered by Paddy on QDay Aevum · <a href="/">Owner console</a>
      </footer>
    </div>
  );
}
