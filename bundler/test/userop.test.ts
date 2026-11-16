import { test } from "node:test";
import assert from "node:assert/strict";
import { recoverMessageAddress, slice, type Hex } from "viem";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { fromRpc, toRpc, signAsOwner, signAsSession, userOpHash, pack, type UserOp } from "../src/userop.ts";

const op: UserOp = {
  sender: "0xf74269212d041589Fe7B2930428012CBcb4f60Dc",
  nonce: 3n,
  callData: "0x1234",
  callGasLimit: 600_000n,
  verificationGasLimit: 300_000n,
  preVerificationGas: 60_000n,
  maxFeePerGas: 2n,
  maxPriorityFeePerGas: 1n,
  paymaster: "0x9942FBa932735EFf9B55D8948701AEF5218491b5",
  paymasterVerificationGasLimit: 100_000n,
  paymasterPostOpGasLimit: 60_000n,
  paymasterData: "0x",
  signature: "0x",
};

test("rpc round trip", () => {
  assert.deepEqual(fromRpc(toRpc(op)), op);
});

test("rejects malformed rpc ops", () => {
  assert.throws(() => fromRpc({ nonce: "0x1" }));
});

test("hash ignores signature and depends on chain", () => {
  assert.equal(userOpHash({ ...op, signature: "0xff" }, 44005), userOpHash(op, 44005));
  assert.notEqual(userOpHash(op, 44005), userOpHash(op, 1));
});

test("owner signature: 0x00 || 65-byte EIP-191 sig over userOpHash", async () => {
  const owner = privateKeyToAccount(generatePrivateKey());
  const s = await signAsOwner(op, owner, 44005);
  assert.equal((s.signature.length - 2) / 2, 66);
  assert.equal(slice(s.signature, 0, 1), "0x00");
  const rec = await recoverMessageAddress({ message: { raw: userOpHash(op, 44005) }, signature: slice(s.signature, 1) as Hex });
  assert.equal(rec, owner.address);
});

test("session signature: 0x01 || key || 65-byte sig", async () => {
  const k = privateKeyToAccount(generatePrivateKey());
  const s = await signAsSession(op, k, 44005);
  assert.equal((s.signature.length - 2) / 2, 86);
  assert.equal(slice(s.signature, 0, 1), "0x01");
  assert.equal(slice(s.signature, 1, 21).toLowerCase(), k.address.toLowerCase());
  const rec = await recoverMessageAddress({ message: { raw: userOpHash(op, 44005) }, signature: slice(s.signature, 21) as Hex });
  assert.equal(rec, k.address);
});

test("hash matches the live EntryPoint v0.7 on Aevum", { skip: !process.env.LIVE_RPC }, async () => {
  const { createPublicClient, http } = await import("viem");
  const { entryPoint07Abi } = await import("viem/account-abstraction");
  const { aevumTestnet, ENTRY_POINT_V07 } = await import("../src/chain.ts");
  const pub = createPublicClient({ chain: aevumTestnet, transport: http() });
  const onchain = await pub.readContract({ address: ENTRY_POINT_V07, abi: entryPoint07Abi, functionName: "getUserOpHash", args: [pack(op) as never] });
  assert.equal(onchain, userOpHash(op, 44005));
});
