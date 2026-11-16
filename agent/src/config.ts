import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { Abi, Address } from "viem";
import type { Contact } from "./names.ts";

export const here = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = join(here, "..", "..");

/** ABIs: committed copies in agent/abi (refresh with `npm run abi` after forge build), else Foundry's out/. */
export function loadAbi(name: string): Abi {
  const committed = join(here, "..", "abi", `${name}.json`);
  const path = existsSync(committed) ? committed : join(REPO_ROOT, "out", `${name}.sol`, `${name}.json`);
  return JSON.parse(readFileSync(path, "utf8")).abi as Abi;
}

/** Live Aevum Testnet deployment (see README). */
export const DEPLOYMENT = {
  chainId: 44005,
  rpcUrl: process.env.RPC_URL ?? "https://rpc-test.qday.info",
  entryPoint: "0x0000000071727De22E5E9d8BAf0edAc6f37da032" as Address,
  tusd8: "0x456569838f1d43009A91ebA4263147Afd7233483" as Address,
  registry: (process.env.REGISTRY ?? "0x27f16054c035bc2450f5BABe2f63990dEc1D2E95") as Address,
  book: (process.env.BOOK ?? "0x2b4A256024A58Ff0B62eEf853c8682124c3D2c16") as Address,
  paymaster: (process.env.PAYMASTER ?? "0x9942FBa932735EFf9B55D8948701AEF5218491b5") as Address,
  account: (process.env.ACCOUNT ?? "0xf74269212d041589Fe7B2930428012CBcb4f60Dc") as Address,
  accountDeployBlock: BigInt(process.env.ACCOUNT_DEPLOY_BLOCK ?? "3311300"),
  bundlerUrl: process.env.BUNDLER_URL ?? "http://127.0.0.1:4337",
};

/** Fixed demo FX rate; production would read an oracle. */
export const NGN_PER_USD = Number(process.env.NGN_PER_USD ?? 1500);

export function loadContacts(path = process.env.CONTACTS ?? join(here, "..", "contacts.json")): Contact[] {
  return JSON.parse(readFileSync(path, "utf8")) as Contact[];
}
