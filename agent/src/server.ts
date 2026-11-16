import { createServer } from "node:http";
import { join } from "node:path";
import { createPublicClient, createWalletClient, http, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { aevumTestnet } from "../../bundler/src/chain.ts";
import { createAgent } from "./agent.ts";
import { createApp, HttpError, type Services } from "./app.ts";
import { DEPLOYMENT as D, NGN_PER_USD, REPO_ROOT, loadAbi, loadContacts } from "./config.ts";
import { story } from "./demo.ts";
import { GeminiClient } from "./gemini.ts";
import { indexAccount, type AuditEntry } from "./indexer.ts";
import { Invoices } from "./invoices.ts";
import { SessionKeystore } from "./keystore.ts";
import { OwnerConsole } from "./owner.ts";

/**
 * Paddy server: owner console API + customer pay page API + the built web app (web/dist).
 * All keys stay here, never in the browser:
 *   OWNER_PRIVATE_KEY (or PRIVATE_KEY)  testnet owner of the SME smart account (signs owner userOps)
 *   RELAYER_PRIVATE_KEY (or PRIVATE_KEY) pays gas for customers' gasless invoice payments
 *   MERCHANT_PRIVATE_KEY (optional)      a verified payee wallet that issues invoices from "Get paid"
 *   DEMO_CUSTOMER_PRIVATE_KEY (optional) testnet customer for the one-tap demo payment
 *   CLERK_PRIVATE_KEY (optional)         imported into the session keystore on first run
 *   GEMINI_API_KEY (optional), OWNER_TOKEN (required to expose the console beyond localhost), DEMO_MODE=1 (read-only judge mode)
 */
const env = process.env;
const demoMode = env.DEMO_MODE === "1";
const log = (m: string) => console.log(new Date().toISOString(), m);
const pk = (k: string | undefined) => (k && /^0x[0-9a-fA-F]{64}$/.test(k) ? (k as Hex) : undefined);

const pub = createPublicClient({ chain: aevumTestnet, transport: http(D.rpcUrl, { retryCount: 3 }) });
const wallet = (k?: Hex) => (k ? createWalletClient({ account: privateKeyToAccount(k), chain: aevumTestnet, transport: http(D.rpcUrl) }) : null);
const contacts = loadContacts();
const dataDir = env.DATA_DIR ?? join(REPO_ROOT, "agent", "data");
const keystore = new SessionKeystore(join(dataDir, "sessions.json"));
keystore.adopt(pk(env.CLERK_PRIVATE_KEY), "imported from CLERK_PRIVATE_KEY");

const ownerKey = demoMode ? undefined : pk(env.OWNER_PRIVATE_KEY ?? env.PRIVATE_KEY);
const owner = new OwnerConsole({ pub: pub as never, owner: ownerKey ? privateKeyToAccount(ownerKey) : null, contacts });
const invoices = new Invoices({
  pub: pub as never,
  relayer: demoMode && env.DEMO_CUSTOMER_PRIVATE_KEY === undefined ? null : wallet(pk(env.RELAYER_PRIVATE_KEY ?? env.PRIVATE_KEY)),
  merchant: demoMode ? null : wallet(pk(env.MERCHANT_PRIVATE_KEY)),
  demoCustomer: pk(env.DEMO_CUSTOMER_PRIVATE_KEY) ? privateKeyToAccount(pk(env.DEMO_CUSTOMER_PRIVATE_KEY)!) : null,
  metaPath: join(dataDir, "invoices.json"),
});
const llm = new GeminiClient({
  apiKey: env.GEMINI_API_KEY || undefined,
  models: env.GEMINI_MODELS?.split(",").map((s) => s.trim()).filter(Boolean),
  rpm: Number(env.GEMINI_RPM ?? 10),
  dailyCap: Number(env.GEMINI_DAILY_CAP ?? 200),
  log,
});

// demo mode reads the session recorded by the live run when no keystore is present
// demo mode (no keystore): follow the newest session opened on the account, unless DEMO_SESSION_ADDRESS pins one
const demoPinned = (env.DEMO_SESSION_ADDRESS || null) as Address | null;
async function currentSession(): Promise<Address | null> {
  if (keystore.active) return keystore.active;
  if (!demoMode) return null;
  if (demoPinned) return demoPinned;
  await refreshAudit();
  const last = [...audit.entries].reverse().find((e) => e.event === "SessionCreated");
  return (last?.args.sessionKey as Address) ?? null;
}
const agents = new Map<string, ReturnType<typeof createAgent>>();
function agentFor(a: Address) {
  if (!agents.has(a)) {
    const key = demoMode ? undefined : keystore.privateKey(a);
    agents.set(a, createAgent({ sessionKey: key, sessionAddress: a, llm, log, journal: join(dataDir, "journal.json") }));
  }
  return agents.get(a)!;
}

const accountAbi = loadAbi("PaddyAccount");
const audit = { entries: [] as AuditEntry[], next: D.accountDeployBlock, busy: null as Promise<void> | null };
async function refreshAudit() {
  if (!audit.busy) {
    audit.busy = (async () => {
      const latest = await pub.getBlockNumber();
      if (latest < audit.next) return;
      const names: Record<string, string> = Object.fromEntries(contacts.map((c) => [c.wallet.toLowerCase(), c.legalName]));
      for (const h of keystore.history()) names[h.address.toLowerCase()] = "Paddy (AI clerk)";
      names[D.entryPoint.toLowerCase()] = "Owner (signed userOp)";
      names[D.account.toLowerCase()] = "Owner";
      for (const e of audit.entries) if (e.event === "SessionCreated") names[String(e.args.sessionKey).toLowerCase()] = "Paddy (AI clerk)";
      const fresh = await indexAccount(pub as never, accountAbi, D.account, audit.next, { names, toBlock: latest });
      audit.entries.push(...fresh);
      audit.next = latest + 1n;
    })().finally(() => (audit.busy = null));
  }
  await audit.busy;
}

const svc: Services = {
  config: () => ({
    chainId: D.chainId,
    chainName: "QDay Aevum Testnet",
    explorer: "https://explorer-test.qday.info",
    account: D.account,
    token: { address: D.tusd8, symbol: "tUSD8", decimals: 6 },
    ngnPerUsd: NGN_PER_USD,
    contacts: contacts.map((c) => ({ name: c.legalName, wallet: c.wallet })),
    features: { gemini: llm.enabled, ownerOps: !!ownerKey, merchant: invoices.canCreate, relay: invoices.canRelay, demoCustomer: invoices.canDemoPay },
  }),
  async overview() {
    const [balance, session] = await Promise.all([owner.balance(), owner.session(await currentSession())]);
    const pending = (await owner.approvals()).filter((a) => a.status === "Pending").length;
    return { balance, session, pending, llm: llm.enabled ? llm.usage : null };
  },
  async session() {
    return { session: await owner.session(await currentSession()), history: keystore.history().map(({ address, createdAt, label }) => ({ address, createdAt, label })) };
  },
  async createSession(p) {
    const allowed = new Set(contacts.map((c) => c.wallet.toLowerCase()));
    if (!p.payees.every((a) => allowed.has(a.toLowerCase()))) throw new HttpError(400, "payees must come from your contacts");
    const key = keystore.mint(p.label);
    const r = await owner.createSession(key, { ...p, payees: p.payees as Address[] });
    if (r.success) keystore.activate(key);
    return { ...r, sessionKey: key };
  },
  async revoke() {
    const a = await currentSession();
    if (!a) throw new HttpError(400, "no active session");
    return owner.revoke(a);
  },
  async chat(m) {
    const a = await currentSession();
    if (!a) throw new HttpError(400, "Paddy has no session yet. Open one in Limits.");
    if (!m.invoiceText && isStatusQuestion(m.message)) return statusAnswer(a);
    return agentFor(a).handle({ request: m.message, invoiceText: m.invoiceText, memo: m.memo }, { dryRun: m.dryRun });
  },
  approvals: () => owner.approvals(),
  decide: (id, approve) => (approve ? owner.approve(id) : owner.reject(id)),
  async audit() {
    await refreshAudit();
    return [...audit.entries].reverse();
  },
  invoice: (id) => invoices.view(id),
  createInvoice: (i) => invoices.create(i),
  authorization: (id, from) => invoices.authorization(id, from as Address),
  relay: (id, b) => invoices.relay(id, b as never),
  demoPay: (id) => invoices.demoPay(id),
  story,
};

/** "How much I fit spend today?" -> a plain answer from live chain state (no LLM call needed). */
const PAY_VERB = /\b(pay|send|transfer|settle|remit|give|dash|clear)\b/i;
function isStatusQuestion(t: string) {
  return !PAY_VERB.test(t) && /\b(how much|wetin|balance|budget|limit|remain|left|spend|fit spend|status)\b/i.test(t);
}
async function statusAnswer(a: Address) {
  const [s, bal] = await Promise.all([owner.session(a), owner.balance()]);
  const f = (u: bigint) => `${(Number(u) / 1e6).toFixed(2)} tUSD8`;
  let summary: string;
  if (!s || !s.exists) summary = "I don't have a session yet. Open one in Limits.";
  else if (!s.live) summary = `My session is ${s.revoked ? "revoked" : "expired"}, so I can't pay anyone. The business account holds ${f(bal)}.`;
  else {
    const left = s.remainingToday! < bal ? s.remainingToday! : bal;
    summary = `Today you fit still spend ${f(left)} through me (daily budget ${f(s.dailyBudget!)}, max ${f(s.perPaymentCap!)} per payment). The account holds ${f(bal)}. Anything bigger comes to you for approval.`;
  }
  return { plan: { id: "status", decision: "info", summary, reasons: [], flags: [], source: "chain" } };
}

const staticDir = env.STATIC_DIR ?? join(REPO_ROOT, "web", "dist");
const handle = createApp(svc, { ownerToken: env.OWNER_TOKEN || undefined, demoMode, staticDir, log });
const host = env.HOST ?? (env.OWNER_TOKEN || demoMode ? "0.0.0.0" : "127.0.0.1");
const port = Number(env.PORT ?? 8787);
if (!demoMode && !env.OWNER_TOKEN && !["127.0.0.1", "::1", "localhost"].includes(host)) {
  // without a token the console trusts loopback callers only; refusing to listen publicly avoids exposing owner actions
  throw new Error("Set OWNER_TOKEN (or DEMO_MODE=1) before listening on a non-loopback HOST");
}
createServer((req, res) => void handle(req, res)).listen(port, host, async () => {
  log(`Paddy on http://${host}:${port} | ${demoMode ? "DEMO MODE (read-only chain, simulated writes)" : "live"} | session ${keystore.active ?? (demoMode ? "newest on-chain" : "none")} | owner ops ${ownerKey ? "on" : "off"} | merchant ${invoices.canCreate ? "on" : "off"} | demo customer ${invoices.canDemoPay ? "on" : "off"} | gemini ${llm.enabled ? "on" : "off"}`);
  invoices.checkDomain().then((ok) => log(`tUSD8 EIP-712 domain check: ${ok ? "OK" : "MISMATCH"}`)).catch((e) => log(`domain check failed: ${e.message}`));
});
