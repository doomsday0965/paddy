import { createPublicClient, http, type Address, type Hex, type PublicClient } from "viem";
import { DEPLOYMENT, loadAbi } from "./config.ts";

export interface SessionState {
  live: boolean;
  revoked: boolean;
  validUntil: number;
  perPaymentCap: bigint;
  dailyBudget: bigint;
  totalBudget: bigint;
  remainingToday: bigint;
  pending: number;
  requireVerifiedPayee: boolean;
}

export interface InvoiceView {
  id: bigint;
  payeeId: bigint;
  payer: Address;
  amount: bigint;
  paid: bigint;
  status: number; // 1 Open, 2 Paid, 3 Cancelled
}

/** Everything the policy engine needs from the chain. Mockable in tests. */
export interface ChainView {
  session(key: Address): Promise<SessionState>;
  isSessionPayee(key: Address, payee: Address): Promise<boolean>;
  confirmPayee(wallet: Address, nameHash: Hex): Promise<{ result: number; payeeId: bigint; recentlyChanged: boolean }>;
  invoiceByRef(payeeId: bigint, ref: Hex): Promise<InvoiceView | null>;
  payability(invoiceId: bigint, payer: Address): Promise<number>;
  balance(): Promise<bigint>;
}

/** CoP results from IPayeeRegistry.CopResult */
export const COP = ["NoRecord", "Suspended", "NotVerified", "VerificationExpired", "NameMismatch", "Match"] as const;

export class OnChainView implements ChainView {
  readonly pub: PublicClient;
  private readonly account = loadAbi("PaddyAccount");
  private readonly registry = loadAbi("PayeeRegistry");
  private readonly book = loadAbi("InvoiceBook");
  private readonly d: typeof DEPLOYMENT;
  constructor(d = DEPLOYMENT, pub?: PublicClient) {
    this.d = d;
    this.pub = pub ?? createPublicClient({ transport: http(d.rpcUrl, { retryCount: 3 }) });
  }

  async session(key: Address): Promise<SessionState> {
    const [s, live, remaining] = await Promise.all([
      this.pub.readContract({ address: this.d.account, abi: this.account, functionName: "getSession", args: [key] }) as Promise<any>,
      this.pub.readContract({ address: this.d.account, abi: this.account, functionName: "isSessionLive", args: [key] }) as Promise<boolean>,
      this.pub.readContract({ address: this.d.account, abi: this.account, functionName: "remainingToday", args: [key] }) as Promise<bigint>,
    ]);
    return {
      live,
      revoked: s.revoked,
      validUntil: Number(s.validUntil),
      perPaymentCap: s.perPaymentCap,
      dailyBudget: s.dailyBudget,
      totalBudget: s.totalBudget,
      remainingToday: remaining,
      pending: Number(s.pending),
      requireVerifiedPayee: s.requireVerifiedPayee,
    };
  }

  async isSessionPayee(key: Address, payee: Address): Promise<boolean> {
    return (await this.pub.readContract({ address: this.d.account, abi: this.account, functionName: "isSessionPayee", args: [key, payee] })) as boolean;
  }

  async confirmPayee(wallet: Address, nameHash: Hex) {
    const [result, payeeId, recentlyChanged] = (await this.pub.readContract({
      address: this.d.registry,
      abi: this.registry,
      functionName: "confirmPayee",
      args: [wallet, nameHash],
    })) as [number, bigint, boolean];
    return { result: Number(result), payeeId, recentlyChanged };
  }

  async invoiceByRef(payeeId: bigint, ref: Hex): Promise<InvoiceView | null> {
    const id = (await this.pub.readContract({ address: this.d.book, abi: this.book, functionName: "invoiceIdByRef", args: [payeeId, ref] })) as bigint;
    if (id === 0n) return null;
    const inv = (await this.pub.readContract({ address: this.d.book, abi: this.book, functionName: "getInvoice", args: [id] })) as any;
    return { id, payeeId: inv.payeeId, payer: inv.payer, amount: inv.amount, paid: inv.paid, status: Number(inv.status) };
  }

  async payability(invoiceId: bigint, payer: Address): Promise<number> {
    return Number(await this.pub.readContract({ address: this.d.book, abi: this.book, functionName: "payability", args: [invoiceId, payer] }));
  }

  async balance(): Promise<bigint> {
    return (await this.pub.readContract({
      address: this.d.tusd8,
      abi: [{ type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] }],
      functionName: "balanceOf",
      args: [this.d.account],
    })) as bigint;
  }
}
