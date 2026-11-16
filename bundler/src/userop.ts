import {
  concat,
  encodePacked,
  type Address,
  type Hex,
  type LocalAccount,
} from "viem";
import { getUserOperationHash, toPackedUserOperation } from "viem/account-abstraction";
import { ENTRY_POINT_V07 } from "./chain.ts";

/** ERC-4337 v0.7 user operation (unpacked RPC form, bigint fields). */
export interface UserOp {
  sender: Address;
  nonce: bigint;
  factory?: Address;
  factoryData?: Hex;
  callData: Hex;
  callGasLimit: bigint;
  verificationGasLimit: bigint;
  preVerificationGas: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  paymaster?: Address;
  paymasterVerificationGasLimit?: bigint;
  paymasterPostOpGasLimit?: bigint;
  paymasterData?: Hex;
  signature: Hex;
}

const BIGINT_FIELDS = [
  "nonce",
  "callGasLimit",
  "verificationGasLimit",
  "preVerificationGas",
  "maxFeePerGas",
  "maxPriorityFeePerGas",
  "paymasterVerificationGasLimit",
  "paymasterPostOpGasLimit",
] as const;

/** JSON-RPC hex strings -> bigint fields. */
export function fromRpc(raw: Record<string, unknown>): UserOp {
  const op: Record<string, unknown> = { ...raw };
  for (const k of BIGINT_FIELDS) if (op[k] !== undefined && op[k] !== null) op[k] = BigInt(op[k] as string);
  for (const k of ["factory", "factoryData", "paymaster", "paymasterData"]) if (op[k] === null) delete op[k];
  if (typeof op.sender !== "string" || typeof op.callData !== "string" || typeof op.signature !== "string") {
    throw new Error("invalid userOperation: sender, callData and signature are required");
  }
  return op as unknown as UserOp;
}

/** bigint fields -> JSON-RPC hex strings. */
export function toRpc(op: UserOp): Record<string, unknown> {
  const out: Record<string, unknown> = { ...op };
  for (const k of BIGINT_FIELDS) if (typeof out[k] === "bigint") out[k] = `0x${(out[k] as bigint).toString(16)}`;
  return out;
}

export function pack(op: UserOp) {
  return toPackedUserOperation(op as never);
}

export function userOpHash(op: UserOp, chainId: number, entryPoint: Address = ENTRY_POINT_V07): Hex {
  return getUserOperationHash({
    chainId,
    entryPointAddress: entryPoint,
    entryPointVersion: "0.7",
    userOperation: { ...op, signature: "0x" } as never,
  });
}

/** PaddyAccount owner signature: 0x00 ‖ sig(65) over EIP-191(userOpHash). */
export async function signAsOwner(op: UserOp, owner: LocalAccount, chainId: number): Promise<UserOp> {
  const sig = await owner.signMessage({ message: { raw: userOpHash(op, chainId) } });
  return { ...op, signature: concat(["0x00", sig]) };
}

/** PaddyAccount session signature: 0x01 ‖ sessionKey(20) ‖ sig(65) over EIP-191(userOpHash). */
export async function signAsSession(op: UserOp, session: LocalAccount, chainId: number): Promise<UserOp> {
  const sig = await session.signMessage({ message: { raw: userOpHash(op, chainId) } });
  return { ...op, signature: concat([encodePacked(["uint8", "address"], [1, session.address]), sig]) };
}
