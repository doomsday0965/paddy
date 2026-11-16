/** Thin API client. The only credential the browser ever holds is the optional owner token (never a key). */
const TOKEN_KEY = "paddy.ownerToken";
export const ownerToken = {
  get: () => localStorage.getItem(TOKEN_KEY) ?? "",
  set: (t: string) => localStorage.setItem(TOKEN_KEY, t),
  clear: () => localStorage.removeItem(TOKEN_KEY),
};

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export async function api<T = any>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const headers: Record<string, string> = { accept: "application/json" };
  const t = ownerToken.get();
  if (t) headers.authorization = `Bearer ${t}`;
  if (init.body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(`/api${path}`, { method: init.method ?? (init.body !== undefined ? "POST" : "GET"), headers, body: init.body !== undefined ? JSON.stringify(init.body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data.error ?? `HTTP ${res.status}`);
  return data as T;
}

export interface Config {
  chainId: number;
  chainName: string;
  explorer: string;
  account: string;
  ngnPerUsd: number;
  contacts: { name: string; wallet: string }[];
  features: { gemini: boolean; ownerOps: boolean; merchant: boolean; relay: boolean; demoCustomer: boolean };
  demoMode: boolean;
  ownerAuth: "token" | "local";
  isOwner: boolean;
}

export interface Session {
  address: string;
  exists: boolean;
  label?: string;
  live?: boolean;
  revoked?: boolean;
  validUntil?: number;
  requireVerifiedPayee?: boolean;
  perPaymentCap?: string;
  dailyBudget?: string;
  totalBudget?: string;
  totalSpent?: string;
  remainingToday?: string;
  pending?: number;
  payees?: { name: string; wallet: string; allowed: boolean; cop: string }[];
}

export interface Plan {
  id: string;
  decision: "execute" | "queue_for_owner" | "needs_owner_review" | "reject" | "clarify" | "info";
  summary: string;
  reasons: string[];
  flags: string[];
  source: string;
  payee?: { legalName: string; wallet: string; cop: string };
  amount?: { units: string; display: string; from: string };
}
export interface ChatResult {
  plan: Plan;
  execution?: { tx: string; userOpHash: string; success: boolean; events: { event: string }[]; replayed?: boolean };
}
export interface Approval {
  id: number;
  status: "Pending" | "Approved" | "Rejected" | "Expired";
  limit: string;
  payee: string;
  payeeName: string;
  amount: string;
  createdAt: number;
  expiresAt: number;
  invoiceId: string;
}
export interface AuditEntry {
  block: number;
  time: string;
  tx: string;
  event: string;
  summary: string;
}
export interface OwnerOpResult {
  simulated?: boolean;
  note?: string;
  tx?: string;
  success?: boolean;
  events?: string[];
  sessionKey?: string;
}
export interface Invoice {
  id: string;
  merchant: { name: string; wallet: string; verified: boolean; verifiedUntil: number; settled: number; onTime: number };
  payer: string;
  amount: string;
  paid: string;
  remaining: string;
  ngnApprox: number;
  status: "Open" | "Paid" | "Cancelled";
  issuedAt: number;
  dueDate: number;
  feeBps: number;
  payable: boolean;
  payability: string;
  meta: { label: string; reference: string } | null;
}
export interface StoryStep {
  kind: "owner" | "paddy" | "chain" | "narrator" | "approval";
  text: string;
  attachment?: string;
  decision?: Plan["decision"];
  flags?: string[];
  amount?: string;
  tx?: string;
  link?: string;
  events?: string[];
}
