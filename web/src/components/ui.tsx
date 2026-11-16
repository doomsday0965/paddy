import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { short } from "../format";

const paths: Record<string, string> = {
  chat: "M4 5h16v11H8l-4 4z",
  check: "M5 12.5l4.5 4.5L19 7.5",
  shield: "M12 3l8 3v6c0 4.5-3.4 8.3-8 9-4.6-.7-8-4.5-8-9V6z",
  clock: "M12 7v5l3 2M12 3a9 9 0 100 18 9 9 0 000-18z",
  list: "M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01",
  qr: "M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h2v2h-2zM18 18h2v2h-2zM14 18h2v2h-2zM18 14h2v2h-2z",
  send: "M4 12l16-8-6 16-2-6z",
  clip: "M16 7l-7.5 7.5a2.1 2.1 0 003 3L19 10a4 4 0 00-5.7-5.7L5.8 11.8a6 6 0 008.5 8.5L20 14.6",
  x: "M6 6l12 12M18 6L6 18",
  alert: "M12 4l9 16H3zM12 10v4M12 17h.01",
  ext: "M14 4h6v6M20 4l-9 9M18 14v5H5V6h5",
  play: "M7 5l12 7-12 7z",
  pause: "M8 5v14M16 5v14",
  power: "M12 3v8M6.3 7.3a8 8 0 1011.4 0",
  lock: "M6 11h12v9H6zM8.5 11V8a3.5 3.5 0 017 0v3",
  refresh: "M20 11a8 8 0 10-2.3 5.7M20 5v6h-6",
  ban: "M5.6 5.6l12.8 12.8M12 3a9 9 0 100 18 9 9 0 000-18z",
  bolt: "M13 3L5 14h6l-1 7 8-11h-6z",
  user: "M12 12a4 4 0 100-8 4 4 0 000 8zM4 21a8 8 0 0116 0",
  copy: "M9 9h11v11H9zM5 15V4h11",
  share: "M12 3v12M7 8l5-5 5 5M5 14v6h14v-6",
  eye: "M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12zM12 15a3 3 0 100-6 3 3 0 000 6z",
};
export function Icon({ name, size = 20, className }: { name: keyof typeof paths | string; size?: number; className?: string }) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d={paths[name] ?? ""} />
    </svg>
  );
}

export function Pill({ tone, children, icon }: { tone: "green" | "amber" | "red" | "blue" | "grey" | "orange"; children: ReactNode; icon?: string }) {
  return (
    <span className={`pill pill-${tone}`}>
      {icon && <Icon name={icon} size={14} />}
      {children}
    </span>
  );
}

export function TxLink({ explorer, tx, label = "View on explorer" }: { explorer: string; tx?: string; label?: string }) {
  if (!tx) return null;
  return (
    <a className="txlink" href={`${explorer}/tx/${tx}`} target="_blank" rel="noreferrer noopener">
      {label} <span className="mono">{short(tx)}</span> <Icon name="ext" size={14} />
    </a>
  );
}

export function Spinner({ label }: { label?: string }) {
  return (
    <span className="spinner-wrap" role="status">
      <span className="spinner" />
      {label && <span>{label}</span>}
    </span>
  );
}

export function Meter({ label, used, total, display, sub }: { label: string; used: number; total?: number; display: string; sub?: string }) {
  const p = total ? Math.min(100, (used / total) * 100) : 0;
  return (
    <div className="meter">
      <div className="meter-head">
        <span>{label}</span>
        <strong>{display}</strong>
      </div>
      {total !== undefined && (
        <div className="meter-bar" aria-hidden>
          <span style={{ width: `${p}%` }} className={p > 85 ? "hot" : ""} />
        </div>
      )}
      {sub && <div className="meter-sub">{sub}</div>}
    </div>
  );
}

export function Sheet({ open, onClose, title, children }: { open: boolean; onClose: () => void; title: string; children: ReactNode }) {
  useEffect(() => {
    if (!open) return;
    const k = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet" role="dialog" aria-modal="true" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <div className="sheet-grip" />
        <h3>{title}</h3>
        {children}
      </div>
    </div>
  );
}

export function Empty({ icon, title, children }: { icon: string; title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <div className="empty-icon">
        <Icon name={icon} size={28} />
      </div>
      <h4>{title}</h4>
      {children && <p>{children}</p>}
    </div>
  );
}

type Toast = { id: number; text: string; tone: "ok" | "err" | "info" };
const ToastCtx = createContext<(text: string, tone?: Toast["tone"]) => void>(() => {});
export const useToast = () => useContext(ToastCtx);
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((text: string, tone: Toast["tone"] = "info") => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, text, tone }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4500);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toasts" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast toast-${t.tone}`}>
            {t.text}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

export function useAsync<T>(fn: () => Promise<T>, deps: unknown[] = []) {
  const [state, set] = useState<{ data?: T; error?: string; loading: boolean }>({ loading: true });
  const run = useCallback(() => {
    set((s) => ({ ...s, loading: true }));
    return fn().then(
      (data) => set({ data, loading: false }),
      (e) => set((s) => ({ ...s, error: String(e.message ?? e), loading: false })),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  useEffect(() => {
    void run();
  }, [run]);
  return { ...state, reload: run };
}
