/** Prints the plain-language audit trail of the SME smart account from its PaddyAccount events. Usage: npm run audit [-- --json] [-- --from <block>] */
import { createPublicClient, http } from "viem";
import { DEPLOYMENT as D, loadAbi, loadContacts } from "../src/config.ts";
import { indexAccount } from "../src/indexer.ts";

const args = process.argv.slice(2);
const fromIdx = args.indexOf("--from");
const from = fromIdx >= 0 ? BigInt(args[fromIdx + 1]) : D.accountDeployBlock;
const pub = createPublicClient({ transport: http(D.rpcUrl, { retryCount: 3 }) });
const names: Record<string, string> = {};
for (const c of loadContacts()) names[c.wallet.toLowerCase()] = c.legalName;
const entries = await indexAccount(pub as never, loadAbi("PaddyAccount"), D.account, from, { names });
if (args.includes("--json")) console.log(JSON.stringify(entries, null, 2));
else for (const e of entries) console.log(`${e.time}  #${e.block}  ${e.summary}\n    https://explorer-test.qday.info/tx/${e.tx}`);
console.error(`${entries.length} events for ${D.account} since block ${from}`);
