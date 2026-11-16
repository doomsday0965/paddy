/** Copies contract ABIs from Foundry's out/ into agent/abi/ so the agent and Docker image don't need Foundry. Run after `forge build`. */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT, here } from "../src/config.ts";
for (const c of ["PaddyAccount", "InvoiceBook", "PayeeRegistry", "PaddyPaymaster", "PaddyAccountFactory"]) {
  const abi = JSON.parse(readFileSync(join(REPO_ROOT, "out", `${c}.sol`, `${c}.json`), "utf8")).abi;
  writeFileSync(join(here, "..", "abi", `${c}.json`), JSON.stringify({ contractName: c, abi }, null, 1) + "\n");
  console.log(`abi/${c}.json`);
}
