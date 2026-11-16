import type { ChatResult, Config } from "../api";
import { flagLabel, naira } from "../format";
import { Icon, Pill, TxLink } from "./ui";

export const DECISION: Record<string, { tone: "green" | "amber" | "red" | "blue" | "orange"; label: string; icon: string }> = {
  execute: { tone: "green", label: "Paid", icon: "check" },
  queue_for_owner: { tone: "amber", label: "Sent to you for approval", icon: "clock" },
  needs_owner_review: { tone: "orange", label: "Held for your review", icon: "alert" },
  reject: { tone: "red", label: "Refused", icon: "ban" },
  clarify: { tone: "blue", label: "Question", icon: "chat" },
  info: { tone: "blue", label: "Status", icon: "shield" },
};

export function PlanCard({ r, cfg, preview }: { r: ChatResult; cfg: Config; preview?: boolean }) {
  const p = r.plan;
  const d = DECISION[p.decision];
  const label = preview && (p.decision === "execute" || p.decision === "queue_for_owner") ? (p.decision === "execute" ? "Would pay (preview)" : "Would queue (preview)") : d.label;
  return (
    <div className={`plan plan-${d.tone}`}>
      <div className="plan-top">
        <Pill tone={d.tone} icon={d.icon}>
          {label}
        </Pill>
        <span className="plan-source" title="Who read your message">
          {p.source.startsWith("gemini") ? "Gemini" : p.source === "chain" ? "Live chain" : "Rules"}
        </span>
      </div>
      <p className="plan-summary">{p.summary}</p>
      {(p.payee || p.amount) && (
        <dl className="plan-facts">
          {p.payee && (
            <div>
              <dt>To</dt>
              <dd>
                {p.payee.legalName}{" "}
                {p.payee.cop === "Match" ? (
                  <span className="verified">
                    <Icon name="check" size={13} /> name confirmed
                  </span>
                ) : (
                  <span className="unverified">{p.payee.cop}</span>
                )}
              </dd>
            </div>
          )}
          {p.amount && (
            <div>
              <dt>Amount</dt>
              <dd>
                <strong>{p.amount.display}</strong> <span className="muted">≈ {naira(p.amount.units, cfg.ngnPerUsd)}</span>
              </dd>
            </div>
          )}
        </dl>
      )}
      {p.flags.length > 0 && (
        <div className="flags">
          {p.flags.map((f) => (
            <span key={f} className="flag">
              <Icon name="alert" size={12} /> {flagLabel(f)}
            </span>
          ))}
        </div>
      )}
      {p.reasons.length > 0 && (
        <ul className="reasons">
          {p.reasons.map((x) => (
            <li key={x}>{x}</li>
          ))}
        </ul>
      )}
      {r.execution && (
        <div className="plan-exec">
          {r.execution.replayed ? <span className="muted">Already done earlier, not sent twice. </span> : null}
          <TxLink explorer={cfg.explorer} tx={r.execution.tx} label={p.decision === "queue_for_owner" ? "Approval request on-chain" : "Payment on-chain"} />
        </div>
      )}
    </div>
  );
}
