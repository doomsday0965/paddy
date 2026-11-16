import { createServer, type IncomingMessage } from "node:http";
import { createPublicClient, http, type Hex } from "viem";
import { createAgent } from "./agent.ts";
import { DEPLOYMENT, loadAbi, loadContacts } from "./config.ts";
import { indexAccount } from "./indexer.ts";

/**
 * Paddy agent HTTP API
 *   POST /pay    { request, invoiceText?, memo?, dryRun? } -> plan (+ execution)
 *   GET  /audit  -> on-chain audit trail of the account
 *   GET  /health
 * Env: CLERK_PRIVATE_KEY (session key, testnet), GEMINI_API_KEY (optional), BUNDLER_URL, PORT (default 8787)
 */
const key = process.env.CLERK_PRIVATE_KEY as Hex | undefined;
if (!key) throw new Error("CLERK_PRIVATE_KEY (session key) is required");
const agent = createAgent({ sessionKey: key, log: (m) => console.log(new Date().toISOString(), m) });
const pub = createPublicClient({ transport: http(DEPLOYMENT.rpcUrl) });
const names = Object.fromEntries(loadContacts().map((c) => [c.wallet.toLowerCase(), c.legalName]));

const json = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x));
const body = (req: IncomingMessage) =>
  new Promise<string>((res, rej) => {
    let d = "";
    req.on("data", (c) => (d += c).length > 64_000 && rej(new Error("too large")));
    req.on("end", () => res(d));
  });

createServer(async (req, res) => {
  res.setHeader("content-type", "application/json");
  try {
    if (req.method === "GET" && req.url === "/health") return void res.end(json({ ok: true, session: agent.sessionAddress, llm: agent.llm.enabled ? agent.llm.usage : "rules-only" }));
    if (req.method === "GET" && req.url === "/audit") {
      return void res.end(json(await indexAccount(pub as never, loadAbi("PaddyAccount"), DEPLOYMENT.account, DEPLOYMENT.accountDeployBlock, { names })));
    }
    if (req.method === "POST" && req.url === "/pay") {
      const b = JSON.parse(await body(req));
      if (typeof b.request !== "string") throw new Error("request (string) is required");
      return void res.end(json(await agent.handle({ request: b.request, invoiceText: b.invoiceText, memo: b.memo }, { dryRun: Boolean(b.dryRun) })));
    }
    res.statusCode = 404;
    res.end(json({ error: "not found" }));
  } catch (e) {
    res.statusCode = 400;
    res.end(json({ error: (e as Error).message }));
  }
}).listen(Number(process.env.PORT ?? 8787), () => console.log(`Paddy agent on :${process.env.PORT ?? 8787}, session ${agent.sessionAddress}`));
