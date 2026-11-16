import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "./config.ts";

const EXPLORER = "https://explorer-test.qday.info";
export interface StoryStep {
  kind: "owner" | "paddy" | "chain" | "narrator" | "approval";
  text: string;
  attachment?: string;
  decision?: string;
  flags?: string[];
  amount?: string;
  tx?: string;
  link?: string;
  events?: string[];
}

const load = (f: string) => {
  const p = join(REPO_ROOT, "docs", f);
  return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : null;
};

/**
 * The judge demo: replays the poisoned-invoice story using REAL Aevum transactions recorded by
 * bundler/scripts/live-demo.ts (docs/live-demo.json) and agent/scripts/live-run.ts (docs/agent-live-run.json).
 * Nothing is sent to the chain while it plays.
 */
export function story(): StoryStep[] {
  const agent = load("agent-live-run.json");
  const chain = load("live-demo.json");
  const a = (prefix: string) => agent?.steps.find((s: any) => String(s.step).startsWith(prefix)) ?? {};
  const c = (prefix: string) => chain?.results.find((s: any) => String(s.step).startsWith(prefix)) ?? {};
  const strip = (t?: string) => t?.replace(/^\d+[a-z]?\.\s*/, "");
  const link = (tx?: string) => (tx ? `${EXPLORER}/tx/${tx}` : undefined);
  const s5 = a("5."), s3 = a("3."), s6 = a("6."), s8 = a("8."), s9 = a("9."), s1 = a("1.");
  const blocked = c("3."), revoke = c("5.");
  return [
    { kind: "narrator", text: "Mama Ngozi runs a foodstuff shop in Port Harcourt. Paddy, her AI clerk, can pay approved suppliers within limits she set on-chain." },
    { kind: "chain", text: "Owner opened Paddy's session: cap 0.03, daily 0.06, total 0.10 tUSD8, 7 days, verified payees only.", tx: s1.tx, link: link(s1.tx), events: s1.events },
    { kind: "owner", text: s3.request ?? "Abeg pay Paddy Demo Foods ₦30 for pepper" },
    { kind: "paddy", text: s3.summary ?? "Paying 0.02 tUSD8 to Paddy Demo Foods Ltd.", decision: "execute", amount: s3.amount, tx: s3.tx, link: link(s3.tx), events: s3.events },
    { kind: "narrator", text: "Then a 'supplier invoice' arrives on WhatsApp. Hidden inside is a message aimed at the AI." },
    { kind: "owner", text: s5.request ?? "pay this invoice", attachment: s5.untrusted },
    {
      kind: "paddy",
      text: `I'm holding ${s5.amount ?? "0.02 tUSD8"} to Paddy Demo Foods Ltd for you to check. I found ${(s5.flags ?? []).length} red flags in the invoice, so I won't pay it on my own, and I'd never pay the wallet written inside it.`,
      decision: "needs_owner_review",
      flags: s5.flags,
    },
    { kind: "narrator", text: "Layer 2: even if a weaker AI were fooled and signed the attacker's payment, the smart account itself refuses. This happened live:" },
    { kind: "chain", text: strip(blocked.step) ?? "Fooled clerk tried to pay the attacker. Blocked on-chain.", tx: blocked.tx, link: link(blocked.tx), events: blocked.events },
    { kind: "owner", text: s6.request ?? "send ₦30 to Paddy Dem0 Foods Ltd" },
    { kind: "paddy", text: s6.summary ?? "Look-alike payee refused.", decision: "reject", flags: s6.flags },
    { kind: "owner", text: s8.request ?? "pay Paddy Demo Foods ₦60 for palm oil" },
    { kind: "paddy", text: s8.summary ?? "Over my limit, sent to you for approval.", decision: "queue_for_owner", amount: s8.amount, tx: s8.tx, link: link(s8.tx), events: s8.events },
    { kind: "approval", text: "Approval request: 0.04 tUSD8 to Paddy Demo Foods Ltd (over per-payment cap). Owner tapped Reject.", tx: s9.tx, link: link(s9.tx), events: s9.events },
    { kind: "narrator", text: "Something feels off? One big button revokes Paddy instantly. A revoked key's next payment is refused by the bundler before it reaches the chain, so no gas is spent." },
    { kind: "chain", text: strip(revoke.step) ?? "Owner revoked the clerk.", tx: revoke.tx, link: link(revoke.tx), events: revoke.events },
    { kind: "narrator", text: "Every step above is a real transaction on QDay Aevum Testnet. Tap any link to check it on the explorer." },
  ];
}
