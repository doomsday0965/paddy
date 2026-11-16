import { keccak256, toBytes } from "viem";

/** Mirrors src/libraries/NameHash.sol: keep ASCII letters and digits, lower-case. */
export function normalizeName(name: string): string {
  return name.replace(/[^A-Za-z0-9]/g, "").toLowerCase();
}

export function nameHash(name: string): `0x${string}` {
  const n = normalizeName(name);
  if (!n) throw new Error("empty name");
  return keccak256(toBytes(n));
}

/** Common character swaps used in look-alike scams. */
const HOMOGLYPHS: Record<string, string> = { "0": "o", "1": "l", "3": "e", "4": "a", "5": "s", "7": "t", "8": "b", "|": "l" };

export function skeleton(name: string): string {
  const n = name.toLowerCase().replace(/[0-9|]/g, (c) => HOMOGLYPHS[c] ?? c);
  return n.replace(/[^a-z]/g, "").replace(/(.)\1+/g, "$1").replace(/rn/g, "m").replace(/vv/g, "w");
}

export function levenshtein(a: string, b: string): number {
  const dp = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j];
      dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return dp[b.length];
}

export function similarity(a: string, b: string): number {
  const x = normalizeName(a);
  const y = normalizeName(b);
  if (!x || !y) return 0;
  return 1 - levenshtein(x, y) / Math.max(x.length, y.length);
}

export interface Contact {
  /** Legal name exactly as attested in PayeeRegistry (used for Confirmation of Payee). */
  legalName: string;
  wallet: `0x${string}`;
  aliases?: string[];
}

export type Resolution =
  | { kind: "match"; contact: Contact; via: string }
  | { kind: "lookalike"; contact: Contact; candidate: string; score: number }
  | { kind: "unknown"; candidate: string };

const STOP = /\b(ltd|limited|plc|the)\b/gi;
const core = (s: string) => normalizeName(s.replace(STOP, " "));

/**
 * Resolve a payee name against the owner's address book.
 * Exact (normalised) match on legal name or alias => match. Anything merely similar is treated as a
 * LOOK-ALIKE and refused: the clerk never "rounds" a name to the nearest contact.
 */
export function resolvePayee(candidate: string, book: Contact[]): Resolution {
  const cn = normalizeName(candidate);
  const cc = core(candidate);
  for (const c of book) {
    for (const n of [c.legalName, ...(c.aliases ?? [])]) {
      if (normalizeName(n) === cn || (cc.length >= 4 && core(n) === cc)) return { kind: "match", contact: c, via: n };
    }
  }
  let best: { c: Contact; score: number } | null = null;
  for (const c of book) {
    for (const n of [c.legalName, ...(c.aliases ?? [])]) {
      const score = Math.max(similarity(candidate, n), similarity(cc, core(n)));
      const glyph = skeleton(candidate) === skeleton(n) || skeleton(cc) === skeleton(core(n));
      const s = glyph ? 1 : score;
      if (s >= 0.75 && (!best || s > best.score)) best = { c, score: s };
    }
  }
  if (best) return { kind: "lookalike", contact: best.c, candidate, score: Number(best.score.toFixed(2)) };
  return { kind: "unknown", candidate };
}
