import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { decodeEventLog, encodeFunctionData, type Abi, type Address, type Hex, type LocalAccount, type PublicClient } from "viem";
import { entryPoint07Abi } from "viem/account-abstraction";
import { signAsSession, toRpc, type UserOp } from "../../bundler/src/userop.ts";
import { DEPLOYMENT, loadAbi } from "./config.ts";
import type { Plan } from "./planner.ts";

export interface ExecutionResult {
  planId: Hex;
  userOpHash: Hex;
  tx: Hex;
  success: boolean;
  events: { event: string; args: Record<string, unknown> }[];
  replayed?: boolean;
}

/**
 * Signs the planned call with the session key and sends it through the Paddy bundler.
 * Idempotent per plan id (journal on disk), so a retried chat message never pays twice.
 */
export class Executor {
  private readonly abi: Abi = loadAbi("PaddyAccount");
  private journal: Record<string, ExecutionResult>;
  private readonly pub: PublicClient;
  private readonly session: LocalAccount;
  private readonly journalPath: string;
  private readonly d: typeof DEPLOYMENT;
  constructor(pub: PublicClient, session: LocalAccount, journalPath: string, d = DEPLOYMENT) {
    this.pub = pub;
    this.session = session;
    this.journalPath = journalPath;
    this.d = d;
    this.journal = existsSync(journalPath) ? JSON.parse(readFileSync(journalPath, "utf8")) : {};
  }

  async execute(p: Plan): Promise<ExecutionResult> {
    if (p.decision !== "execute" && p.decision !== "queue_for_owner") throw new Error(`plan ${p.decision} is not executable`);
    if (!p.call) throw new Error("plan has no call");
    const prior = this.journal[p.id];
    if (prior) return { ...prior, replayed: true };

    const c = p.call;
    const callData =
      c.fn === "sessionTransfer"
        ? encodeFunctionData({ abi: this.abi, functionName: "sessionTransfer", args: [this.session.address, c.payee, c.amount, c.ref] })
        : encodeFunctionData({ abi: this.abi, functionName: "sessionPayInvoice", args: [this.session.address, c.invoiceId!, c.amount] });
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
    const signed = await signAsSession(op, this.session, this.d.chainId);
    const userOpHash = (await rpc(this.d.bundlerUrl, "eth_sendUserOperation", [toRpc(signed), this.d.entryPoint])) as Hex;
    const r = await rpc(this.d.bundlerUrl, "eth_getUserOperationReceipt", [userOpHash]);
    const events = decodeAccountEvents(this.abi, this.d.account, r.logs);
    const result: ExecutionResult = { planId: p.id, userOpHash, tx: r.receipt.transactionHash, success: r.success, events };
    this.journal[p.id] = result;
    mkdirSync(dirname(this.journalPath), { recursive: true });
    writeFileSync(this.journalPath, JSON.stringify(this.journal, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2));
    return result;
  }
}

export function decodeAccountEvents(abi: Abi, account: Address, logs: { address: string; data: Hex; topics: Hex[] }[]) {
  const out: { event: string; args: Record<string, unknown> }[] = [];
  for (const l of logs) {
    if (l.address.toLowerCase() !== account.toLowerCase()) continue;
    try {
      const ev = decodeEventLog({ abi, data: l.data, topics: l.topics as never });
      out.push({ event: ev.eventName as string, args: ev.args as Record<string, unknown> });
    } catch {
      /* ignore */
    }
  }
  return out;
}

let rpcId = 1;
async function rpc(url: string, method: string, params: unknown[]): Promise<any> {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: rpcId++, method, params }) });
  const j = await res.json();
  if (j.error) throw Object.assign(new Error(`bundler: ${j.error.message}`), { code: j.error.code });
  return j.result;
}
