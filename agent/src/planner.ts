import { keccak256, toBytes, type Address, type Hex } from "viem";
import type { ChainView } from "./chain.ts";
import { COP } from "./chain.ts";
import type { GeminiClient } from "./gemini.ts";
import { formatTusd8, parseAmounts, toTusd8Units, type Money } from "./money.ts";
import { nameHash, resolvePayee, type Contact } from "./names.ts";
import { readInvoice, ruleParse } from "./rules.ts";
import type { PaymentIntent } from "./schema.ts";
import { extractAddresses, sanitize, scanForInjection } from "./untrusted.ts";

export type Decision = "execute" | "queue_for_owner" | "needs_owner_review" | "reject" | "clarify";

export interface PayRequest {
  /** What the OWNER typed or said. The only source of instructions. */
  request: string;
  /** Invoice body, PDF text, forwarded message. UNTRUSTED data. */
  invoiceText?: string;
  /** Counterparty memo / payment note. UNTRUSTED data. */
  memo?: string;
}

export interface SessionCall {
  fn: "sessionTransfer" | "sessionPayInvoice";
  payee: Address;
  amount: bigint;
  invoiceId?: bigint;
  ref: Hex;
}

export interface Plan {
  id: Hex;
  decision: Decision;
  summary: string;
  reasons: string[];
  flags: string[];
  source: string;
  intent: PaymentIntent;
  payee?: { legalName: string; wallet: Address; cop: string };
  amount?: { units: string; display: string; from: string };
  call?: SessionCall;
}

export interface PlannerDeps {
  chain: ChainView;
  contacts: Contact[];
  sessionKey: Address;
  account: Address;
  ngnPerUsd: number;
  llm?: Pick<GeminiClient, "extract"> | null;
}

export const refFor = (label: string): Hex => keccak256(toBytes(label.trim().toUpperCase()));

