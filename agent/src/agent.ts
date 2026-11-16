import { createPublicClient, http, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { join } from "node:path";
import { OnChainView } from "./chain.ts";
import { DEPLOYMENT, NGN_PER_USD, REPO_ROOT, loadContacts } from "./config.ts";
import { Executor, type ExecutionResult } from "./executor.ts";
import { GeminiClient } from "./gemini.ts";
import { plan, type PayRequest, type Plan } from "./planner.ts";

export interface AgentResult {
  plan: Plan;
  execution?: ExecutionResult;
}

/** Wires the planner, Gemini, the chain view and the executor. */
export function createAgent(opts: { sessionKey: Hex; log?: (m: string) => void; journal?: string }) {
  const pub = createPublicClient({ transport: http(DEPLOYMENT.rpcUrl, { retryCount: 3 }) });
  const session = privateKeyToAccount(opts.sessionKey);
  const chain = new OnChainView(DEPLOYMENT, pub as never);
  const llm = new GeminiClient({
    apiKey: process.env.GEMINI_API_KEY || undefined,
    models: process.env.GEMINI_MODELS?.split(",").map((s) => s.trim()).filter(Boolean),
    rpm: Number(process.env.GEMINI_RPM ?? 10),
    dailyCap: Number(process.env.GEMINI_DAILY_CAP ?? 200),
    log: opts.log,
  });
  const executor = new Executor(pub as never, session, opts.journal ?? join(REPO_ROOT, "agent", "data", "journal.json"));
  const contacts = loadContacts();

  return {
    sessionAddress: session.address,
    llm,
    async handle(req: PayRequest, { dryRun = false } = {}): Promise<AgentResult> {
      const p = await plan(req, { chain, contacts, sessionKey: session.address, account: DEPLOYMENT.account, ngnPerUsd: NGN_PER_USD, llm: llm.enabled ? llm : null });
      if (dryRun || (p.decision !== "execute" && p.decision !== "queue_for_owner")) return { plan: p };
      return { plan: p, execution: await executor.execute(p) };
    },
  };
}
