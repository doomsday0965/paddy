/**
 * Untrusted text handling. Invoice bodies, memos, PDFs and chat forwards are DATA, never instructions.
 * These checks are deterministic and run whether or not the LLM noticed anything.
 */

export interface InjectionFinding {
  rule: string;
  excerpt: string;
}

const RULES: [string, RegExp][] = [
  ["instruction-override", /\b(ignore|disregard|forget|override)\b[^.\n]{0,40}\b(previous|prior|above|all|earlier|your)\b[^.\n]{0,30}\b(instructions?|rules?|prompts?|policy|limits?)\b/i],
  ["addressed-to-ai", /\b(note|message|instruction|attention)s?\s+(to|for)\s+(the\s+)?(ai|assistant|agent|bot|llm|model|clerk|paddy)\b|\b(as an ai|you are now|system prompt|developer mode)\b/i],
  ["changed-account", /\b(chang|updat|new|switch)\w*\b[^.\n]{0,30}\b(bank|account|wallet|address|details|payment info)\b/i],
  ["pay-elsewhere", /\b(pay|send|transfer|remit)\b[^.\n]{0,40}\b(to|into)\b[^.\n]{0,20}(0x[a-f0-9]{6,}|another|different|this new|the following)\b/i],
  ["urgency-pressure", /\b(urgent(ly)?|immediately|right now|asap|within the hour|or (else|we will)|final notice)\b/i],
  ["limit-evasion", /\b(split|break)\b[^.\n]{0,30}\b(payments?|amount|into)\b|\b(no need|don'?t|do not)\b[^.\n]{0,20}\b(approval|confirm|ask|verify)\b/i],
  ["hidden-markup", /<!--|\u200b|\u200c|\u200d|\u2060|\[\/?(system|inst)\]|<\/?(system|instructions?)>/i],
];

export function scanForInjection(text: string | undefined | null): InjectionFinding[] {
  if (!text) return [];
  const findings: InjectionFinding[] = [];
  for (const [rule, re] of RULES) {
    const m = re.exec(text);
    if (m) findings.push({ rule, excerpt: m[0].slice(0, 80) });
  }
  return findings;
}

export function extractAddresses(text: string | undefined | null): string[] {
  if (!text) return [];
  return [...new Set((text.match(/0x[a-fA-F0-9]{40}/g) ?? []).map((a) => a.toLowerCase()))];
}

/** Strip characters that can smuggle instructions (zero-width, bidi controls), cap length. */
export function sanitize(text: string, max = 4000): string {
  return text.replace(/[\u200b-\u200f\u202a-\u202e\u2060-\u2064\ufeff]/g, "").slice(0, max);
}

/** Wrap untrusted data for the model with a random fence the data cannot forge. */
export function fence(label: string, text: string): string {
  const tag = `${label}_${crypto.randomUUID().slice(0, 8)}`;
  const safe = sanitize(text).replaceAll(tag, "");
  return `<${tag}>\n${safe}\n</${tag}>`;
}
