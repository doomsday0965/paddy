import { api, type AuditEntry, type Config } from "../api";
import { tusd8, wat } from "../format";
import { Empty, Icon, Spinner, TxLink, useAsync } from "./ui";

const KIND: Record<string, { icon: string; tone: string; title: string }> = {
  SessionPayment: { icon: "check", tone: "green", title: "Paid" },
  SessionActionBlocked: { icon: "ban", tone: "red", title: "Blocked by the smart account" },
  ApprovalRequested: { icon: "clock", tone: "amber", title: "Asked for approval" },
  RequestApproved: { icon: "check", tone: "green", title: "You approved" },
  RequestRejected: { icon: "x", tone: "grey", title: "You rejected" },
  SessionCreated: { icon: "bolt", tone: "blue", title: "Session opened" },
  SessionPayeeSet: { icon: "user", tone: "blue", title: "Payee list" },
  SessionRevoked: { icon: "power", tone: "red", title: "Paddy revoked" },
  OwnerExecuted: { icon: "shield", tone: "grey", title: "Owner action" },
  OwnerChanged: { icon: "shield", tone: "grey", title: "Owner changed" },
};

export function Activity({ cfg }: { cfg: Config }) {
  const q = useAsync(() => api<AuditEntry[]>("/audit"), []);
  const balance = useAsync(() => api<{ balance: string }>("/overview"), []);
  const paid = (q.data ?? []).filter((e) => e.event === "SessionPayment").length;
  const blocked = (q.data ?? []).filter((e) => e.event === "SessionActionBlocked").length;
  return (
    <div className="page">
      <header className="page-head">
        <h2>Activity</h2>
        <button className="icon-btn" aria-label="Refresh" onClick={() => q.reload()}>
          <Icon name="refresh" />
        </button>
      </header>
      <p className="lead">Every receipt comes straight from your smart account's on-chain events, so anyone can check it.</p>
      <div className="stats">
        <div className="stat">
          <span>Balance</span>
          <strong>{balance.data ? tusd8(balance.data.balance) : "…"}</strong>
        </div>
        <div className="stat">
          <span>AI payments</span>
          <strong>{q.data ? paid : "…"}</strong>
        </div>
        <div className="stat red">
          <span>Blocked</span>
          <strong>{q.data ? blocked : "…"}</strong>
        </div>
      </div>
      {q.loading && !q.data && <Spinner label="Indexing account events…" />}
      {q.error && <div className="banner err">{q.error}</div>}
      {q.data && q.data.length === 0 && <Empty icon="list" title="No activity yet" />}
      <ol className="timeline">
        {q.data?.map((e, i) => {
          const k = KIND[e.event] ?? { icon: "list", tone: "grey", title: e.event };
          return (
            <li key={`${e.tx}-${i}`} className={`tl tl-${k.tone}`}>
              <div className="tl-dot">
                <Icon name={k.icon} size={15} />
              </div>
              <div className="tl-body">
                <div className="tl-title">{k.title}</div>
                <div className="tl-summary">{e.summary}</div>
                <div className="tl-meta">
                  <span>{wat(e.time)}</span>
                  <TxLink explorer={cfg.explorer} tx={e.tx} label="Receipt" />
                </div>
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
