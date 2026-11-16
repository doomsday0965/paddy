/**
 * Gasless invoice payment with any injected wallet (MetaMask, Rabby, Coinbase Wallet in-app browser...).
 * The customer only SIGNS an EIP-3009 authorization bound to this invoice and amount; Paddy's relayer pays the gas.
 */
import { api } from "./api";

type Eth = { request(a: { method: string; params?: unknown[] }): Promise<any> };
export const injected = (): Eth | null => ((window as any).ethereum as Eth) ?? null;

const AEVUM = {
  chainId: "0xabe5",
  chainName: "QDay Aevum Testnet",
  nativeCurrency: { name: "tQDAY", symbol: "tQDAY", decimals: 18 },
  rpcUrls: ["https://rpc-test.qday.info"],
  blockExplorerUrls: ["https://explorer-test.qday.info"],
};

const EIP712Domain = [
  { name: "name", type: "string" },
  { name: "version", type: "string" },
  { name: "chainId", type: "uint256" },
  { name: "verifyingContract", type: "address" },
];

export async function payWithWallet(invoiceId: string, onStep: (s: string) => void): Promise<{ tx: string }> {
  const eth = injected();
  if (!eth) throw new Error("No wallet found in this browser.");
  onStep("Connecting wallet…");
  const [from] = await eth.request({ method: "eth_requestAccounts" });
  try {
    await eth.request({ method: "wallet_switchEthereumChain", params: [{ chainId: AEVUM.chainId }] });
  } catch (e: any) {
    if (e?.code === 4902) await eth.request({ method: "wallet_addEthereumChain", params: [AEVUM] });
    else throw e;
  }
  onStep("Preparing your authorization…");
  const { salt, typedData } = await api<{ salt: string; typedData: any }>(`/invoices/${invoiceId}/authorization`, { body: { from } });
  onStep("Approve the signature in your wallet (no gas)…");
  const signature = await eth.request({
    method: "eth_signTypedData_v4",
    params: [from, JSON.stringify({ ...typedData, types: { EIP712Domain, ...typedData.types } })],
  });
  onStep("Paddy is sending it to the chain…");
  const m = typedData.message;
  return api(`/invoices/${invoiceId}/relay`, { body: { from, amount: m.value, validAfter: m.validAfter, validBefore: m.validBefore, salt, signature } });
}
