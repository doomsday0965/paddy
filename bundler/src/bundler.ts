import {
  BaseError,
  ContractFunctionRevertedError,
  decodeEventLog,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
  type Account,
  type Chain,
  type Transport,
  type TransactionReceipt,
} from "viem";
import { entryPoint07Abi } from "viem/account-abstraction";
import { ENTRY_POINT_V07 } from "./chain.ts";
import { pack, userOpHash, type UserOp } from "./userop.ts";

export class UserOpRejected extends Error {
  readonly code: number;
  readonly reason: string;
  constructor(reason: string, code = -32500) {
    super(reason);
    this.reason = reason;
    this.code = code;
  }
}

export interface UserOpReceipt {
  userOpHash: Hex;
  entryPoint: Address;
  sender: Address;
  nonce: Hex;
  paymaster: Address;
  actualGasCost: Hex;
  actualGasUsed: Hex;
  success: boolean;
  reason: string;
  logs: TransactionReceipt["logs"];
  receipt: TransactionReceipt;
}

type Wallet = WalletClient<Transport, Chain, Account>;

export interface BundlerOptions {
  publicClient: PublicClient;
  walletClient: Wallet;
  entryPoint?: Address;
  /** extra gas on top of the estimate for the handleOps tx */
  gasBufferPct?: number;
  maxRetries?: number;
  receiptTimeoutMs?: number;
  log?: (msg: string) => void;
}

/**
 * Minimal single-op ERC-4337 bundler for EntryPoint v0.7.
 *  - simulates `handleOps` with eth_call before sending, so bad ops (expired/revoked keys,
 *    bad signatures, unsponsored accounts) are rejected without spending gas;
 *  - idempotent by userOpHash: re-sending the same op returns the same hash;
 *  - serialises submissions (one EOA, no nonce races) and retries transient RPC failures.
 * It does NOT implement the ERC-7562 mempool rules: it is a private relayer for Paddy accounts.
 */
export class MiniBundler {
  readonly entryPoint: Address;
  private readonly pub: PublicClient;
  private readonly wallet: Wallet;
  private readonly opts: Required<Omit<BundlerOptions, "publicClient" | "walletClient" | "entryPoint">>;
  private readonly known = new Map<Hex, Promise<TransactionReceipt>>();
  private queue: Promise<unknown> = Promise.resolve();

  constructor(o: BundlerOptions) {
    this.pub = o.publicClient;
    this.wallet = o.walletClient;
    this.entryPoint = o.entryPoint ?? ENTRY_POINT_V07;
    this.opts = {
      gasBufferPct: o.gasBufferPct ?? 25,
      maxRetries: o.maxRetries ?? 3,
      receiptTimeoutMs: o.receiptTimeoutMs ?? 90_000,
      log: o.log ?? (() => {}),
    };
  }

  get chainId(): number {
    return this.wallet.chain.id;
  }

  hash(op: UserOp): Hex {
    return userOpHash(op, this.chainId, this.entryPoint);
  }

  /** Simulate handleOps; throws UserOpRejected with the EntryPoint reason (e.g. "AA24 signature error"). */
  async simulate(op: UserOp): Promise<bigint> {
    const args = [[pack(op)], this.wallet.account.address] as const;
    try {
      await this.pub.simulateContract({
        address: this.entryPoint,
        abi: entryPoint07Abi,
        functionName: "handleOps",
        args: args as never,
        account: this.wallet.account,
      });
      return await this.pub.estimateContractGas({
        address: this.entryPoint,
        abi: entryPoint07Abi,
        functionName: "handleOps",
        args: args as never,
        account: this.wallet.account,
      });
    } catch (e) {
      throw new UserOpRejected(decodeEntryPointError(e));
    }
  }

