import { defineChain } from "viem";

export const aevumTestnet = defineChain({
  id: 44005,
  name: "QDay Aevum Testnet",
  nativeCurrency: { name: "tQDAY", symbol: "tQDAY", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc-test.qday.info"], webSocket: ["wss://rpc-test.qday.info"] } },
  blockExplorers: { default: { name: "Aevum Explorer", url: "https://explorer-test.qday.info" } },
  testnet: true,
});

/** Canonical ERC-4337 EntryPoint v0.7 (deployed on Aevum Testnet). */
export const ENTRY_POINT_V07 = "0x0000000071727De22E5E9d8BAf0edAc6f37da032" as const;
export const TUSD8 = "0x456569838f1d43009A91ebA4263147Afd7233483" as const;
