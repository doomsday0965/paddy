import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  decodeEventLog,
  hashDomain,
  keccak256,
  parseSignature,
  toBytes,
  toHex,
  verifyTypedData,
  type Abi,
  type Address,
  type Hex,
  type LocalAccount,
  type PublicClient,
  type WalletClient,
} from "viem";
import { DEPLOYMENT, NGN_PER_USD, loadAbi } from "./config.ts";

export const TUSD8_DOMAIN = { name: "tUSD8", version: "2", chainId: DEPLOYMENT.chainId, verifyingContract: DEPLOYMENT.tusd8 } as const;
export const RECEIVE_TYPES = {
  ReceiveWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;
const STATUS = ["None", "Open", "Paid", "Cancelled"];
const PAYABILITY = ["Payable", "Not open", "Payee suspended", "Frozen: payee changed wallet, awaiting re-confirmation", "Not the invoiced payer"];

export interface InvoiceMeta {
  label: string;
  reference: string;
  createdAt: string;
  items?: { description: string; amount: string }[];
}

export interface RelayRequest {
  from: Address;
  amount: string;
  validAfter: string;
  validBefore: string;
  salt: Hex;
  signature: Hex;
}

/** Customer invoice pay page backend: read an invoice, build the EIP-3009 authorization to sign, relay it gaslessly. */
export class Invoices {
  private readonly book: Abi = loadAbi("InvoiceBook");
  private readonly registry: Abi = loadAbi("PayeeRegistry");
  private readonly pub: PublicClient;
  private readonly relayer: WalletClient | null;
  private readonly merchant: WalletClient | null;
  private readonly customer: LocalAccount | null;
  private readonly metaPath: string;
  private meta: Record<string, InvoiceMeta>;
  private readonly demoPaid = new Set<string>();
  private readonly d = DEPLOYMENT;

  constructor(o: { pub: PublicClient; relayer: WalletClient | null; merchant: WalletClient | null; demoCustomer: LocalAccount | null; metaPath: string }) {
    this.pub = o.pub;
    this.relayer = o.relayer;
    this.merchant = o.merchant;
    this.customer = o.demoCustomer;
    this.metaPath = o.metaPath;
    this.meta = existsSync(o.metaPath) ? JSON.parse(readFileSync(o.metaPath, "utf8")) : {};
  }

  get canCreate() {
    return !!this.merchant;
  }
  get canDemoPay() {
    return !!this.customer && !!this.relayer;
  }
  get canRelay() {
    return !!this.relayer;
  }

  /** Startup self-check: our EIP-712 domain must equal the token's DOMAIN_SEPARATOR. */
  async checkDomain(): Promise<boolean> {
    const onchain = (await this.pub.readContract({
      address: this.d.tusd8,
      abi: [{ type: "function", name: "DOMAIN_SEPARATOR", stateMutability: "view", inputs: [], outputs: [{ type: "bytes32" }] }],
      functionName: "DOMAIN_SEPARATOR",
    })) as Hex;
    return onchain === hashDomain({ domain: TUSD8_DOMAIN, types: { EIP712Domain: [{ name: "name", type: "string" }, { name: "version", type: "string" }, { name: "chainId", type: "uint256" }, { name: "verifyingContract", type: "address" }] } });
  }

  async view(id: bigint) {
    const inv = (await this.pub.readContract({ address: this.d.book, abi: this.book, functionName: "getInvoice", args: [id] })) as any;
    if (Number(inv.status) === 0) return null;
    const payee = (await this.pub.readContract({ address: this.d.registry, abi: this.registry, functionName: "getPayee", args: [inv.payeeId] })) as any;
    const payer = inv.payer as Address;
    const code = Number(await this.pub.readContract({ address: this.d.book, abi: this.book, functionName: "payability", args: [id, payer === "0x0000000000000000000000000000000000000000" ? this.d.account : payer] }));
    const now = Math.floor(Date.now() / 1000);
    const verified = Number(payee.status) === 2 && Number(payee.verifiedUntil) > now;
    const remaining = (inv.amount as bigint) - (inv.paid as bigint);
    return {
      id: id.toString(),
      merchant: { name: payee.displayName as string, wallet: payee.wallet as Address, verified, verifiedUntil: Number(payee.verifiedUntil), settled: Number(payee.settledInvoices), onTime: Number(payee.settledOnTime) },
      payer,
      amount: inv.amount as bigint,
      paid: inv.paid as bigint,
      remaining,
      ngnApprox: Math.round((Number(remaining) / 1e6) * NGN_PER_USD),
      status: STATUS[Number(inv.status)],
      issuedAt: Number(inv.issuedAt),
      dueDate: Number(inv.dueDate),
      feeBps: Number(inv.feeBps),
      payable: code === 0,
      payability: PAYABILITY[code] ?? `code ${code}`,
      meta: this.meta[id.toString()] ?? null,
    };
  }

  /** Typed data the customer's wallet signs. The nonce binds the signature to this invoice + amount (InvoiceBook.authorizationNonce). */
  async authorization(id: bigint, from: Address) {
    const v = await this.view(id);
    if (!v) throw new Error("invoice not found");
    if (!v.payable || v.status !== "Open") throw new Error(`invoice can't be paid: ${v.payability}`);
    const salt = toHex(crypto.getRandomValues(new Uint8Array(32)));
    const nonce = (await this.pub.readContract({ address: this.d.book, abi: this.book, functionName: "authorizationNonce", args: [id, from, v.remaining, salt] })) as Hex;
    const now = Math.floor(Date.now() / 1000);
    const message = { from, to: this.d.book, value: v.remaining.toString(), validAfter: "0", validBefore: String(now + 3600), nonce };
    return { salt, typedData: { domain: TUSD8_DOMAIN, types: RECEIVE_TYPES, primaryType: "ReceiveWithAuthorization" as const, message } };
  }

  /** Verify off-chain, simulate, then submit payWithAuthorization from the relayer (customer pays no gas). */
  async relay(id: bigint, r: RelayRequest) {
    if (!this.relayer) throw new Error("relayer not configured");
    const amount = BigInt(r.amount);
    const v = await this.view(id);
    if (!v || v.status !== "Open") throw new Error("invoice is not open");
    if (amount !== v.remaining) throw new Error("amount must equal the invoice balance");
    const nonce = (await this.pub.readContract({ address: this.d.book, abi: this.book, functionName: "authorizationNonce", args: [id, r.from, amount, r.salt] })) as Hex;
    const ok = await verifyTypedData({
      address: r.from,
      domain: TUSD8_DOMAIN,
      types: RECEIVE_TYPES,
      primaryType: "ReceiveWithAuthorization",
      message: { from: r.from, to: this.d.book, value: amount, validAfter: BigInt(r.validAfter), validBefore: BigInt(r.validBefore), nonce },
      signature: r.signature,
    });
    if (!ok) throw new Error("signature does not match this invoice and amount");
    const sig = parseSignature(r.signature);
    const vNum = sig.v !== undefined ? Number(sig.v) : 27 + (sig.yParity ?? 0);
    const args = [id, r.from, amount, BigInt(r.validAfter), BigInt(r.validBefore), r.salt, vNum, sig.r, sig.s] as const;
    const { request } = await this.pub.simulateContract({ account: this.relayer.account!, address: this.d.book, abi: this.book, functionName: "payWithAuthorization", args });
    const tx = await this.relayer.writeContract(request as never);
    const rc = await this.pub.waitForTransactionReceipt({ hash: tx });
    let receiptId: string | undefined;
    for (const l of rc.logs) {
      if (l.address.toLowerCase() !== this.d.book.toLowerCase()) continue;
      try {
        const ev = decodeEventLog({ abi: this.book, data: l.data, topics: l.topics });
        if (ev.eventName === "PaymentReceived") receiptId = String((ev.args as any).receiptId);
      } catch {
        /* other event */
      }
    }
    return { tx, success: rc.status === "success", receiptId };
  }

  /** Judge/demo helper: a server-held testnet "customer" signs and pays (once per invoice). */
  async demoPay(id: bigint) {
    if (!this.customer) throw new Error("demo customer not enabled");
    if (this.demoPaid.has(id.toString())) throw new Error("already paid in this demo");
    const { salt, typedData } = await this.authorization(id, this.customer.address);
    const signature = await this.customer.signTypedData({ ...typedData, message: { ...typedData.message, value: BigInt(typedData.message.value), validAfter: 0n, validBefore: BigInt(typedData.message.validBefore) } } as never);
    this.demoPaid.add(id.toString());
    return this.relay(id, { from: this.customer.address, amount: typedData.message.value, validAfter: "0", validBefore: typedData.message.validBefore, salt, signature });
  }

  /** The merchant (a registered, verified Paddy payee) issues an invoice; returns its id. */
  async create(i: { amount: bigint; label: string; reference: string; payer?: Address; days?: number }) {
    if (!this.merchant) throw new Error("merchant key not configured");
    const meta: InvoiceMeta = { label: i.label, reference: i.reference, createdAt: new Date().toISOString() };
    const metadataHash = keccak256(toBytes(JSON.stringify(meta)));
    const due = BigInt(Math.floor(Date.now() / 1000) + Math.round((i.days ?? 7) * 86400));
    const ref = keccak256(toBytes(i.reference.trim().toUpperCase()));
    const args = [i.payer ?? "0x0000000000000000000000000000000000000000", i.amount, due, ref, metadataHash, false] as const;
    const { request } = await this.pub.simulateContract({ account: this.merchant.account!, address: this.d.book, abi: this.book, functionName: "createInvoice", args });
    const tx = await this.merchant.writeContract(request as never);
    const rc = await this.pub.waitForTransactionReceipt({ hash: tx });
    let id = "";
    for (const l of rc.logs) {
      try {
        const ev = decodeEventLog({ abi: this.book, data: l.data, topics: l.topics });
        if (ev.eventName === "InvoiceCreated") id = String((ev.args as any).invoiceId);
      } catch {
        /* other event */
      }
    }
    if (!id) throw new Error("InvoiceCreated not found in receipt");
    this.meta[id] = meta;
    mkdirSync(dirname(this.metaPath), { recursive: true });
    writeFileSync(this.metaPath, JSON.stringify(this.meta, null, 2));
    return { id, tx };
  }
}
