import { encodeFunctionData, erc20Abi, type Abi, type Address, type Hex, type LocalAccount, type PublicClient } from "viem";
import { entryPoint07Abi } from "viem/account-abstraction";
import { signAsOwner, toRpc, type UserOp } from "../../bundler/src/userop.ts";
import { COP } from "./chain.ts";
import { DEPLOYMENT, loadAbi } from "./config.ts";
import { decodeAccountEvents } from "./executor.ts";
import { nameHash, type Contact } from "./names.ts";

const REQUEST_TTL = 7 * 86400;
const LIMITS = ["None", "PerPaymentCap", "DailyBudget", "TotalBudget"];
const ZERO = "0x0000000000000000000000000000000000000000";

export interface OwnerOpResult {
  userOpHash: Hex;
  tx: Hex;
  success: boolean;
  events: string[];
}

export interface SessionParams {
  label: string;
  perPaymentCap: bigint;
  dailyBudget: bigint;
  totalBudget: bigint;
  days: number;
  payees: Address[];
  requireVerifiedPayee: boolean;
}

/** Owner-side reads and owner userOps (signed server-side with the testnet owner key, sent via the Paddy bundler). */
export class OwnerConsole {
  private readonly abi: Abi = loadAbi("PaddyAccount");
  private readonly pub: PublicClient;
  private readonly owner: LocalAccount | null;
  private readonly contacts: Contact[];
  private readonly d: typeof DEPLOYMENT;
  constructor(o: { pub: PublicClient; owner: LocalAccount | null; contacts: Contact[]; d?: typeof DEPLOYMENT }) {
    this.pub = o.pub;
    this.owner = o.owner;
    this.contacts = o.contacts;
    this.d = o.d ?? DEPLOYMENT;
  }

  private read<T>(functionName: string, args: unknown[] = []): Promise<T> {
    return this.pub.readContract({ address: this.d.account, abi: this.abi, functionName, args }) as Promise<T>;
  }

  name(a: string): string {
    return this.contacts.find((c) => c.wallet.toLowerCase() === a.toLowerCase())?.legalName ?? `${a.slice(0, 6)}…${a.slice(-4)}`;
  }

  async balance(): Promise<bigint> {
    return this.pub.readContract({ address: this.d.tusd8, abi: erc20Abi, functionName: "balanceOf", args: [this.d.account] });
  }

  async session(key: Address | null) {
    if (!key) return null;
    const [s, live, remaining] = await Promise.all([
      this.read<any>("getSession", [key]),
      this.read<boolean>("isSessionLive", [key]),
      this.read<bigint>("remainingToday", [key]),
    ]);
    if (Number(s.validUntil) === 0) return { address: key, exists: false };
    const payees = await Promise.all(
      this.contacts.map(async (c) => {
        const [allowed, cop] = await Promise.all([
          this.read<boolean>("isSessionPayee", [key, c.wallet]),
          this.pub.readContract({ address: this.d.registry, abi: loadAbi("PayeeRegistry"), functionName: "confirmPayee", args: [c.wallet, nameHash(c.legalName)] }) as Promise<any>,
        ]);
        const result = Number(Array.isArray(cop) ? cop[0] : cop.result);
        return { name: c.legalName, wallet: c.wallet, allowed, cop: COP[result] ?? String(result) };
      }),
    );
    return {
      address: key,
      exists: true,
      label: s.label as string,
      live,
      revoked: s.revoked as boolean,
      validAfter: Number(s.validAfter),
      validUntil: Number(s.validUntil),
      requireVerifiedPayee: s.requireVerifiedPayee as boolean,
      perPaymentCap: s.perPaymentCap as bigint,
      dailyBudget: s.dailyBudget as bigint,
      totalBudget: s.totalBudget as bigint,
      totalSpent: s.totalSpent as bigint,
      remainingToday: remaining,
      pending: Number(s.pending),
      payees,
    };
  }

