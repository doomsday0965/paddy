import { timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, join, normalize } from "node:path";

/** Everything the HTTP layer needs. Live wiring is in server.ts; tests pass fakes. */
export interface Services {
  config(): Record<string, unknown>;
  overview(): Promise<unknown>;
  session(): Promise<unknown>;
  createSession(p: NewSession): Promise<unknown>;
  revoke(): Promise<unknown>;
  chat(m: { message: string; invoiceText?: string; memo?: string; dryRun: boolean }): Promise<unknown>;
  approvals(): Promise<unknown>;
  decide(id: number, approve: boolean): Promise<unknown>;
  audit(): Promise<unknown>;
  invoice(id: bigint): Promise<unknown>;
  createInvoice(i: { amount: bigint; label: string; reference: string }): Promise<unknown>;
  authorization(id: bigint, from: string): Promise<unknown>;
  relay(id: bigint, b: Record<string, string>): Promise<unknown>;
  demoPay(id: bigint): Promise<unknown>;
  story(): unknown;
}
export interface NewSession {
  label: string;
  perPaymentCap: bigint;
  dailyBudget: bigint;
  totalBudget: bigint;
  days: number;
  payees: string[];
  requireVerifiedPayee: boolean;
}
export interface AppOptions {
  ownerToken?: string;
  demoMode: boolean;
  staticDir?: string;
  log?: (m: string) => void;
}

export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const json = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x));
const ADDR = /^0x[0-9a-fA-F]{40}$/;
const HEX32 = /^0x[0-9a-fA-F]{64}$/;
const SIG = /^0x[0-9a-fA-F]{130}$/;
const UINT = /^\d{1,30}$/;
const MAX_TUSD8 = 1_000_000n; // 1 tUSD8: hard ceiling for anything set from the console (testnet demo)

/** "0.03" -> 30000n (6 decimals). Rejects negatives, >6 decimals and junk. */
export function parseTusd8(v: unknown, field: string): bigint {
  const s = String(v ?? "").trim();
  if (!/^\d{1,7}(\.\d{1,6})?$/.test(s)) throw new HttpError(400, `${field}: enter an amount like 0.05`);
  const [w, f = ""] = s.split(".");
  const units = BigInt(w) * 1_000_000n + BigInt(f.padEnd(6, "0"));
  if (units <= 0n) throw new HttpError(400, `${field} must be more than 0`);
  if (units > MAX_TUSD8) throw new HttpError(400, `${field} is above the 1 tUSD8 testnet ceiling`);
  return units;
}

class RateLimit {
  private hits = new Map<string, number[]>();
  private readonly perMin: number;
  constructor(perMin: number) {
    this.perMin = perMin;
  }
  ok(key: string): boolean {
    const now = Date.now();
    const h = (this.hits.get(key) ?? []).filter((t) => now - t < 60_000);
    if (h.length >= this.perMin) return false;
    h.push(now);
    this.hits.set(key, h);
    return true;
  }
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
  ".txt": "text/plain; charset=utf-8",
  ".mp4": "video/mp4",
};
const CSP = "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";

