import { writeFileSync } from "node:fs";
import { runAgentSolanaPlan } from "./agents/run.js";
import type { AgentMode } from "./agents/types.js";

const mode = parseMode(process.argv[2] ?? process.env.ACCURAL_AGENT_MODE ?? "deterministic");

const result = await runAgentSolanaPlan({
  mode,
  ownerPubkey: process.env.ACCURAL_OWNER_PUBKEY,
  workerPubkey: process.env.ACCURAL_WORKER_PUBKEY,
  verifierPubkey: process.env.ACCURAL_VERIFIER_PUBKEY,
  mint: process.env.ACCURAL_MINT,
  payerTokenAccount: process.env.ACCURAL_PAYER_TOKEN_ACCOUNT,
  escrowTokenAccount: process.env.ACCURAL_ESCROW_TOKEN_ACCOUNT,
  beneficiaryTokenAccount: process.env.ACCURAL_BENEFICIARY_TOKEN_ACCOUNT,
  goal: {
    goal: process.env.ACCURAL_AGENT_GOAL,
    budget: process.env.ACCURAL_AGENT_BUDGET,
    taskId: process.env.ACCURAL_AGENT_TASK_ID,
  },
});

console.log(JSON.stringify(result, null, 2));

if (process.env.ACCURAL_BUNDLE_PLAN_PATH?.trim()) {
  writeFileSync(
    process.env.ACCURAL_BUNDLE_PLAN_PATH,
    JSON.stringify(result.solana.transactionBundle, null, 2),
  );
}

function parseMode(value: string): AgentMode {
  if (value === "deterministic" || value === "llm") {
    return value;
  }
  throw new Error("Usage: npm run agents:solana-plan -- deterministic|llm");
}
