export const DEFAULT_SOLANA_RPC_URL = "https://api.devnet.solana.com";
export const LOCAL_VALIDATOR_RPC_URL = "http://127.0.0.1:8899";

export type SettlementMode = "local-sqlite-control-plane" | "solana-rpc-control-plane";

export function solanaRpcUrl(input?: string) {
  return input ?? process.env.ACCURAL_RPC_URL ?? DEFAULT_SOLANA_RPC_URL;
}

export function parseSettlementMode(value: string | undefined): SettlementMode {
  if (value === "local" || value === "local-sqlite-control-plane") {
    return "local-sqlite-control-plane";
  }
  if (value === "solana" || value === "solana-rpc-control-plane" || value === undefined) {
    return "solana-rpc-control-plane";
  }
  throw new Error("ACCURAL_SETTLEMENT_MODE must be solana or local.");
}

export function parseBooleanEnv(value: string | undefined, fallback: boolean) {
  if (value === undefined || value === null || !value.trim()) {
    return fallback;
  }
  if (value === "1" || value.toLowerCase() === "true") {
    return true;
  }
  if (value === "0" || value.toLowerCase() === "false") {
    return false;
  }
  throw new Error("Boolean environment values must be true/false or 1/0.");
}
