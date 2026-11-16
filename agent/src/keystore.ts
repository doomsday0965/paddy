import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Address, Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

interface Stored {
  active: Address | null;
  keys: Record<string, { pk: Hex; createdAt: string; label: string }>;
}

/**
 * Server-side store of AI-clerk session keys (testnet). Session keys are single-use on-chain, so every
 * "new session" in the console mints a fresh key here. File is chmod 600 and gitignored; keys never leave the server.
 */
export class SessionKeystore {
  private data: Stored;
  private readonly path: string;
  constructor(path: string) {
    this.path = path;
    this.data = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : { active: null, keys: {} };
  }
  /** Adopt an existing key (e.g. CLERK_PRIVATE_KEY from env) if the store is empty. */
  adopt(pk: Hex | undefined, label = "imported") {
    if (!pk || this.data.active) return;
    const a = privateKeyToAccount(pk).address;
    this.data.keys[a] = { pk, createdAt: new Date().toISOString(), label };
    this.data.active = a;
    this.save();
  }
  mint(label: string): Address {
    const pk = generatePrivateKey();
    const a = privateKeyToAccount(pk).address;
    this.data.keys[a] = { pk, createdAt: new Date().toISOString(), label };
    this.save();
    return a;
  }
  activate(a: Address) {
    if (!this.data.keys[a]) throw new Error("unknown session key");
    this.data.active = a;
    this.save();
  }
  get active(): Address | null {
    return this.data.active;
  }
  privateKey(a: Address): Hex | undefined {
    return this.data.keys[a]?.pk;
  }
  history(): { address: Address; createdAt: string; label: string }[] {
    return Object.entries(this.data.keys).map(([address, v]) => ({ address: address as Address, createdAt: v.createdAt, label: v.label }));
  }
  private save() {
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    chmodSync(this.path, 0o600);
  }
}
