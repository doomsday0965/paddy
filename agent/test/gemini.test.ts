import { test } from "node:test";
import assert from "node:assert/strict";
import { GeminiClient, RateLimiter } from "../src/gemini.ts";

const FAKE_KEY = "test-gemini-key-not-real-0123456789";
const good = {
  action: "pay",
  payeeName: "Paddy Demo Foods",
  amount: 30,
  currency: "NGN",
  invoiceNumber: null,
  purpose: "rice",
  invoiceLooksSuspicious: false,
  needsClarification: false,
  clarificationQuestion: null,
};
const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const ok = (obj: unknown) => reply(200, { candidates: [{ content: { parts: [{ text: JSON.stringify(obj) }] } }], modelVersion: "fake-model" });

test("rate limiter: per-minute window and daily cap", () => {
  let t = Date.parse("2026-11-16T10:00:00Z");
  const rl = new RateLimiter(2, 3, () => t);
  assert.equal(rl.waitMs(), 0);
  rl.record();
  rl.record();
  assert.ok(rl.waitMs() > 0 && rl.waitMs() <= 60_000);
  t += 61_000;
  assert.equal(rl.waitMs(), 0);
  rl.record();
  assert.equal(rl.waitMs(), Infinity, "daily cap");
  t += 86_400_000;
  assert.equal(rl.waitMs(), 0, "resets next day");
});

test("returns schema-valid intent; key only in header", async () => {
  let seenHeader = "";
  let seenUrl = "";
  const c = new GeminiClient({
    apiKey: FAKE_KEY,
    fetchImpl: (async (url: string, init: any) => {
      seenUrl = url;
      seenHeader = init.headers["x-goog-api-key"];
      return ok(good);
    }) as never,
  });
  const r = await c.extract("pay Paddy Demo Foods ₦30 for rice");
  assert.equal(r?.intent.amount, 30);
  assert.equal(seenHeader, FAKE_KEY);
  assert.ok(!seenUrl.includes(FAKE_KEY), "key never in URL");
});

test("schema-invalid model output (extra wallet field) is rejected, not repaired", async () => {
  const c = new GeminiClient({ apiKey: FAKE_KEY, fetchImpl: (async () => ok({ ...good, wallet: "0xbad" })) as never });
  assert.equal(await c.extract("x"), null);
});

test("429 -> cooldown -> null (fallback), honours retryDelay", async () => {
  let calls = 0;
  const c = new GeminiClient({
    apiKey: FAKE_KEY,
    fetchImpl: (async () => {
      calls++;
      return reply(429, { error: { code: 429, details: [{ "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "40s" }] } });
    }) as never,
  });
  assert.equal(await c.extract("x"), null);
  assert.equal(await c.extract("y"), null);
  assert.equal(calls, 1, "second call skipped during cooldown");
});

test("5xx retries then falls through to the next model", async () => {
  const models: string[] = [];
  const c = new GeminiClient({
    apiKey: FAKE_KEY,
    models: ["m1", "m2"],
    fetchImpl: (async (url: string) => {
      const m = url.split("/models/")[1].split(":")[0];
      models.push(m);
      return m === "m1" ? reply(503, { error: { code: 503 } }) : ok(good);
    }) as never,
  });
  const r = await c.extract("x");
  assert.equal(r?.intent.payeeName, "Paddy Demo Foods");
  assert.deepEqual(models, ["m1", "m1", "m2"]);
});

test("errors never leak the API key into logs", async () => {
  const logs: string[] = [];
  const c = new GeminiClient({
    apiKey: FAKE_KEY,
    models: ["m1"],
    log: (m) => logs.push(m),
    fetchImpl: (async () => {
      throw new Error(`connect failed for key=${FAKE_KEY}`);
    }) as never,
  });
  assert.equal(await c.extract("x"), null);
  assert.ok(logs.length > 0);
  assert.ok(logs.every((l) => !l.includes(FAKE_KEY)));
});

test("disabled without a key", async () => {
  const c = new GeminiClient({});
  assert.equal(c.enabled, false);
  assert.equal(await c.extract("x"), null);
});