export function createApp(svc: Services, opts: AppOptions) {
  const publicLimit = new RateLimit(12);
  const chatLimit = new RateLimit(20);
  const isLoopback = (req: IncomingMessage) => ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket.remoteAddress ?? "");

  function isOwner(req: IncomingMessage): boolean {
    if (opts.ownerToken) {
      const got = Buffer.from(String(req.headers.authorization ?? "").replace(/^Bearer\s+/i, ""));
      const want = Buffer.from(opts.ownerToken);
      return got.length === want.length && timingSafeEqual(got, want);
    }
    return isLoopback(req); // no token configured: owner console only from this machine
  }
  /** Owner reads: open in demo mode (read-only chain data), else owner only. */
  const ownerRead = (req: IncomingMessage) => {
    if (!opts.demoMode && !isOwner(req)) throw new HttpError(401, "owner sign-in required");
  };
  /** Owner writes: in demo mode they are simulated and never touch the chain. */
  const ownerWrite = (req: IncomingMessage): "live" | "simulated" => {
    if (opts.demoMode) return "simulated";
    if (!isOwner(req)) throw new HttpError(401, "owner sign-in required");
    return "live";
  };
  const simulated = (what: string) => ({ simulated: true, note: `Demo mode: in the live console this ${what}. Nothing was sent to the chain.` });

  async function body(req: IncomingMessage): Promise<Record<string, any>> {
    let d = "";
    for await (const c of req) {
      d += c;
      if (d.length > 32_000) throw new HttpError(413, "request too large");
    }
    if (!d) return {};
    try {
      const v = JSON.parse(d);
      if (typeof v !== "object" || v === null || Array.isArray(v)) throw new Error();
      return v;
    } catch {
      throw new HttpError(400, "invalid JSON body");
    }
  }
  const str = (v: unknown, field: string, max: number, required = true): string | undefined => {
    if (v === undefined || v === null || v === "") {
      if (required) throw new HttpError(400, `${field} is required`);
      return undefined;
    }
    if (typeof v !== "string") throw new HttpError(400, `${field} must be text`);
    if (v.length > max) throw new HttpError(400, `${field} is too long (max ${max})`);
    return v;
  };
  const idOf = (s: string) => {
    if (!/^\d{1,12}$/.test(s)) throw new HttpError(400, "bad id");
    return BigInt(s);
  };

  async function api(req: IncomingMessage, path: string, method: string): Promise<unknown> {
    const ip = req.socket.remoteAddress ?? "?";
    if (method === "GET" && path === "/api/health") return { ok: true };
    if (method === "GET" && path === "/api/config") return { ...svc.config(), demoMode: opts.demoMode, ownerAuth: opts.ownerToken ? "token" : "local", isOwner: opts.demoMode || isOwner(req) };
    if (method === "GET" && path === "/api/demo/story") return svc.story();

    // ---- owner console
    if (method === "GET" && path === "/api/overview") return ownerRead(req), svc.overview();
    if (method === "GET" && path === "/api/session") return ownerRead(req), svc.session();
    if (method === "GET" && path === "/api/approvals") return ownerRead(req), svc.approvals();
    if (method === "GET" && path === "/api/audit") return ownerRead(req), svc.audit();
    if (method === "POST" && path === "/api/chat") {
      const mode = opts.demoMode ? "simulated" : (ownerRead(req), "live");
      if (!chatLimit.ok(ip)) throw new HttpError(429, "slow down a little");
      const b = await body(req);
      const message = str(b.message, "message", 500)!;
      const invoiceText = str(b.invoiceText, "invoiceText", 8000, false);
      const memo = str(b.memo, "memo", 2000, false);
      // in demo mode Paddy plans for real against live chain state but never signs
      return svc.chat({ message, invoiceText, memo, dryRun: mode === "simulated" || b.dryRun === true });
    }
    if (method === "POST" && path === "/api/session") {
      const mode = ownerWrite(req);
      const b = await body(req);
      const p: NewSession = {
        label: str(b.label, "label", 60, false) ?? "Paddy AI clerk",
        perPaymentCap: parseTusd8(b.perPaymentCap, "Per-payment cap"),
        dailyBudget: parseTusd8(b.dailyBudget, "Daily budget"),
        totalBudget: parseTusd8(b.totalBudget, "Total budget"),
        days: Number(b.days),
        payees: Array.isArray(b.payees) ? b.payees : [],
        requireVerifiedPayee: b.requireVerifiedPayee !== false,
      };
      if (!Number.isFinite(p.days) || p.days < 0.01 || p.days > 30) throw new HttpError(400, "Expiry must be between 1 and 30 days");
      if (p.dailyBudget < p.perPaymentCap) throw new HttpError(400, "Daily budget must be at least the per-payment cap");
      if (p.totalBudget < p.dailyBudget) throw new HttpError(400, "Total budget must be at least the daily budget");
      if (!p.payees.length || p.payees.length > 20 || !p.payees.every((a) => typeof a === "string" && ADDR.test(a))) throw new HttpError(400, "Pick at least one payee");
      if (mode === "simulated") return simulated("mints a fresh session key on the server and sends a gas-sponsored createSession userOp");
      return svc.createSession(p);
    }
    if (method === "POST" && path === "/api/session/revoke") {
      if (ownerWrite(req) === "simulated") return simulated("sends revokeSession, and the clerk's key stops working in the same block");
      return svc.revoke();
    }
    let m = /^\/api\/approvals\/(\d+)\/(approve|reject)$/.exec(path);
    if (method === "POST" && m) {
      if (ownerWrite(req) === "simulated") return simulated(`sends ${m[2]}Request(${m[1]}) as an owner userOp`);
      return svc.decide(Number(m[1]), m[2] === "approve");
    }
    if (method === "POST" && path === "/api/invoices") {
      const mode = ownerWrite(req);
      const b = await body(req);
      const amount = parseTusd8(b.amount, "Amount");
      const label = str(b.label, "label", 80)!;
      const reference = str(b.reference, "reference", 30)!;
      if (!/^[A-Za-z0-9-]{2,30}$/.test(reference)) throw new HttpError(400, "Reference: letters, digits and dashes only");
      if (mode === "simulated") return simulated("issues the invoice on InvoiceBook from the verified merchant wallet");
      return svc.createInvoice({ amount, label, reference });
    }

    // ---- public customer pay page
    m = /^\/api\/invoices\/(\d+)$/.exec(path);
    if (method === "GET" && m) {
      const v = await svc.invoice(idOf(m[1]));
      if (!v) throw new HttpError(404, "invoice not found");
      return v;
    }
    m = /^\/api\/invoices\/(\d+)\/authorization$/.exec(path);
    if (method === "POST" && m) {
      if (!publicLimit.ok(ip)) throw new HttpError(429, "too many requests, try again in a minute");
      const b = await body(req);
      if (typeof b.from !== "string" || !ADDR.test(b.from)) throw new HttpError(400, "from must be an address");
      return svc.authorization(idOf(m[1]), b.from);
    }
    m = /^\/api\/invoices\/(\d+)\/relay$/.exec(path);
    if (method === "POST" && m) {
      if (!publicLimit.ok(ip)) throw new HttpError(429, "too many requests, try again in a minute");
      const b = await body(req);
      if (!ADDR.test(String(b.from)) || !UINT.test(String(b.amount)) || !UINT.test(String(b.validAfter)) || !UINT.test(String(b.validBefore)) || !HEX32.test(String(b.salt)) || !SIG.test(String(b.signature)))
        throw new HttpError(400, "malformed authorization");
      return svc.relay(idOf(m[1]), { from: b.from, amount: b.amount, validAfter: b.validAfter, validBefore: b.validBefore, salt: b.salt, signature: b.signature });
    }
    m = /^\/api\/invoices\/(\d+)\/demo-pay$/.exec(path);
    if (method === "POST" && m) {
      if (!publicLimit.ok(ip)) throw new HttpError(429, "too many requests, try again in a minute");
      return svc.demoPay(idOf(m[1]));
    }
    throw new HttpError(404, "not found");
  }

  function serveStatic(path: string, res: ServerResponse, method: string): boolean {
    if (!opts.staticDir || !existsSync(opts.staticDir)) return false;
    const safe = normalize(decodeURIComponent(path)).replace(/^(\.\.[/\\])+/, "");
    let file = join(opts.staticDir, safe);
    if (!file.startsWith(opts.staticDir)) return false;
    if (!existsSync(file) || statSync(file).isDirectory()) file = join(opts.staticDir, "index.html"); // SPA fallback
    if (!existsSync(file)) return false;
    const size = statSync(file).size;
    res.setHeader("content-type", MIME[extname(file)] ?? "application/octet-stream");
    res.setHeader("content-length", String(size));
    res.setHeader("cache-control", file.includes(`${"/"}assets${"/"}`) ? "public, max-age=31536000, immutable" : "no-cache");
    if (method === "HEAD") {
      res.end();
      return true;
    }
    res.end(readFileSync(file));
    return true;
  }

  return async function handle(req: IncomingMessage, res: ServerResponse) {
    res.setHeader("x-content-type-options", "nosniff");
    res.setHeader("referrer-policy", "no-referrer");
    res.setHeader("x-frame-options", "DENY");
    res.setHeader("content-security-policy", CSP);
    res.setHeader("permissions-policy", "camera=(), microphone=(), geolocation=()");
    const url = new URL(req.url ?? "/", "http://x");
    const method = req.method ?? "GET";
    if (url.pathname.startsWith("/api/")) {
      res.setHeader("content-type", "application/json");
      res.setHeader("cache-control", "no-store");
      try {
        res.end(json(await api(req, url.pathname, method)));
      } catch (e) {
        const err = e as HttpError;
        res.statusCode = err.status ?? 500;
        // internal errors are logged server-side with secrets scrubbed; clients get a short message
        const msg = String(err.message ?? err).slice(0, 300);
        opts.log?.(`${method} ${url.pathname} -> ${res.statusCode}: ${msg}`);
        res.end(json({ error: res.statusCode >= 500 ? friendly(msg) : msg }));
      }
      return;
    }
    if ((method === "GET" || method === "HEAD") && serveStatic(url.pathname, res, method)) return;
    res.statusCode = 404;
    res.end("not found");
  };
}

function friendly(msg: string): string {
  if (/AA24|signature/i.test(msg)) return "The chain rejected the signature (key revoked or expired).";
  if (/bundler/i.test(msg)) return `Bundler: ${msg.replace(/^bundler:\s*/, "").slice(0, 160)}`;
  if (/reverted|revert/i.test(msg)) return `The contract refused this: ${msg.slice(0, 160)}`;
  return msg.slice(0, 200);
}