  async approvals() {
    const count = Number(await this.read<bigint>("requestCount"));
    const now = Math.floor(Date.now() / 1000);
    const out = [];
    for (let id = count; id >= Math.max(1, count - 30); id--) {
      const r = await this.read<any>("getRequest", [BigInt(id)]);
      const status = ["None", "Pending", "Approved", "Rejected"][Number(r.status)] ?? "Unknown";
      const expired = Number(r.createdAt) + REQUEST_TTL < now;
      out.push({
        id,
        status: status === "Pending" && expired ? "Expired" : status,
        limit: LIMITS[Number(r.limit)] ?? String(r.limit),
        sessionKey: r.sessionKey as Address,
        payee: r.payee as Address,
        payeeName: this.name(r.payee),
        amount: r.amount as bigint,
        invoiceId: r.invoiceId as bigint,
        createdAt: Number(r.createdAt),
        expiresAt: Number(r.createdAt) + REQUEST_TTL,
      });
    }
    return out;
  }

  async sendOwnerOp(callData: Hex): Promise<OwnerOpResult> {
    if (!this.owner) throw new Error("owner key not configured on the server");
    const nonce = (await this.pub.readContract({ address: this.d.entryPoint, abi: entryPoint07Abi, functionName: "getNonce", args: [this.d.account, 0n] })) as bigint;
    const op: UserOp = {
      sender: this.d.account,
      nonce,
      callData,
      callGasLimit: 600_000n,
      verificationGasLimit: 300_000n,
      preVerificationGas: 60_000n,
      maxFeePerGas: 2_000_000_000n,
      maxPriorityFeePerGas: 1_000_000_000n,
      paymaster: this.d.paymaster,
      paymasterVerificationGasLimit: 100_000n,
      paymasterPostOpGasLimit: 60_000n,
      paymasterData: "0x",
      signature: "0x",
    };
    const signed = await signAsOwner(op, this.owner, this.d.chainId);
    const userOpHash = (await bundlerRpc(this.d.bundlerUrl, "eth_sendUserOperation", [toRpc(signed), this.d.entryPoint])) as Hex;
    const r = await bundlerRpc(this.d.bundlerUrl, "eth_getUserOperationReceipt", [userOpHash]);
    await waitForBlock(this.pub, BigInt(r.receipt.blockNumber));
    return { userOpHash, tx: r.receipt.transactionHash, success: r.success, events: decodeAccountEvents(this.abi, this.d.account, r.logs).map((e) => e.event) };
  }

  createSession(key: Address, p: SessionParams) {
    const now = Math.floor(Date.now() / 1000);
    return this.sendOwnerOp(
      encodeFunctionData({
        abi: this.abi,
        functionName: "createSession",
        args: [key, p.label, 0, now + Math.round(p.days * 86400), p.perPaymentCap, p.dailyBudget, p.totalBudget, p.requireVerifiedPayee, p.payees],
      }),
    );
  }
  revoke(key: Address) {
    return this.sendOwnerOp(encodeFunctionData({ abi: this.abi, functionName: "revokeSession", args: [key] }));
  }
  approve(id: number) {
    return this.sendOwnerOp(encodeFunctionData({ abi: this.abi, functionName: "approveRequest", args: [BigInt(id)] }));
  }
  reject(id: number) {
    return this.sendOwnerOp(encodeFunctionData({ abi: this.abi, functionName: "rejectRequest", args: [BigInt(id)] }));
  }
}

/** The public RPC can lag the bundler's node by a block or two: wait so the next read reflects this op. */
export async function waitForBlock(pub: PublicClient, block: bigint, timeoutMs = 15_000) {
  const until = Date.now() + timeoutMs;
  let seen = 0;
  while (Date.now() < until) {
    if ((await pub.getBlockNumber({ cacheTime: 0 })) >= block && ++seen >= 2) return;
    await new Promise((r) => setTimeout(r, 700));
  }
}

let rpcId = 1;
export async function bundlerRpc(url: string, method: string, params: unknown[]): Promise<any> {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json", ...(process.env.BUNDLER_TOKEN ? { authorization: `Bearer ${process.env.BUNDLER_TOKEN}` } : {}) }, body: JSON.stringify({ jsonrpc: "2.0", id: rpcId++, method, params }) });
  const j = await res.json();
  if (j.error) throw Object.assign(new Error(`bundler: ${j.error.message}`), { code: j.error.code });
  return j.result;
}
export { ZERO };
