import { useState } from "react";
import { api, type Approval, type Config, type OwnerOpResult } from "../api";
import { countdown, naira, tusd8, wat } from "../format";
import { Empty, Icon, Pill, Sheet, Spinner, TxLink, useAsync, useToast } from "./ui";

const LIMIT_TEXT: Record<string, string> = {
  PerPaymentCap: "Over the per-payment cap",
  DailyBudget: "Over today's budget",
  TotalBudget: "Over the session's total budget",
};

export function Approvals({ cfg, onChanged }: { cfg: Config; onChanged: () => void }) {
  const q = useAsync(() => api<Approval[]>("/approvals"), []);
  const [confirm, setConfirm] = useState<{ a: Approval; approve: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [last, setLast] = useState<OwnerOpResult | null>(null);
  const toast = useToast();
  const pending = (q.data ?? []).filter((a) => a.status === "Pending");
  const history = (q.data ?? []).filter((a) => a.status !== "Pending");

  async function decide() {
    if (!confirm) return;
    setBusy(true);
    try {
      const r = await api<OwnerOpResult>(`/approvals/${confirm.a.id}/${confirm.approve ? "approve" : "reject"}`, { body: {} });
      setLast(r);
      toast(r.simulated ? r.note! : confirm.approve ? "Approved and paid on-chain" : "Rejected on-chain", r.simulated ? "info" : "ok");
      setConfirm(null);
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
        <h2>Approvals</h2>
        <button className="icon-btn" aria-label="Refresh" onClick={() => q.reload()}>
          <Icon name="refresh" />
        </button>
      </header>
      <p className="lead">When Paddy wants to pay more than you allowed, the smart account parks it here. Nothing moves until you decide.</p>
      {q.loading && !q.data && <Spinner label="Reading the chain…" />}
      {q.error && <div className="banner err">{q.error}</div>}
      {q.data && pending.length === 0 && (
        <Empty icon="check" title="Nothing waiting">
          Over-limit payments will show up here.
        </Empty>
      )}
      {pending.map((a) => (
        <div key={a.id} className="card approval">
          <div className="approval-top">
            <Pill tone="amber" icon="clock">
              Request #{a.id}
            </Pill>
            <span className="muted small">{countdown(a.expiresAt)}</span>
          </div>
          <div className="approval-amount">
            {tusd8(a.amount)} <span className="muted">≈ {naira(a.amount, cfg.ngnPerUsd)}</span>
          </div>
          <div className="approval-to">
            to <strong>{a.payeeName}</strong>
            {a.invoiceId !== "0" && <span className="muted"> · invoice #{a.invoiceId}</span>}
          </div>
          <div className="muted small">
            {LIMIT_TEXT[a.limit] ?? a.limit} · asked {wat(a.createdAt)}
          </div>
          <div className="btn-row">
            <button className="btn btn-ghost-red" onClick={() => setConfirm({ a, approve: false })}>
              <Icon name="x" size={18} /> Reject
            </button>
            <button className="btn btn-green" onClick={() => setConfirm({ a, approve: true })}>
              <Icon name="check" size={18} /> Approve
            </button>
          </div>
        </div>
      ))}
      {last?.tx && (
        <div className="banner ok">
          Done. <TxLink explorer={cfg.explorer} tx={last.tx} />
        </div>
      )}
      {history.length > 0 && (
        <>
          <h3 className="section">History</h3>
          <div className="card list">
            {history.map((a) => (
              <div key={a.id} className="list-row">
                <div>
                  <div>
                    #{a.id} · {tusd8(a.amount)} to {a.payeeName}
                  </div>
                  <div className="muted small">{wat(a.createdAt)}</div>
                </div>
                <Pill tone={a.status === "Approved" ? "green" : a.status === "Rejected" ? "red" : "grey"}>{a.status}</Pill>
              </div>
            ))}
          </div>
        </>
      )}
      <Sheet open={!!confirm} onClose={() => !busy && setConfirm(null)} title={confirm?.approve ? "Approve this payment?" : "Reject this payment?"}>
        {confirm && (
          <>
            <p className="sheet-amount">
              {tusd8(confirm.a.amount)} <span className="muted">to {confirm.a.payeeName}</span>
            </p>
            <p className="muted">
              {confirm.approve
                ? "The smart account pays it immediately. The payee's name is checked on-chain again at payment time."
                : "The request is closed on-chain and Paddy can't retry it."}
            </p>
            <div className="btn-row">
              <button className="btn btn-ghost" disabled={busy} onClick={() => setConfirm(null)}>
                Cancel
              </button>
              <button className={`btn ${confirm.approve ? "btn-green" : "btn-red"}`} disabled={busy} onClick={decide}>
                {busy ? <Spinner /> : confirm.approve ? "Approve & pay" : "Reject"}
              </button>
            </div>
          </>
        )}
      </Sheet>
    </div>
  );
}
