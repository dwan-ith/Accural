import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Keypair } from "@solana/web3.js";

process.env.ACCURAL_DB_PATH = join(mkdtempSync(join(tmpdir(), "accural-")), "test.db");

const { AccuralRuntime } = await import("./protocol.js");

function pubkey() {
  return Keypair.generate().publicKey.toBase58();
}

test("runs the policy-gated escrow and reconciliation loop", async () => {
  const runtime = new AccuralRuntime();
  await runtime.initialize();
  await runtime.resetDemoState();

  const beneficiary = pubkey();
  const verifier = pubkey();

  await runtime.createAgentWallet({ agentId: "jarvis" });
  await runtime.setSpendPolicy({
    agentId: "jarvis",
    maxPerTransaction: "15",
    sessionBudget: "30",
    approvalRequiredAbove: "12",
  });

  const intent = await runtime.requestPayment({
    requesterAgentId: "jarvis",
    taskId: "hero",
    amount: "10",
    recipientPubkey: beneficiary,
    purpose: "Escrow hero design",
  });

  const escrow = await runtime.createTaskEscrow({
    payerAgentId: "jarvis",
    taskId: "hero",
    amount: "10",
    purpose: "Escrow hero design",
    beneficiaryPubkey: beneficiary,
    verifierPubkey: verifier,
    paymentIntentId: String(intent.intentId),
  });

  assert.equal(escrow.status, "FUNDED");
  assert.equal(escrow.policy?.sessionBudgetRemaining, "20");

  const fundedBalance = await runtime.getBalance({ agentId: "jarvis" });
  assert.equal(fundedBalance.availableBudget, "20");
  assert.equal(fundedBalance.activeEscrow, "10");

  await runtime.releaseEscrow({
    taskId: "hero",
    verifierPubkey: verifier,
    outcome: "Verifier accepted the artifact",
    proofUri: "ipfs://proof/hero",
  });

  const releasedBalance = await runtime.getBalance({ agentId: "jarvis" });
  assert.equal(releasedBalance.activeEscrow, "0");
  assert.equal(releasedBalance.releasedSpend, "10");

  const records = await runtime.reconcilePayment("hero");
  assert.equal(records.length, 2);
  assert.equal(records[0].eventType, "ESCROW_FUNDED");
  assert.equal(records[1].eventType, "ESCROW_RELEASED");
  assert.equal(records[1].proofUri, "ipfs://proof/hero");
});

test("rejects policy violations instead of silently spending", async () => {
  const runtime = new AccuralRuntime();
  await runtime.initialize();
  await runtime.resetDemoState();

  const beneficiary = pubkey();
  const verifier = pubkey();

  await runtime.createAgentWallet({ agentId: "jarvis" });
  await runtime.setSpendPolicy({
    agentId: "jarvis",
    maxPerTransaction: "15",
    sessionBudget: "30",
    approvalRequiredAbove: "5",
  });

  const needsHumanIntent = await runtime.requestPayment({
    requesterAgentId: "jarvis",
    taskId: "needs-human",
    amount: "10",
    recipientPubkey: beneficiary,
    purpose: "Should require approval",
  });

  await assert.rejects(
    () =>
      runtime.createTaskEscrow({
        payerAgentId: "jarvis",
        taskId: "needs-human",
        amount: "10",
        purpose: "Should require approval",
        beneficiaryPubkey: beneficiary,
        verifierPubkey: verifier,
        paymentIntentId: String(needsHumanIntent.intentId),
      }),
    /human approval/,
  );

  const tooLargeIntent = await runtime.requestPayment({
    requesterAgentId: "jarvis",
    taskId: "too-large",
    amount: "20",
    recipientPubkey: beneficiary,
    purpose: "Too large",
  });

  await assert.rejects(
    () =>
      runtime.createTaskEscrow({
        payerAgentId: "jarvis",
        taskId: "too-large",
        amount: "20",
        purpose: "Too large",
        beneficiaryPubkey: beneficiary,
        verifierPubkey: verifier,
        paymentIntentId: String(tooLargeIntent.intentId),
        humanApproved: true,
      }),
    /max_per_transaction/,
  );
});

test("requires escrow details to match a requested payment intent", async () => {
  const runtime = new AccuralRuntime();
  await runtime.initialize();
  await runtime.resetDemoState();

  const beneficiary = pubkey();
  const verifier = pubkey();

  await runtime.createAgentWallet({ agentId: "jarvis" });
  await runtime.setSpendPolicy({
    agentId: "jarvis",
    maxPerTransaction: "10",
    sessionBudget: "10",
    approvalRequiredAbove: "10",
  });

  await assert.rejects(
    () =>
      runtime.createTaskEscrow({
        payerAgentId: "jarvis",
        taskId: "missing-intent",
        amount: "5",
        purpose: "Missing intent",
        beneficiaryPubkey: beneficiary,
        verifierPubkey: verifier,
        paymentIntentId: "",
      }),
    /paymentIntentId is required/,
  );

  const intent = await runtime.requestPayment({
    requesterAgentId: "jarvis",
    taskId: "intent-match",
    amount: "5",
    recipientPubkey: beneficiary,
    purpose: "Canonical purpose",
  });

  await assert.rejects(
    () =>
      runtime.createTaskEscrow({
        payerAgentId: "jarvis",
        taskId: "intent-match",
        amount: "5",
        purpose: "Different purpose",
        beneficiaryPubkey: beneficiary,
        verifierPubkey: verifier,
        paymentIntentId: String(intent.intentId),
      }),
    /purpose does not match/,
  );
});

test("rejects blocked recipients and wrong verifier release", async () => {
  const runtime = new AccuralRuntime();
  await runtime.initialize();
  await runtime.resetDemoState();

  const beneficiary = pubkey();
  const verifier = pubkey();

  await runtime.createAgentWallet({ agentId: "jarvis" });
  await runtime.setSpendPolicy({
    agentId: "jarvis",
    maxPerTransaction: "10",
    sessionBudget: "10",
    approvalRequiredAbove: "10",
    blockedRecipients: [beneficiary],
  });

  await assert.rejects(
    () =>
      runtime.requestPayment({
        requesterAgentId: "jarvis",
        taskId: "blocked",
        amount: "1",
        recipientPubkey: beneficiary,
        purpose: "Blocked recipient",
      }),
    /blocked by policy/,
  );

  await runtime.setSpendPolicy({
    agentId: "jarvis",
    maxPerTransaction: "10",
    sessionBudget: "10",
    approvalRequiredAbove: "10",
  });

  const releaseCheckIntent = await runtime.requestPayment({
    requesterAgentId: "jarvis",
    taskId: "release-check",
    amount: "5",
    recipientPubkey: beneficiary,
    purpose: "Check verifier",
  });

  await runtime.createTaskEscrow({
    payerAgentId: "jarvis",
    taskId: "release-check",
    amount: "5",
    purpose: "Check verifier",
    beneficiaryPubkey: beneficiary,
    verifierPubkey: verifier,
    paymentIntentId: String(releaseCheckIntent.intentId),
  });

  await assert.rejects(
    () =>
      runtime.releaseEscrow({
        taskId: "release-check",
        verifierPubkey: pubkey(),
        outcome: "Wrong signer",
        proofUri: "ipfs://proof/wrong",
      }),
    /Only the escrow verifier/,
  );
});
