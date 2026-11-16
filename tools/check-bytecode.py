#!/usr/bin/env python3
"""Check that deployed runtime bytecode on Aevum matches this repo's build.

Workaround while explorer-test.qday.info source verification is unavailable.
Immutable slots are masked, and so is the trailing CBOR metadata (it embeds a source hash).
Usage: forge build && python3 tools/check-bytecode.py
"""
import json, subprocess, sys

RPC = "https://rpc-test.qday.info"
CONTRACTS = {
    "PayeeRegistry": "0x27f16054c035bc2450f5BABe2f63990dEc1D2E95",
    "InvoiceBook": "0x2b4A256024A58Ff0B62eEf853c8682124c3D2c16",
    "PaddyAccountFactory": "0x2b2c982A2B67Dd2be712Dc78DbD67c32EdD66DEd",
    "PaddyPaymaster": "0x9942FBa932735EFf9B55D8948701AEF5218491b5",
    "PaddyAccount": "0xf74269212d041589Fe7B2930428012CBcb4f60Dc",
}

def strip_meta(b: bytes) -> bytes:
    n = int.from_bytes(b[-2:], "big")
    return b[: -(n + 2)] if n + 2 < len(b) else b

ok = True
for name, addr in CONTRACTS.items():
    art = json.load(open(f"out/{name}.sol/{name}.json"))
    local = bytearray(bytes.fromhex(art["deployedBytecode"]["object"][2:]))
    onchain = bytearray(bytes.fromhex(subprocess.check_output(
        ["cast", "code", addr, "--rpc-url", RPC], text=True).strip()[2:]))
    for refs in art["deployedBytecode"].get("immutableReferences", {}).values():
        for r in refs:
            s, l = r["start"], r["length"]
            local[s:s + l] = b"\0" * l
            onchain[s:s + l] = b"\0" * l
    match = strip_meta(bytes(local)) == strip_meta(bytes(onchain))
    ok &= match
    print(f"{name:20} {addr}  {'MATCH' if match else 'MISMATCH'}  ({len(onchain)} bytes)")
sys.exit(0 if ok else 1)
