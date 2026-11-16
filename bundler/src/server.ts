import { createServer, type IncomingMessage } from "node:http";
import { createPublicClient, createWalletClient, http, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { aevumTestnet, ENTRY_POINT_V07 } from "./chain.ts";
import { MiniBundler, UserOpRejected } from "./bundler.ts";
import { fromRpc } from "./userop.ts";

/**
 * JSON-RPC server exposing the ERC-4337 bundler methods Paddy needs:
 *   eth_chainId, eth_supportedEntryPoints, eth_sendUserOperation,
 *   eth_getUserOperationReceipt, eth_estimateUserOperationGas (static limits, see README)
 * Env: BUNDLER_PRIVATE_KEY (testnet relayer key), RPC_URL, PORT (default 4337), BUNDLER_TOKEN (optional auth)
 */
const key = process.env.BUNDLER_PRIVATE_KEY as Hex | undefined;
if (!key) throw new Error("BUNDLER_PRIVATE_KEY is required (testnet-only key)");
const rpc = process.env.RPC_URL ?? aevumTestnet.rpcUrls.default.http[0];
const port = Number(process.env.PORT ?? 4337);
const token = process.env.BUNDLER_TOKEN;

const account = privateKeyToAccount(key);
const transport = http(rpc, { retryCount: 3, timeout: 30_000 });
const bundler = new MiniBundler({
  publicClient: createPublicClient({ chain: aevumTestnet, transport }),
  walletClient: createWalletClient({ chain: aevumTestnet, transport, account }),
  log: (m) => console.log(new Date().toISOString(), m),
});

const STATIC_GAS = {
  preVerificationGas: "0xea60", // 60k
  verificationGasLimit: "0x493e0", // 300k
  callGasLimit: "0x927c0", // 600k
  paymasterVerificationGasLimit: "0x186a0", // 100k
  paymasterPostOpGasLimit: "0xea60", // 60k
};

async function handle(method: string, params: unknown[]): Promise<unknown> {
  switch (method) {
    case "eth_chainId":
      return `0x${aevumTestnet.id.toString(16)}`;
    case "eth_supportedEntryPoints":
      return [ENTRY_POINT_V07];
    case "eth_estimateUserOperationGas":
      return STATIC_GAS;
    case "eth_sendUserOperation": {
      const [raw, ep] = params as [Record<string, unknown>, string];
      if (String(ep).toLowerCase() !== ENTRY_POINT_V07.toLowerCase()) {
        throw new UserOpRejected("unsupported entryPoint", -32602);
      }
      return bundler.send(fromRpc(raw));
    }
    case "eth_getUserOperationReceipt": {
      const r = await bundler.receipt(params[0] as Hex);
      return r ? JSON.parse(JSON.stringify(r, (_k, v) => (typeof v === "bigint" ? `0x${v.toString(16)}` : v))) : null;
    }
    default:
      throw new UserOpRejected(`method ${method} not supported`, -32601);
  }
}

function body(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => {
      data += c;
      if (data.length > 256_000) reject(new Error("body too large"));
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

createServer(async (req, res) => {
  res.setHeader("content-type", "application/json");
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("access-control-allow-headers", "content-type, authorization");
  if (req.method === "OPTIONS") return void res.end();
  if (req.method === "GET") return void res.end(JSON.stringify({ ok: true, entryPoint: ENTRY_POINT_V07, relayer: account.address }));
  if (token && req.headers.authorization !== `Bearer ${token}`) {
    res.statusCode = 401;
    return void res.end(JSON.stringify({ error: "unauthorized" }));
  }
  let id: unknown = null;
  try {
    const msg = JSON.parse(await body(req));
    id = msg.id ?? null;
    const result = await handle(msg.method, msg.params ?? []);
    res.end(JSON.stringify({ jsonrpc: "2.0", id, result }));
  } catch (e) {
    const code = e instanceof UserOpRejected ? e.code : -32603;
    const message = e instanceof Error ? e.message : String(e);
    res.end(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }));
  }
}).listen(port, process.env.HOST ?? "127.0.0.1", () => console.log(`Paddy bundler on ${process.env.HOST ?? "127.0.0.1"}:${port}, relayer ${account.address}, entryPoint ${ENTRY_POINT_V07}`));
