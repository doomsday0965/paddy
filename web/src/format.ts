/** Formatting helpers. Amounts arrive from the API as integer strings in tUSD8 units (6 decimals). */
export const units = (v: string | number | bigint | null | undefined): bigint => {
  try {
    return BigInt(v ?? 0);
  } catch {
    return 0n;
  }
};

export function tusd8(v: string | number | bigint | null | undefined, opts: { symbol?: boolean } = {}): string {
  const u = units(v);
  const neg = u < 0n;
  const a = neg ? -u : u;
  const whole = a / 1_000_000n;
  let frac = (a % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  if (frac.length < 2) frac = frac.padEnd(2, "0");
  return `${neg ? "-" : ""}${whole.toLocaleString("en-NG")}.${frac}${opts.symbol === false ? "" : " tUSD8"}`;
}

export function naira(v: string | number | bigint | null | undefined, ngnPerUsd: number): string {
  const n = (Number(units(v)) / 1e6) * ngnPerUsd;
  return `₦${n.toLocaleString("en-NG", { maximumFractionDigits: n < 100 ? 2 : 0 })}`;
}

/** Convert a typed amount ("0.05") to units; null when invalid. */
export function toUnits(s: string): bigint | null {
  const t = s.trim();
  if (!/^\d{1,7}(\.\d{1,6})?$/.test(t)) return null;
  const [w, f = ""] = t.split(".");
  return BigInt(w) * 1_000_000n + BigInt(f.padEnd(6, "0"));
}

export const short = (a?: string | null) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "");

const WAT = new Intl.DateTimeFormat("en-GB", { timeZone: "Africa/Lagos", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: false });
/** Times are shown in West Africa Time, where Paddy's users are. */
export const wat = (unixOrIso: number | string) => `${WAT.format(typeof unixOrIso === "number" ? new Date(unixOrIso * 1000) : new Date(unixOrIso))} WAT`;

export function countdown(untilUnix: number, nowMs = Date.now()): string {
  const s = Math.floor(untilUnix - nowMs / 1000);
  if (s <= 0) return "expired";
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h left`;
  if (h > 0) return `${h}h ${m}m left`;
  return `${m}m left`;
}

export function ago(iso: string, nowMs = Date.now()): string {
  const s = Math.max(0, Math.floor((nowMs - new Date(iso).getTime()) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
}

export const pct = (part: bigint, whole: bigint) => (whole === 0n ? 0 : Math.min(100, Number((part * 1000n) / whole) / 10));

/** Human labels for planner flags. */
export function flagLabel(f: string): string {
  const [k, v] = [f.split(":")[0], f.split(":").slice(1).join(":")];
  const map: Record<string, string> = {
    "injection:instruction-override": "Tries to override my rules",
    "injection:addressed-to-ai": "Talks to the AI directly",
    "injection:changed-account": "Claims bank/wallet changed",
    "injection:pay-elsewhere": "Asks to pay another wallet",
    "injection:urgency-pressure": "Pressure / urgency",
    "injection:limit-evasion": "Tries to dodge limits",
    "injection:hidden-markup": "Hidden text or markup",
    "llm:invoice-suspicious": "AI also found it suspicious",
    "amount-mismatch:model-vs-owner": "AI amount ≠ your amount",
    "amount-mismatch:invoice-vs-owner": "Invoice amount ≠ your amount",
    "amount-ungrounded": "Amount appears nowhere",
    "amount-ambiguous:invoice-has-several-amounts": "Several amounts on invoice",
    "payee-mismatch:model-vs-owner": "AI picked a different payee",
    "payee:lookalike": "Look-alike name",
    "payee:unknown": "Not in your contacts",
    "cop:wallet-recently-changed": "Wallet changed recently",
  };
  if (map[f]) return map[f];
  if (k === "foreign-address") return `Unknown wallet ${v}`;
  return f;
}