/** Plain language + untrusted documents -> a decision the on-chain policy will also enforce. */
export async function plan(req: PayRequest, d: PlannerDeps): Promise<Plan> {
  const request = sanitize(req.request, 500);
  const untrusted = [req.invoiceText, req.memo].filter(Boolean).map((t) => sanitize(t!)).join("\n---\n") || undefined;
  const flags: string[] = [];
  const reasons: string[] = [];

  // 1. deterministic untrusted-text scan (independent of the model)
  for (const f of scanForInjection(untrusted)) flags.push(`injection:${f.rule}`);

  // 2. extraction: LLM (structured output, schema-validated) or rules
  const rules = ruleParse(request, d.contacts, untrusted);
  let intent: PaymentIntent = rules;
  let source = "rules";
  const llm = d.llm ? await d.llm.extract(request, untrusted) : null;
  if (llm) {
    intent = llm.intent;
    source = `gemini:${llm.model}`;
    if (llm.intent.invoiceLooksSuspicious) flags.push("llm:invoice-suspicious");
  }

  const id = keccak256(toBytes(JSON.stringify({ request, untrusted: untrusted ?? "", key: d.sessionKey })));
  const base = { id, flags, reasons, source, intent };
  const out = (decision: Decision, summary: string, extra: Partial<Plan> = {}): Plan => ({ ...base, decision, summary, ...extra });

  if (intent.action === "none") return out("clarify", intent.clarificationQuestion ?? "What payment should I make?");

  // 3. grounding: the amount must come from the OWNER's words, or from the invoice if the owner gave none
  const ownerAmounts = parseAmounts(request);
  let money: Money | null = null;
  let amountFrom = "";
  if (ownerAmounts.length > 1) return out("clarify", "I saw more than one amount in your message. Which one should I pay?");
  if (ownerAmounts.length === 1) {
    money = ownerAmounts[0];
    amountFrom = `owner request ("${money.raw}")`;
    if (intent.amount !== null && !sameMoney(intent.amount, intent.currency, money, d.ngnPerUsd)) {
      flags.push("amount-mismatch:model-vs-owner");
      reasons.push(`The model read ${intent.amount} ${intent.currency ?? ""} but you wrote ${money.raw}. Using your figure.`);
    }
  } else if (intent.amount !== null) {
    // Owner gave no amount: it may only come from the invoice text, and must literally appear there.
    const inInvoice = parseAmounts(untrusted ?? "");
    const hit = inInvoice.find((m) => sameMoney(intent.amount!, intent.currency, m, d.ngnPerUsd));
    if (!hit) {
      flags.push("amount-ungrounded");
      return out("needs_owner_review", "The amount isn't written in your message or the invoice. Please confirm it.", {});
    }
    const distinct = new Set(inInvoice.map((m) => toTusd8Units(m.value, m.currency, d.ngnPerUsd).toString()));
    const total = readInvoice(untrusted ?? "", d.contacts).amount;
    const isTotal = !!total && sameMoney(total.value, total.currency, hit, d.ngnPerUsd);
    if (distinct.size > 1 && !isTotal) flags.push("amount-ambiguous:invoice-has-several-amounts");
    money = hit;
    amountFrom = `invoice ("${hit.raw}")`;
  }

  // 4. payee: owner's address book only; look-alikes are refused, never "rounded"
  const name = intent.payeeName ?? rules.payeeName;
  if (!name) return out("clarify", "Who should I pay?");
  const ownerNamed = ruleParse(request, d.contacts).payeeName;
  const res = resolvePayee(name, d.contacts);
  if (res.kind === "lookalike") {
    flags.push("payee:lookalike");
    return out("reject", `"${name}" looks like your contact "${res.contact.legalName}" but isn't the same name (${res.score >= 1 ? "it swaps in look-alike characters" : `similarity ${res.score}`}). I won't pay a look-alike. Check it or add it as a new contact first.`);
  }
  if (res.kind === "unknown") {
    flags.push("payee:unknown");
    return out("reject", `"${name}" isn't in your approved contacts, so I can't pay them.`);
  }
  const contact = res.contact;
  if (ownerNamed && resolvePayee(ownerNamed, d.contacts).kind === "match") {
    const ownerContact = (resolvePayee(ownerNamed, d.contacts) as { contact: Contact }).contact;
    if (ownerContact.wallet !== contact.wallet) {
      flags.push("payee-mismatch:model-vs-owner");
      return out("needs_owner_review", `You named ${ownerContact.legalName}, but the model picked ${contact.legalName}. Please confirm.`);
    }
  }

  // 5. addresses in untrusted text are never used; a foreign one is a red flag
  for (const a of extractAddresses(untrusted)) {
    if (a !== contact.wallet.toLowerCase()) flags.push(`foreign-address:${a.slice(0, 8)}…${a.slice(-4)}`);
  }

  // 6. Confirmation of Payee + session scope (on-chain)
  const [cop, session, onList] = await Promise.all([
    d.chain.confirmPayee(contact.wallet, nameHash(contact.legalName)),
    d.chain.session(d.sessionKey),
    d.chain.isSessionPayee(d.sessionKey, contact.wallet),
  ]);
  const copName = COP[cop.result] ?? `Unknown(${cop.result})`;
  const payee = { legalName: contact.legalName, wallet: contact.wallet, cop: copName };
  if (!session.live) return out("reject", "My payment session is revoked or expired. Ask the owner to open a new one.", { payee });
  if (copName !== "Match") return out("reject", `Confirmation of Payee failed for ${contact.legalName}: ${copName}.`, { payee });
  if (cop.recentlyChanged) {
    flags.push("cop:wallet-recently-changed");
    return out("needs_owner_review", `${contact.legalName} changed their wallet recently. Please confirm with them by phone first.`, { payee });
  }
  if (!onList) return out("reject", `${contact.legalName} isn't on my approved payee list for this session.`, { payee });

  // 7. on-chain invoice (if the invoice number exists in InvoiceBook for this payee)
  let call: SessionCall | undefined;
  const invNo = intent.invoiceNumber ?? rules.invoiceNumber;
  if (invNo) {
    const inv = await d.chain.invoiceByRef(cop.payeeId, refFor(invNo));
    if (inv) {
      const remaining = inv.amount - inv.paid;
      if (inv.status !== 1) return out("reject", `Invoice ${invNo} is not open (already paid or cancelled).`, { payee });
      const code = await d.chain.payability(inv.id, d.account);
      if (code !== 0) return out("reject", `InvoiceBook says invoice ${invNo} can't be paid now (code ${code}).`, { payee });
      if (money && toTusd8Units(money.value, money.currency, d.ngnPerUsd) !== remaining) {
        flags.push("amount-mismatch:invoice-vs-owner");
        reasons.push(`The on-chain invoice is for ${formatTusd8(remaining)}, which differs from the amount given.`);
      }
      call = { fn: "sessionPayInvoice", payee: contact.wallet, amount: remaining, invoiceId: inv.id, ref: refFor(invNo) };
      amountFrom = `on-chain invoice ${invNo}`;
    }
  }
  if (!call) {
    if (!money) return out("clarify", `How much should I pay ${contact.legalName}?`, { payee });
    const units = toTusd8Units(money.value, money.currency, d.ngnPerUsd);
    if (units <= 0n) return out("reject", "That amount rounds to zero.", { payee });
    call = { fn: "sessionTransfer", payee: contact.wallet, amount: units, ref: refFor(invNo ?? intent.purpose ?? "PADDY") };
  }
  const amount = { units: call.amount.toString(), display: formatTusd8(call.amount), from: amountFrom };

  // 8. any red flag on untrusted content => hold for the owner (never auto-pay)
  if (flags.some((f) => /^(injection|llm|foreign-address|amount-)/.test(f))) {
    const n = flags.filter((f) => /^(injection|llm|foreign-address|amount-)/.test(f)).length;
    return out("needs_owner_review", `I'm holding ${amount.display} to ${contact.legalName} for you to check. I found ${n} red flag${n === 1 ? "" : "s"} in the invoice or message, so I won't pay it on my own. If it's genuine, confirm with them by phone first.`, { payee, amount, call });
  }

  // 9. limits (mirrors the on-chain rules; the account enforces them anyway)
  if ((await d.chain.balance()) < call.amount) return out("reject", "The business account doesn't have enough tUSD8.", { payee, amount });
  const overCap = call.amount > session.perPaymentCap;
  const overDay = call.amount > session.remainingToday;
  if (overCap || overDay) {
    if (session.pending >= 5) return out("reject", "Too many payments are already waiting for your approval.", { payee, amount });
    reasons.push(overCap ? `Above the per-payment cap of ${formatTusd8(session.perPaymentCap)}.` : `Above today's remaining budget of ${formatTusd8(session.remainingToday)}.`);
    return out("queue_for_owner", `${amount.display} to ${contact.legalName} is over my limit, so I'll send it to you for approval.`, { payee, amount, call });
  }
  return out("execute", `Paying ${amount.display} to ${contact.legalName} (name confirmed on-chain).`, { payee, amount, call });
}

function sameMoney(value: number, currency: string | null, m: Money, rate: number): boolean {
  const c = (currency ?? m.currency) as "NGN" | "USD";
  return toTusd8Units(value, c, rate) === toTusd8Units(m.value, m.currency, rate);
}
