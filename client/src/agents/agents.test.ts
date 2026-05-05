import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { StubLlmClient } from "./llm.js";

process.env.ACCURAL_DB_PATH = join(mkdtempSync(join(tmpdir(), "accural-agents-")), "test.db");

const { runAgentDemo } = await import("./run.js");

test("deterministic agents coordinate payment intent, escrow, verification, and reconciliation", async () => {
  const result = await runAgentDemo({
    mode: "deterministic",
    resetState: true,
  });

  assert.equal(result.mode, "deterministic");
  assert.equal(result.plan.agentId, "campaign-coordinator");
  assert.equal(result.proposal.agentId, "specialist-worker");
  assert.equal(result.verification.approved, true);
  assert.equal(Array.isArray(result.accural.reconciliation), true);
  assert.equal(result.accural.reconciliation.length, 2);
  assert.equal(
    result.accural.finalBalance.releasedSpend,
    result.proposal.amount,
  );
});

test("llm agents can drive the same Accural rails through a provided LLM client", async () => {
  const llm = new StubLlmClient([
    {
      agentId: "campaign-coordinator",
      taskId: "llm-hero",
      budget: "30",
      maxPerTransaction: "15",
      approvalRequiredAbove: "12",
      taskBrief: "Create a landing page hero section.",
    },
    {
      agentId: "specialist-worker",
      amount: "10",
      purpose: "LLM-proposed hero section artifact.",
    },
    {
      artifactUri: "ipfs://accural-demo/llm-hero",
      summary: "Artifact for landing page hero section.",
    },
    {
      approved: true,
      outcome: "LLM verifier accepted the artifact.",
      proofUri: "ipfs://accural-demo/llm-hero",
    },
  ]);

  const result = await runAgentDemo({
    mode: "llm",
    llm,
    resetState: true,
  });

  assert.equal(result.mode, "llm");
  assert.equal(result.plan.taskId, "llm-hero");
  assert.equal(result.verification.approved, true);
  assert.equal(result.accural.paymentIntent.amount, "10");
  assert.equal(result.accural.release.status, "RELEASED");
});
