import { createHash, randomUUID } from "node:crypto";

export const USDC_DECIMALS = 6;
export const DEFAULT_ASSET = "USDC";

export function parseUsdcAmount(amount: string) {
  const normalized = amount.trim();
  if (!/^\d+(\.\d{1,6})?$/.test(normalized)) {
    throw new Error("Amount must be a non-negative USDC decimal with at most 6 decimal places.");
  }

  const [whole, fractional = ""] = normalized.split(".");
  const minorUnits = `${whole}${fractional.padEnd(USDC_DECIMALS, "0")}`;
  return BigInt(minorUnits);
}

export function formatUsdcAmount(minorUnits: string | bigint) {
  const value = typeof minorUnits === "bigint" ? minorUnits : BigInt(minorUnits);
  const whole = value / 1_000_000n;
  const fractional = (value % 1_000_000n).toString().padStart(USDC_DECIMALS, "0");
  const trimmedFractional = fractional.replace(/0+$/, "");
  return trimmedFractional ? `${whole}.${trimmedFractional}` : whole.toString();
}

export function makeId(prefix: string) {
  return `${prefix}_${randomUUID()}`;
}

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }

  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(",")}}`;
  }

  return JSON.stringify(value);
}

export function semanticHash(value: unknown) {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}
