import type { PaymentIntent } from "./schema.ts";
import { parseAmounts } from "./money.ts";
import type { Contact } from "./names.ts";
import { scanForInjection } from "./untrusted.ts";

/**
 * Deterministic fallback parser (no LLM). Handles English and light Nigerian Pidgin:
 *   "pay Mama Ngozi Foods 50k for rice", "abeg send 20k give Emeka Logistics",
 *   "settle Mama Ngozi invoice INV-0042", "make you pay ₦30 to Paddy Demo Foods"
 * Only the OWNER's request is parsed for instructions; invoice text only contributes an invoice number.
 */
const PAY_VERB = /\b(pay|send|transfer|settle|remit|give|dash|clear|balance)\b/i;
const INVOICE_WORD = /\b(invoice|inv|bill|receipt)\b/i;
const INVOICE_NO = /\b(?:inv(?:oice)?[\s#:.-]*(?:no\.?|number)?[\s#:.-]*)([A-Z0-9][A-Z0-9-]{2,30})\b/i;

export function ruleParse(request: string, contacts: Contact[], invoiceText?: string): PaymentIntent {
  const text = request.trim();
  const amounts = parseAmounts(text);
  const hasVerb = PAY_VERB.test(text);
  const invoiceNumber = (INVOICE_NO.exec(text) ?? INVOICE_NO.exec(invoiceText ?? ""))?.[1]?.toUpperCase() ?? null;

  let payeeName = findPayeeName(text, contacts);
  const purpose = /\bfor\s+([a-z][a-z\s]{1,40}?)(?:[.,!?]|$|\s+(?:abeg|please|now|today|o)\b)/i.exec(text)?.[1]?.trim() ?? null;

  if (!hasVerb) {
    return { ...base(), clarificationQuestion: "I didn't see a payment request. Who should I pay?" };
  }
  const action = INVOICE_WORD.test(text) && amounts.length === 0 ? "pay_invoice" : "pay";
  let amount = amounts.length === 1 ? amounts[0] : null;
  if (action === "pay_invoice" && invoiceText) {
    // owner said "pay this invoice": take issuer + amount from the document as data, never its instructions
    const inv = readInvoice(invoiceText, contacts);
    payeeName = payeeName ?? inv.payeeName;
    amount = amount ?? inv.amount;
  }
  const needsClarification = !payeeName || (action === "pay" && !amount) || amounts.length > 1;
  return {
    action,
    payeeName,
    amount: amount?.value ?? null,
    currency: amount?.currency ?? null,
    invoiceNumber,
    purpose,
    invoiceLooksSuspicious: false,
    needsClarification,
    clarificationQuestion: needsClarification
      ? amounts.length > 1
        ? "I saw more than one amount. Which one should I pay?"
        : !payeeName
          ? "Who should I pay?"
          : "How much should I pay?"
      : null,
  };
}

function base(): PaymentIntent {
  return {
    action: "none",
    payeeName: null,
    amount: null,
    currency: null,
    invoiceNumber: null,
    purpose: null,
    invoiceLooksSuspicious: false,
    needsClarification: true,
    clarificationQuestion: null,
  };
}

/**
 * Payee phrase = the capitalised words after "pay / give / to / settle / send". The raw phrase is returned
 * unchanged so look-alike detection happens later against the address book (never "rounded" to a contact).
 * Fallback: a whole-word mention of a contact name (for all-lowercase messages).
 */
const PAYEE_AFTER = /\b(?:[Pp]ay|[Gg]ive|[Tt]o|[Ss]ettle|[Ss]end|[Tt]ransfer|[Rr]emit)\s+(?:am\s+|for\s+)?((?:[A-Z0-9][\w'&.-]*\s?){1,6})/gu;
const STOP_TAIL = /\b(\d[\d,.]*k?|naira|invoice|inv|bill|for|abeg|now|today|and|or)\b.*$/i;

export function findPayeeName(text: string, contacts: Contact[]): string | null {
  for (const m of text.matchAll(PAYEE_AFTER)) {
    const cand = m[1].replace(STOP_TAIL, "").trim();
    if (cand.length >= 3 && /[a-z]/i.test(cand)) return cand;
  }
  const words = ` ${text.toLowerCase().replace(/[^a-z0-9]+/g, " ")} `;
  let best: { name: string; len: number } | null = null;
  for (const c of contacts) {
    for (const n of [c.legalName, ...(c.aliases ?? [])]) {
      const w = n.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
      if (w && words.includes(` ${w} `) && (!best || w.length > best.len)) best = { name: n, len: w.length };
    }
  }
  return best?.name ?? null;
}

const TOTAL_LINE = /\b(total|amount due|balance due|grand total|to pay)\b/i;

/**
 * Reading an invoice as DATA: which contact issued it (address-book names only) and its amount.
 * Lines that trip the injection scanner are ignored entirely; a "Total" line wins; otherwise
 * the amount is used only when the clean lines agree on a single figure.
 */
export function readInvoice(invoiceText: string, contacts: Contact[]): { payeeName: string | null; amount: ReturnType<typeof parseAmounts>[number] | null } {
  const clean = invoiceText.split(/\r?\n/).filter((l) => scanForInjection(l).length === 0);
  const words = ` ${clean.join(" ").toLowerCase().replace(/[^a-z0-9]+/g, " ")} `;
  let payeeName: string | null = null;
  let best = 0;
  for (const c of contacts) {
    for (const n of [c.legalName, ...(c.aliases ?? [])]) {
      const w = n.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
      if (w && words.includes(` ${w} `) && w.length > best) {
        best = w.length;
        payeeName = c.legalName;
      }
    }
  }
  // the issuer line may be a look-alike ("Paddy Dem0 Foods Ltd"): surface it raw so it gets rejected
  if (!payeeName) {
    const head = clean.slice(0, 4).find((l) => /^[A-Z][\w'&.-]*(\s[A-Z0-9][\w'&.-]*){1,5}$/.test(l.trim()) && !/^INVOICE\b/i.test(l.trim()));
    payeeName = head?.trim() ?? null;
  }
  const totals = clean.filter((l) => TOTAL_LINE.test(l)).flatMap((l) => parseAmounts(l));
  if (totals.length >= 1) return { payeeName, amount: totals[totals.length - 1] };
  const all = clean.flatMap((l) => parseAmounts(l));
  const distinct = new Set(all.map((m) => `${m.value}${m.currency}`));
  return { payeeName, amount: distinct.size === 1 ? all[0] : null };
}
