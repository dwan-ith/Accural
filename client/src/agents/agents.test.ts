import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Keypair } from "@solana/web3.js";
import { StubLlmClient } from "./llm.js";

process.env.ACCURAL_DB_PATH = join(mkdtempSync(join(tmpdir(), "accural-agents-")), "test.db");

const { runAgentDemo, runAgentSolanaPlan } = await import("./run.js");

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

test("deterministic agents can produce wallet-ready Solana settlement plans", async () => {
  const ownerPubkey = Keypair.generate().publicKey.toBase58();
  const workerPubkey = Keypair.generate().publicKey.toBase58();
  const verifierPubkey = Keypair.generate().publicKey.toBase58();
  const mint = Keypair.generate().publicKey.toBase58();

  const result = await runAgentSolanaPlan({
    mode: "deterministic",
    ownerPubkey,
    workerPubkey,
    verifierPubkey,
    mint,
    goal: {
      goal: "Ship a Solana-planned campaign artifact.",
      budget: "30",
      taskId: "solana-agent-plan",
    },
    expiresAt: 1_800_000_000n,
  });

  assert.equal(result.settlementMode, "solana-plan");
  assert.equal(result.solana.participants.ownerPubkey, ownerPubkey);
  assert.equal(result.solana.participants.workerPubkey, workerPubkey);
  assert.equal(result.solana.instructions.fundEscrow.signerPubkeys[0], ownerPubkey);
  assert.equal(result.solana.instructions.releaseEscrow.signerPubkeys[0], verifierPubkey);
  assert.deepEqual(
    result.solana.transactionBundle.phases.map((phase) => phase.phase),
    [
      "setup-token-accounts",
      "initialize-agent-policy",
      "request-and-fund-escrow",
      "release-escrow",
    ],
  );
  assert.deepEqual(result.solana.transactionBundle.phases[2]?.signerPubkeys, [ownerPubkey]);
  assert.deepEqual(result.solana.transactionBundle.phases[3]?.signerPubkeys, [verifierPubkey]);
  assert.equal(
    result.solana.instructions.requestPayment.instruction.keys[3]?.pubkey,
    result.solana.addresses.paymentIntent,
  );
  assert.equal(
    result.solana.instructions.fundEscrow.instruction.keys[3]?.pubkey,
    result.solana.addresses.paymentIntent,
  );
  assert.equal(
    result.solana.instructions.releaseEscrow.instruction.keys[7]?.pubkey,
    result.solana.addresses.reconciliationRecord,
  );
  assert.match(result.solana.addresses.agentReputation, /^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
  assert.match(result.solana.reconciliationHashHex, /^[0-9a-f]{64}$/);
  assert.ok(result.solana.preconditions.some((item) => item.includes("Anchor program enforces")));
});

test("Solana agent plans reject values that would fail on-chain string limits", async () => {
  await assert.rejects(
    () =>
      runAgentSolanaPlan({
        mode: "deterministic",
        goal: {
          goal: "This should fail before a wallet sees an invalid Solana transaction.",
          budget: "30",
          taskId: "this-task-id-is-too-long-for-the-anchor-account-seed",
        },
      }),
    /taskId must be non-empty and at most 32 UTF-8 bytes/,
  );
});

test("Solana agent plans reject LLM spend proposals that exceed policy", async () => {
  const llm = new StubLlmClient([
    {
      agentId: "campaign-coordinator",
      taskId: "too-expensive",
      budget: "30",
      maxPerTransaction: "15",
      approvalRequiredAbove: "12",
      taskBrief: "Create an expensive artifact.",
    },
    {
      agentId: "specialist-worker",
      amount: "20",
      purpose: "Over-policy artifact.",
    },
  ]);

  await assert.rejects(
    () =>
      runAgentSolanaPlan({
        mode: "llm",
        llm,
        ownerPubkey: Keypair.generate().publicKey.toBase58(),
        workerPubkey: Keypair.generate().publicKey.toBase58(),
        verifierPubkey: Keypair.generate().publicKey.toBase58(),
        mint: Keypair.generate().publicKey.toBase58(),
      }),
    /proposal amount exceeds the maxPerTransaction policy/,
  );
});

test("Solana agent plans require explicit human approval above policy threshold", async () => {
  const responses = [
    {
      agentId: "campaign-coordinator",
      taskId: "approval-task",
      budget: "30",
      maxPerTransaction: "15",
      approvalRequiredAbove: "12",
      taskBrief: "Create an approval-gated artifact.",
    },
    {
      agentId: "specialist-worker",
      amount: "13",
      purpose: "Above threshold artifact.",
    },
    {
      artifactUri: "ipfs://accural-demo/approval-task",
      summary: "Artifact for approval-gated task.",
    },
    {
      approved: true,
      outcome: "Verifier accepted the approval-gated artifact.",
      proofUri: "ipfs://accural-demo/approval-task",
    },
  ];

  await assert.rejects(
    () =>
      runAgentSolanaPlan({
        mode: "llm",
        llm: new StubLlmClient(responses),
        ownerPubkey: Keypair.generate().publicKey.toBase58(),
        workerPubkey: Keypair.generate().publicKey.toBase58(),
        verifierPubkey: Keypair.generate().publicKey.toBase58(),
        mint: Keypair.generate().publicKey.toBase58(),
      }),
    /requires human approval/,
  );

  const approved = await runAgentSolanaPlan({
    mode: "llm",
    llm: new StubLlmClient(responses),
    ownerPubkey: Keypair.generate().publicKey.toBase58(),
    workerPubkey: Keypair.generate().publicKey.toBase58(),
    verifierPubkey: Keypair.generate().publicKey.toBase58(),
    mint: Keypair.generate().publicKey.toBase58(),
    humanApproved: true,
  });
  assert.equal(approved.proposal.amount, "13");
});
