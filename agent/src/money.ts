/** Amount parsing for Nigerian usage: "50k", "₦50,000", "N2.5m", "50 thousand naira", "$0.02", "0.05 tusd8". */
export type Currency = "NGN" | "USD";
export interface Money {
  value: number;
  currency: Currency;
  raw: string;
}

const AMOUNT_RE =
  /(?<pre>₦|\bngn\b|\bn(?=\d)|\$|\busd\b|\btusd8\b|\busdt?\b)?\s*(?<num>\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)\s*(?<mult>k\b|m\b|thousand\b|million\b|mil\b)?\s*(?<post>naira\b|ngn\b|usd\b|dollars?\b|tusd8\b|usdt?\b)?/giu;

export function parseAmounts(text: string): Money[] {
  const out: Money[] = [];
  for (const m of text.matchAll(AMOUNT_RE)) {
    const g = m.groups ?? {};
    const pre = (g.pre ?? "").toLowerCase();
    const post = (g.post ?? "").toLowerCase();
    const mult = (g.mult ?? "").toLowerCase();
    if (!pre && !post && !mult) continue; // bare numbers (invoice numbers, dates) are not amounts
    let value = Number(g.num.replace(/,/g, ""));
    if (mult === "k" || mult === "thousand") value *= 1_000;
    if (mult === "m" || mult === "million" || mult === "mil") value *= 1_000_000;
    if (!Number.isFinite(value) || value <= 0) continue;
    const usd = /\$|usd|dollar|tusd8/.test(pre + post);
    out.push({ value, currency: usd ? "USD" : "NGN", raw: m[0].trim() });
  }
  return out;
}

/** Major units -> tUSD8 base units (6 decimals). NGN converted at `ngnPerUsd`. Rounds down. */
export function toTusd8Units(value: number, currency: Currency, ngnPerUsd: number): bigint {
  const usd = currency === "USD" ? value : value / ngnPerUsd;
  return BigInt(Math.floor(usd * 1e6 + 1e-6));
}

export function formatTusd8(units: bigint): string {
  const s = units.toString().padStart(7, "0");
  return `${s.slice(0, -6)}.${s.slice(-6)}`.replace(/\.?0+$/, "") + " tUSD8";
}
