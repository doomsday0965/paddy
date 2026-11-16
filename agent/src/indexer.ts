import { decodeEventLog, type Abi, type Address, type PublicClient } from "viem";
import { formatTusd8 } from "./money.ts";

export interface AuditEntry {
  block: number;
  time: string;
  tx: string;
  event: string;
  summary: string;
  args: Record<string, unknown>;
}

const BLOCK_REASONS = ["SessionInactive", "PayeeNotAllowed", "PayeeNotVerified", "InvoiceNotPayable", "ZeroAmount", "TooManyPending"];
const LIMITS = ["None", "PerPaymentCap", "DailyBudget", "TotalBudget"];
const short = (a: unknown) => `${String(a).slice(0, 6)}…${String(a).slice(-4)}`;

/** Reads every PaddyAccount event (in block chunks) and renders a plain-language audit trail. */
export async function indexAccount(
  pub: PublicClient,
  abi: Abi,
  account: Address,
  fromBlock: bigint,
  opts: { chunk?: bigint; names?: Record<string, string>; toBlock?: bigint } = {},
): Promise<AuditEntry[]> {
  const chunk = opts.chunk ?? 1_000n; // Aevum RPC caps eth_getLogs at 1000 blocks
  const latest = opts.toBlock ?? (await pub.getBlockNumber());
  const entries: AuditEntry[] = [];
  const times = new Map<bigint, string>();
  const nm = (a: unknown) => opts.names?.[String(a).toLowerCase()] ?? short(a);
  for (let start = fromBlock; start <= latest; start += chunk) {
    const end = start + chunk - 1n > latest ? latest : start + chunk - 1n;
    const logs = await pub.getLogs({ address: account, fromBlock: start, toBlock: end });
    for (const l of logs) {
      let ev;
      try {
        ev = decodeEventLog({ abi, data: l.data, topics: l.topics });
      } catch {
        continue;
      }
      const a = ev.args as Record<string, any>;
      if (!times.has(l.blockNumber!)) {
        const b = await pub.getBlock({ blockNumber: l.blockNumber! });
        times.set(l.blockNumber!, new Date(Number(b.timestamp) * 1000).toISOString());
      }
      entries.push({
        block: Number(l.blockNumber),
        time: times.get(l.blockNumber!)!,
        tx: l.transactionHash!,
        event: ev.eventName as string,
        summary: describe(ev.eventName as string, a, nm),
        args: JSON.parse(JSON.stringify(a, (_k, v) => (typeof v === "bigint" ? v.toString() : v))),
      });
    }
  }
  return entries;
}

function describe(name: string, a: Record<string, any>, nm: (x: unknown) => string): string {
  switch (name) {
    case "SessionCreated":
      return `Session opened for ${nm(a.sessionKey)} "${a.label}": cap ${formatTusd8(a.perPaymentCap)}, daily ${formatTusd8(a.dailyBudget)}, total ${formatTusd8(a.totalBudget)}, until ${new Date(Number(a.validUntil) * 1000).toISOString()}`;
    case "SessionPayeeSet":
      return `${a.allowed ? "Approved" : "Removed"} payee ${nm(a.payee)} for ${nm(a.sessionKey)}`;
    case "SessionPayment":
      return `AI clerk paid ${formatTusd8(a.amount)} to ${nm(a.payee)}${a.invoiceId && a.invoiceId !== 0n ? ` (invoice #${a.invoiceId})` : ""}`;
    case "SessionActionBlocked":
      return `BLOCKED: clerk tried ${formatTusd8(a.amount)} to ${nm(a.payee)} (${BLOCK_REASONS[Number(a.reason)] ?? a.reason})`;
    case "ApprovalRequested":
      return `Approval request #${a.requestId}: ${formatTusd8(a.amount)} to ${nm(a.payee)} (${LIMITS[Number(a.limit)] ?? a.limit})`;
    case "RequestApproved":
      return `Owner approved request #${a.requestId}: ${formatTusd8(a.amount)} to ${nm(a.payee)}`;
    case "RequestRejected":
      return `Owner rejected request #${a.requestId}`;
    case "SessionRevoked":
      return `Session ${nm(a.sessionKey)} REVOKED by ${nm(a.by)}`;
    case "OwnerExecuted":
      return `Owner call to ${nm(a.target)} (${a.selector})`;
    case "OwnerChanged":
      return `Owner set to ${nm(a.newOwner)}`;
    default:
      return name;
  }
}