  /**
   * eth_sendUserOperation. Simulates inside the submission queue (so ops from the same account with
   * consecutive nonces are checked against up-to-date state), submits, waits for inclusion and
   * returns the userOpHash. Re-sending a known op returns the same hash without resubmitting.
   */
  async send(op: UserOp): Promise<Hex> {
    const h = this.hash(op);
    const existing = this.known.get(h);
    if (existing) {
      await existing;
      return h;
    }
    const p = this.enqueue(async () => {
      const gas = await this.simulate(op);
      return this.submit(op, gas, h);
    });
    this.known.set(h, p);
    try {
      await p;
    } catch (e) {
      this.known.delete(h);
      if (e instanceof UserOpRejected) throw e;
      throw new UserOpRejected(String((e as Error).message ?? e).slice(0, 300), -32000);
    }
    return h;
  }

  /** eth_getUserOperationReceipt */
  async receipt(h: Hex): Promise<UserOpReceipt | null> {
    const p = this.known.get(h);
    if (!p) return null;
    const receipt = await p;
    return parseUserOpReceipt(receipt, h, this.entryPoint);
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async submit(op: UserOp, gasEstimate: bigint, h: Hex): Promise<TransactionReceipt> {
    const gas = (gasEstimate * BigInt(100 + this.opts.gasBufferPct)) / 100n;
    let lastErr: unknown;
    for (let attempt = 1; attempt <= this.opts.maxRetries; attempt++) {
      try {
        const txHash = await this.wallet.writeContract({
          address: this.entryPoint,
          abi: entryPoint07Abi,
          functionName: "handleOps",
          args: [[pack(op)], this.wallet.account.address] as never,
          gas,
        });
        this.opts.log(`userOp ${h} -> tx ${txHash} (attempt ${attempt})`);
        return await this.pub.waitForTransactionReceipt({ hash: txHash, timeout: this.opts.receiptTimeoutMs });
      } catch (e) {
        lastErr = e;
        const msg = String((e as Error).message ?? e).toLowerCase();
        const transient = /nonce|underpriced|timeout|timed out|econnreset|fetch failed|429|503/.test(msg);
        this.opts.log(`submit attempt ${attempt} failed${transient ? " (retrying)" : ""}: ${msg.slice(0, 160)}`);
        if (!transient) break;
        await new Promise((r) => setTimeout(r, 1500 * attempt));
      }
    }
    throw lastErr;
  }
}

export function decodeEntryPointError(e: unknown): string {
  if (e instanceof BaseError) {
    const rev = e.walk((x) => x instanceof ContractFunctionRevertedError) as ContractFunctionRevertedError | null;
    if (rev?.data?.errorName === "FailedOp") return String(rev.data.args?.[1]);
    if (rev?.data?.errorName === "FailedOpWithRevert") {
      return `${String(rev.data.args?.[1])} ${String(rev.data.args?.[2] ?? "")}`.trim();
    }
    if (rev?.reason) return rev.reason;
    return e.shortMessage;
  }
  return String(e);
}

export function parseUserOpReceipt(receipt: TransactionReceipt, h: Hex, entryPoint: Address): UserOpReceipt | null {
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== entryPoint.toLowerCase()) continue;
    try {
      const ev = decodeEventLog({ abi: entryPoint07Abi, data: log.data, topics: log.topics });
      if (ev.eventName === "UserOperationEvent" && ev.args.userOpHash === h) {
        let reason = "";
        for (const l2 of receipt.logs) {
          try {
            const r = decodeEventLog({ abi: entryPoint07Abi, data: l2.data, topics: l2.topics });
            if (r.eventName === "UserOperationRevertReason" && r.args.userOpHash === h) reason = r.args.revertReason;
          } catch {
            /* not an EntryPoint event */
          }
        }
        return {
          userOpHash: h,
          entryPoint,
          sender: ev.args.sender,
          nonce: `0x${ev.args.nonce.toString(16)}`,
          paymaster: ev.args.paymaster,
          actualGasCost: `0x${ev.args.actualGasCost.toString(16)}`,
          actualGasUsed: `0x${ev.args.actualGasUsed.toString(16)}`,
          success: ev.args.success,
          reason,
          logs: receipt.logs,
          receipt,
        };
      }
    } catch {
      /* not an EntryPoint event */
    }
  }
  return null;
}
