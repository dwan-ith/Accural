import { readFileSync } from "node:fs";
import { Keypair } from "@solana/web3.js";
import { parseBooleanEnv, solanaRpcUrl } from "./config.js";
import { AccuralSolanaClient, type TransactionBundlePlan } from "./solana/accural-client.js";
import {
  assertValidTransactionBundlePlan,
  bundlePlanHash,
  executeTransactionBundle,
} from "./solana/execute-bundle.js";

const planPath = requiredEnv("ACCURAL_BUNDLE_PLAN_PATH");
const ownerKeypairPath = requiredEnv("ACCURAL_OWNER_KEYPAIR");
const verifierKeypairPath = process.env.ACCURAL_VERIFIER_KEYPAIR;
const rpcUrl = solanaRpcUrl();
const simulateBeforeSend = parseBooleanEnv(process.env.ACCURAL_SIMULATE_BEFORE_SEND, true);

const bundle = JSON.parse(readFileSync(planPath, "utf8")) as TransactionBundlePlan;
assertValidTransactionBundlePlan(bundle);

const owner = loadKeypair(ownerKeypairPath);
const signers = new Map<string, Keypair>([[owner.publicKey.toBase58(), owner]]);
if (verifierKeypairPath) {
  const verifier = loadKeypair(verifierKeypairPath);
  signers.set(verifier.publicKey.toBase58(), verifier);
}

for (const phase of bundle.phases) {
  for (const signerPubkey of phase.signerPubkeys) {
    if (!signers.has(signerPubkey)) {
      throw new Error(
        `Missing keypair for signer ${signerPubkey}. Provide ACCURAL_OWNER_KEYPAIR and, when verifier differs, ACCURAL_VERIFIER_KEYPAIR.`,
      );
    }
  }
}

const client = new AccuralSolanaClient({ rpcUrl });
const result = await executeTransactionBundle({
  client,
  bundle,
  signers,
  simulateBeforeSend,
});

console.log(
  JSON.stringify(
    {
      ...result,
      rpcUrl,
      simulateBeforeSend,
      verifiedBundleHash: bundlePlanHash(bundle),
    },
    null,
    2,
  ),
);

function requiredEnv(name: string) {
  const value = process.env[name];
  if (!value?.trim()) {
    throw new Error(`${name} is required.`);
  }
  return value.trim();
}

function loadKeypair(path: string) {
  const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
  if (!Array.isArray(raw) || raw.some((item) => typeof item !== "number")) {
    throw new Error(`${path} must contain a Solana CLI keypair JSON array.`);
  }
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}
