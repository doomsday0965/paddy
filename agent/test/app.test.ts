import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, parseTusd8, type Services } from "../src/app.ts";

const calls: string[] = [];
const fake: Services = {
  config: () => ({ chainId: 44005, features: {} }),
  overview: async () => ({ balance: 90000n }),
  session: async () => ({ session: null }),
  createSession: async (p) => (calls.push(`createSession:${p.perPaymentCap}`), { tx: "0x1" }),
  revoke: async () => (calls.push("revoke"), { tx: "0x2" }),
  chat: async (m) => (calls.push(`chat:${m.dryRun}`), { plan: { decision: "execute" } }),
  approvals: async () => [],
  decide: async (id, ok) => (calls.push(`decide:${id}:${ok}`), { tx: "0x3" }),
  audit: async () => [],
  invoice: async (id) => (id === 1n ? { id: "1" } : null),
  createInvoice: async () => (calls.push("createInvoice"), { id: "9" }),
  authorization: async () => ({ salt: "0x" }),
  relay: async () => (calls.push("relay"), { tx: "0x4" }),
  demoPay: async () => ({ tx: "0x5" }),
  story: () => [{ kind: "narrator", text: "hi" }],
};

async function start(opts: Parameters<typeof createApp>[1]): Promise<{ url: string; s: Server }> {
  const h = createApp(fake, opts);
  const s = createServer((q, r) => void h(q, r));
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${(s.address() as any).port}`, s };
}
const post = (url: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) });

const goodSession = { perPaymentCap: "0.03", dailyBudget: "0.06", totalBudget: "0.10", days: 7, payees: ["0x0C9bce6c93765Ad41243141f936A4eA59A04272F"] };

test("parseTusd8: strict decimal amounts with a testnet ceiling", () => {
  assert.equal(parseTusd8("0.03", "x"), 30_000n);
  assert.equal(parseTusd8("1", "x"), 1_000_000n);
  for (const bad of ["-1", "0", "1e3", "0.0000001", "abc", "", "2"]) assert.throws(() => parseTusd8(bad, "x"), bad);
});

test("owner token: required for owner reads and writes; public routes stay open", async () => {
  const { url, s } = await start({ ownerToken: "s3cret-token", demoMode: false });
  try {
    assert.equal((await fetch(`${url}/api/overview`)).status, 401);
    assert.equal((await fetch(`${url}/api/overview`, { headers: { authorization: "Bearer wrong-token!" } })).status, 401);
    assert.equal((await fetch(`${url}/api/overview`, { headers: { authorization: "Bearer s3cret-token" } })).status, 200);
    assert.equal((await post(`${url}/api/session/revoke`, {})).status, 401);
    assert.equal((await post(`${url}/api/chat`, { message: "pay x 5k" })).status, 401);
    assert.equal((await fetch(`${url}/api/invoices/1`)).status, 200, "pay page is public");
    assert.equal((await fetch(`${url}/api/demo/story`)).status, 200);
    const cfg = await (await fetch(`${url}/api/config`)).json();
    assert.equal(cfg.isOwner, false);
    assert.equal(cfg.ownerAuth, "token");
  } finally {
    s.close();
  }
});

test("bigints serialise as strings; config never contains key material", async () => {
  const { url, s } = await start({ demoMode: false });
  try {
    const ov = await (await fetch(`${url}/api/overview`)).json();
    assert.equal(ov.balance, "90000");
    const cfgText = await (await fetch(`${url}/api/config`)).text();
    assert.ok(!/0x[0-9a-fA-F]{64}/.test(cfgText), "no 32-byte hex (keys) in config");
  } finally {
    s.close();
  }
});

test("demo mode: reads are open, writes are simulated, chat is forced to dry-run", async () => {
  calls.length = 0;
  const { url, s } = await start({ demoMode: true, ownerToken: "t0ken-for-demo" });
  try {
    assert.equal((await fetch(`${url}/api/session`)).status, 200);
    const r = await (await post(`${url}/api/session/revoke`, {})).json();
    assert.equal(r.simulated, true);
    const a = await (await post(`${url}/api/approvals/3/approve`, {})).json();
    assert.equal(a.simulated, true);
    const sess = await (await post(`${url}/api/session`, goodSession)).json();
    assert.equal(sess.simulated, true);
    await post(`${url}/api/chat`, { message: "pay Paddy Demo Foods ₦15", dryRun: false });
    assert.deepEqual(calls, ["chat:true"], "no live write reached the services");
  } finally {
    s.close();
  }
});

test("input validation on owner writes", async () => {
  calls.length = 0;
  const { url, s } = await start({ demoMode: false });
  try {
    const bad = async (b: unknown) => (await post(`${url}/api/session`, b)).status;
    assert.equal(await bad({ ...goodSession, perPaymentCap: "5" }), 400, "above ceiling");
    assert.equal(await bad({ ...goodSession, dailyBudget: "0.01" }), 400, "daily < cap");
    assert.equal(await bad({ ...goodSession, totalBudget: "0.05" }), 400, "total < daily");
    assert.equal(await bad({ ...goodSession, days: 365 }), 400, "expiry too long");
    assert.equal(await bad({ ...goodSession, payees: ["not-an-address"] }), 400);
    assert.equal(await bad({ ...goodSession, payees: [] }), 400);
    assert.equal(await bad("{not json"), 400);
    assert.equal(await bad([1, 2]), 400);
    assert.equal((await post(`${url}/api/session`, goodSession)).status, 200);
    assert.equal((await post(`${url}/api/chat`, { message: "x".repeat(501) })).status, 400);
    assert.equal((await post(`${url}/api/chat`, { message: 42 })).status, 400);
    assert.equal((await post(`${url}/api/invoices`, { amount: "0.01", label: "eggs", reference: "bad ref!" })).status, 400);
    assert.equal((await post(`${url}/api/approvals/abc/approve`, {})).status, 404);
    assert.equal((await post(`${url}/api/chat`, "x".repeat(40_000))).status, 413);
    assert.deepEqual(calls, ["createSession:30000"]);
  } finally {
    s.close();
  }
});

test("public relay: malformed authorizations are rejected before reaching the relayer; rate limited", async () => {
  calls.length = 0;
  const { url, s } = await start({ demoMode: false });
  try {
    const ok = { from: "0x3b2735C1A24433736e775c2da549F96CA7CA2f1b", amount: "10000", validAfter: "0", validBefore: "1795000000", salt: `0x${"ab".repeat(32)}`, signature: `0x${"cd".repeat(65)}` };
    assert.equal((await post(`${url}/api/invoices/1/relay`, { ...ok, signature: "0x1234" })).status, 400);
    assert.equal((await post(`${url}/api/invoices/1/relay`, { ...ok, amount: "-5" })).status, 400);
    assert.equal((await post(`${url}/api/invoices/1/relay`, { ...ok, from: "0xnope" })).status, 400);
    assert.equal((await post(`${url}/api/invoices/1/relay`, ok)).status, 200);
    assert.deepEqual(calls, ["relay"]);
    let limited = false;
    for (let i = 0; i < 15; i++) if ((await post(`${url}/api/invoices/1/authorization`, { from: ok.from })).status === 429) limited = true;
    assert.ok(limited, "rate limit kicks in");
    assert.equal((await fetch(`${url}/api/invoices/2`)).status, 404);
  } finally {
    s.close();
  }
});

test("static: security headers, SPA fallback, no path traversal", async () => {
  const dir = mkdtempSync(join(tmpdir(), "paddy-web-"));
  writeFileSync(join(dir, "index.html"), "<html>paddy</html>");
  mkdirSync(join(dir, "assets"));
  writeFileSync(join(dir, "assets", "a.js"), "console.log(1)");
  const { url, s } = await start({ demoMode: false, staticDir: dir });
  try {
    const r = await fetch(`${url}/pay/3`);
    assert.equal(await r.text(), "<html>paddy</html>");
    assert.match(r.headers.get("content-security-policy")!, /frame-ancestors 'none'/);
    assert.equal(r.headers.get("x-frame-options"), "DENY");
    const js = await fetch(`${url}/assets/a.js`);
    assert.match(js.headers.get("cache-control")!, /immutable/);
    const trav = await fetch(`${url}/..%2f..%2f..%2fetc%2fpasswd`);
    assert.ok(!(await trav.text()).includes("root:"), "no traversal");
  } finally {
    s.close();
  }
});
