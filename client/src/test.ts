import assert from "node:assert/strict";
import { runAgentDemo } from "./agents/run.js";

async function runDemo() {
  console.log("=== Accural Agent Coordination Loop ===");

  const result = await runAgentDemo({
    mode: "deterministic",
    resetState: true,
  });

  console.log(JSON.stringify(result, null, 2));

  const reconciliation = result.accural.reconciliation as Array<{ eventType: string }>;
  assert.equal(result.verification.approved, true);
  assert.equal(reconciliation.length, 2);
  assert.equal(reconciliation[0].eventType, "ESCROW_FUNDED");
  assert.equal(reconciliation[1].eventType, "ESCROW_RELEASED");

  console.log("\n=== Demo Script Finished ===");
}

runDemo().catch((error) => {
  console.error(error);
  process.exit(1);
});
