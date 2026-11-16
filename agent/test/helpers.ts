import type { Address, Hex } from "viem";
import type { ChainView, InvoiceView, SessionState } from "../src/chain.ts";
import type { Contact } from "../src/names.ts";
import { nameHash } from "../src/names.ts";
import type { PlannerDeps } from "../src/planner.ts";
import type { PaymentIntent } from "../src/schema.ts";

export const SUPPLIER: Contact = {
  legalName: "Paddy Demo Foods Ltd",
  wallet: "0x0C9bce6c93765Ad41243141f936A4eA59A04272F",
  aliases: ["Paddy Demo Foods", "Demo Foods"],
};
export const NGOZI: Contact = { legalName: "Mama Ngozi Foods", wallet: "0x1111111111111111111111111111111111111111" };
export const ATTACKER = "0x000000000000000000000000000000000000bad1";
export const SESSION = "0x15573Aa1e7d31db1b5600286e723Fd6F011baC42" as Address;
export const ACCOUNT = "0xf74269212d041589Fe7B2930428012CBcb4f60Dc" as Address;

export class MockChain implements ChainView {
  sessionState: SessionState = {
    live: true,
    revoked: false,
    validUntil: 2_000_000_000,
    perPaymentCap: 50_000n, // 0.05 tUSD8
    dailyBudget: 100_000n,
    totalBudget: 300_000n,
    remainingToday: 100_000n,
    pending: 0,
    requireVerifiedPayee: true,
  };
  payees = new Set<string>([SUPPLIER.wallet.toLowerCase(), NGOZI.wallet.toLowerCase()]);
  cop: Record<string, { result: number; recentlyChanged: boolean }> = {};
  invoices = new Map<string, InvoiceView>();
  payabilityCode = 0;
  bal = 120_000n;
  async session() {
    return this.sessionState;
  }
  async isSessionPayee(_k: Address, p: Address) {
    return this.payees.has(p.toLowerCase());
  }
  async confirmPayee(wallet: Address, h: Hex) {
    const c = this.cop[wallet.toLowerCase()];
    if (c) return { result: c.result, payeeId: 1n, recentlyChanged: c.recentlyChanged };
    const known = [SUPPLIER, NGOZI].find((x) => x.wallet.toLowerCase() === wallet.toLowerCase());
    return { result: known && nameHash(known.legalName) === h ? 5 : 0, payeeId: 1n, recentlyChanged: false };
  }
  async invoiceByRef(_id: bigint, ref: Hex) {
    return this.invoices.get(ref) ?? null;
  }
  async payability() {
    return this.payabilityCode;
  }
  async balance() {
    return this.bal;
  }
}

export function deps(chain = new MockChain(), llmIntent?: Partial<PaymentIntent> | null): PlannerDeps {
  return {
    chain,
    contacts: [SUPPLIER, NGOZI],
    sessionKey: SESSION,
    account: ACCOUNT,
    ngnPerUsd: 1500,
    llm: llmIntent === undefined ? null : { extract: async () => (llmIntent ? { intent: { ...BASE, ...llmIntent }, model: "fake-llm" } : null) },
  };
}

export const BASE: PaymentIntent = {
  action: "pay",
  payeeName: null,
  amount: null,
  currency: null,
  invoiceNumber: null,
  purpose: null,
  invoiceLooksSuspicious: false,
  needsClarification: false,
  clarificationQuestion: null,
};
