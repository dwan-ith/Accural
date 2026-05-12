import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Keypair, SystemProgram, TransactionInstruction } from "@solana/web3.js";
import { AccuralSolanaClient } from "../solana/accural-client.js";

process.env.ACCURAL_DB_PATH = join(mkdtempSync(join(tmpdir(), "accural-backend-")), "test.db");

const { createBackendServer } = await import("./server.js");

function pubkey() {
  return Keypair.generate().publicKey.toBase58();
}

async function withBackend<T>(
  fn: (baseUrl: string) => Promise<T>,
  options?: Parameters<typeof createBackendServer>[0],
) {
  const server = await createBackendServer(options);
  await new Promise<void>((resolveListen) => {
    server.listen(0, "127.0.0.1", resolveListen);
  });

  const address = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}`;
  try {
    return await fn(baseUrl);
  } finally {
    await new Promise<void>((resolveClose, rejectClose) => {
      server.close((error) => (error ? rejectClose(error) : resolveClose()));
    });
  }
}

async function requestJson<T>(baseUrl: string, path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  const payload = (await response.json()) as unknown;
  if (!response.ok) {
    throw new Error(JSON.stringify(payload));
  }
  return payload as T;
}

test("defaults the backend boundary to Solana planning instead of local SQLite settlement", async () => {
  await withBackend(async (baseUrl) => {
    const health = await requestJson<{
      settlementMode: string;
      settlementBoundary: string;
    }>(baseUrl, "/health");

    assert.equal(health.settlementMode, "solana-rpc-control-plane");
    assert.match(health.settlementBoundary, /Solana RPC/);
    await assert.rejects(
      () =>
        requestJson(baseUrl, "/agents", {
          method: "POST",
          body: JSON.stringify({ agentId: "local-only" }),
        }),
      /local SQLite control plane/,
    );
  });
});

test("serves the policy, escrow, release, and reconciliation backend API over HTTP", async () => {
  await withBackend(async (baseUrl) => {
    const agentId = "api-agent";
    const beneficiaryPubkey = pubkey();
    const verifierPubkey = pubkey();

    const health = await requestJson<{ ok: boolean; service: string }>(baseUrl, "/health");
    assert.equal(health.ok, true);
    assert.equal(health.service, "accural-backend");

    const settlement = await requestJson<{
      settlementMode: string;
      ready: boolean;
      settlesOnChain: boolean;
    }>(baseUrl, "/settlement/status");
    assert.equal(settlement.settlementMode, "local-sqlite-control-plane");
    assert.equal(settlement.ready, true);
    assert.equal(settlement.settlesOnChain, false);

    const agent = await requestJson<{ agentId: string; walletPubkey: string }>(baseUrl, "/agents", {
      method: "POST",
      body: JSON.stringify({ agentId }),
    });
    assert.equal(agent.agentId, agentId);
    assert.ok(agent.walletPubkey);

    const policy = await requestJson<{ sessionBudgetRemaining: string }>(baseUrl, "/policies", {
      method: "POST",
      body: JSON.stringify({
        agentId,
        maxPerTransaction: "15",
        sessionBudget: "30",
        approvalRequiredAbove: "15",
      }),
    });
    assert.equal(policy.sessionBudgetRemaining, "30");

    const intent = await requestJson<{ intentId: string; status: string }>(baseUrl, "/payment-intents", {
      method: "POST",
      body: JSON.stringify({
        requesterAgentId: agentId,
        taskId: "api-task",
        amount: "10",
        recipientPubkey: beneficiaryPubkey,
        purpose: "Backend integration test task escrow",
      }),
    });
    assert.equal(intent.status, "REQUESTED");

    const escrow = await requestJson<{ escrowId: string; status: string; policy: { sessionBudgetRemaining: string } }>(
      baseUrl,
      "/escrows",
      {
        method: "POST",
        body: JSON.stringify({
          payerAgentId: agentId,
          taskId: "api-task",
          amount: "10",
          purpose: "Backend integration test task escrow",
          beneficiaryPubkey,
          verifierPubkey,
          paymentIntentId: intent.intentId,
        }),
      },
    );
    assert.equal(escrow.status, "FUNDED");
    assert.equal(escrow.policy.sessionBudgetRemaining, "20");

    const release = await requestJson<{ status: string; reconciliation: { semanticHash: string } }>(
      baseUrl,
      "/escrows/api-task/release",
      {
        method: "POST",
        body: JSON.stringify({
          verifierPubkey,
          outcome: "Deterministic verifier accepted the delivered artifact.",
          proofUri: "ipfs://proof/backend-api-task",
        }),
      },
    );
    assert.equal(release.status, "RELEASED");
    assert.ok(release.reconciliation.semanticHash);

    const reconciliation = await requestJson<Array<{ eventType: string; proofUri: string | null }>>(
      baseUrl,
      "/reconciliation?taskId=api-task",
    );
    assert.deepEqual(
      reconciliation.map((record) => record.eventType),
      ["ESCROW_FUNDED", "ESCROW_RELEASED"],
    );
    assert.equal(reconciliation[1]?.proofUri, "ipfs://proof/backend-api-task");

    const balance = await requestJson<{ availableBudget: string; activeEscrow: string; releasedSpend: string }>(
      baseUrl,
      "/agents/api-agent/balance",
    );
    assert.equal(balance.availableBudget, "20");
    assert.equal(balance.activeEscrow, "0");
    assert.equal(balance.releasedSpend, "10");
  }, { settlementMode: "local-sqlite-control-plane" });
});

test("runs the deterministic agent backend endpoint without requiring an LLM key", async () => {
  await withBackend(async (baseUrl) => {
    const result = await requestJson<{
      mode: string;
      accural: { reconciliation: Array<{ eventType: string }> };
    }>(baseUrl, "/agent-runs", {
      method: "POST",
      body: JSON.stringify({
        mode: "deterministic",
        goal: {
          goal: "Ship a backend-observed campaign artifact.",
          budget: "30",
          taskId: "backend-agent-run",
        },
      }),
    });

    assert.equal(result.mode, "deterministic");
    assert.deepEqual(
      result.accural.reconciliation.map((record) => record.eventType),
      ["ESCROW_FUNDED", "ESCROW_RELEASED"],
    );
  }, { settlementMode: "local-sqlite-control-plane" });
});

test("serves Solana instruction plans in explicit solana settlement mode", async () => {
  await withBackend(
    async (baseUrl) => {
      const ownerPubkey = pubkey();
      const beneficiaryPubkey = pubkey();
      const verifierPubkey = pubkey();
      const mint = pubkey();
      const escrowTokenAccount = pubkey();
      const payerTokenAccount = pubkey();
      const beneficiaryTokenAccount = pubkey();

      const initialize = await requestJson<{
        settlementMode: string;
        signerPubkeys: string[];
        addresses: { agentRegistry: string; policyVault: string };
        instruction: { programId: string; dataBase64: string; keys: Array<{ pubkey: string; isSigner: boolean; isWritable: boolean }> };
      }>(baseUrl, "/solana/agents/initialize-plan", {
        method: "POST",
        body: JSON.stringify({
          ownerPubkey,
          agentId: "api-agent",
        }),
      });

      assert.equal(initialize.settlementMode, "solana-rpc-control-plane");
      assert.deepEqual(initialize.signerPubkeys, [ownerPubkey]);
      assert.ok(initialize.addresses.agentRegistry);
      assert.equal(initialize.instruction.keys[0]?.pubkey, ownerPubkey);
      assert.equal(initialize.instruction.keys[0]?.isSigner, true);

      const requestIntent = await requestJson<{
          addresses: { paymentIntent: string; escrowAccount: string; reconciliationRecord: string };
        instruction: { keys: Array<{ pubkey: string; isSigner: boolean; isWritable: boolean }> };
      }>(baseUrl, "/solana/payment-intents/request-plan", {
        method: "POST",
        body: JSON.stringify({
          ownerPubkey,
          agentId: "api-agent",
          taskId: "api-task",
          amount: "10",
          mint,
          recipientPubkey: beneficiaryPubkey,
          purpose: "Backend planned payment intent",
        }),
      });

      assert.ok(requestIntent.addresses.paymentIntent);
      assert.equal(requestIntent.instruction.keys[0]?.pubkey, ownerPubkey);

      const fund = await requestJson<{
        signerPubkeys: string[];
        addresses: { paymentIntent: string; escrowAccount: string };
        tokenAccounts: { payerTokenAccount: string; escrowTokenAccount: string; beneficiaryTokenAccount: string };
        setupInstructions: {
          setupPayerTokenAccount: { signerPubkeys: string[]; instruction: { keys: Array<{ pubkey: string }> } };
          setupEscrowTokenAccount: { signerPubkeys: string[]; instruction: { keys: Array<{ pubkey: string }> } };
          setupBeneficiaryTokenAccount: { signerPubkeys: string[]; instruction: { keys: Array<{ pubkey: string }> } };
        };
        preconditions: string[];
        instruction: { keys: Array<{ pubkey: string; isSigner: boolean; isWritable: boolean }> };
      }>(baseUrl, "/solana/escrows/fund-plan", {
        method: "POST",
        body: JSON.stringify({
          ownerPubkey,
          agentId: "api-agent",
          taskId: "api-task",
          amount: "10",
          purpose: "Backend planned payment intent",
          mint,
          beneficiaryPubkey,
          verifierPubkey,
        }),
      });

      assert.deepEqual(fund.signerPubkeys, [ownerPubkey]);
      assert.equal(fund.addresses.paymentIntent, requestIntent.addresses.paymentIntent);
      assert.equal(fund.instruction.keys[3]?.pubkey, requestIntent.addresses.paymentIntent);
      assert.equal(fund.instruction.keys[5]?.pubkey, fund.tokenAccounts.escrowTokenAccount);
      assert.equal(fund.instruction.keys[6]?.pubkey, fund.tokenAccounts.payerTokenAccount);
      assert.deepEqual(fund.setupInstructions.setupEscrowTokenAccount.signerPubkeys, [ownerPubkey]);
      assert.equal(fund.setupInstructions.setupEscrowTokenAccount.instruction.keys[1]?.pubkey, fund.tokenAccounts.escrowTokenAccount);
      assert.ok(fund.preconditions.some((item) => item.includes("payment intent")));

      const release = await requestJson<{
        signerPubkeys: string[];
        addresses: { reconciliationRecord: string };
        instruction: { keys: Array<{ pubkey: string; isSigner: boolean; isWritable: boolean }> };
      }>(baseUrl, "/solana/escrows/release-plan", {
        method: "POST",
        body: JSON.stringify({
          ownerPubkey,
          agentId: "api-agent",
          taskId: "api-task",
          verifierPubkey,
          escrowTokenAccount: fund.tokenAccounts.escrowTokenAccount,
          beneficiaryTokenAccount: fund.tokenAccounts.beneficiaryTokenAccount,
          proofUri: "ipfs://proof/api-task",
        }),
      });

      assert.deepEqual(release.signerPubkeys, [verifierPubkey]);
      assert.equal(release.addresses.reconciliationRecord, requestIntent.addresses.reconciliationRecord);
      assert.equal(release.instruction.keys[0]?.pubkey, verifierPubkey);
      assert.equal(release.instruction.keys[0]?.isSigner, true);

      const service = await requestJson<{
        signerPubkeys: string[];
        addresses: { serviceListing: string };
        instruction: { keys: Array<{ pubkey: string }> };
      }>(baseUrl, "/solana/services/register-plan", {
        method: "POST",
        body: JSON.stringify({
          ownerPubkey,
          agentId: "api-agent",
          serviceType: "research",
          description: "Backend planned research service",
          price: "2",
          mint,
        }),
      });
      assert.deepEqual(service.signerPubkeys, [ownerPubkey]);
      assert.equal(service.instruction.keys[2]?.pubkey, service.addresses.serviceListing);

      const directPayment = await requestJson<{
        signerPubkeys: string[];
        addresses: { reconciliationRecord: string };
        tokenAccounts: { payerTokenAccount: string; recipientTokenAccount: string };
        setupInstructions: {
          setupRecipientTokenAccount: { signerPubkeys: string[]; instruction: { keys: Array<{ pubkey: string }> } };
        };
        reconciliationHashHex: string;
        instruction: { keys: Array<{ pubkey: string }> };
      }>(baseUrl, "/solana/direct-payments/plan", {
        method: "POST",
        body: JSON.stringify({
          ownerPubkey,
          agentId: "api-agent",
          taskId: "api-direct",
          amount: "2",
          purpose: "Backend planned direct payment",
          proofUri: "ipfs://proof/api-direct",
          mint,
          recipientPubkey: beneficiaryPubkey,
        }),
      });
      assert.deepEqual(directPayment.signerPubkeys, [ownerPubkey]);
      assert.match(directPayment.reconciliationHashHex, /^[0-9a-f]{64}$/);
      assert.equal(directPayment.instruction.keys[3]?.pubkey, directPayment.addresses.reconciliationRecord);
      assert.equal(directPayment.instruction.keys[5]?.pubkey, directPayment.tokenAccounts.recipientTokenAccount);
      assert.deepEqual(directPayment.setupInstructions.setupRecipientTokenAccount.signerPubkeys, [ownerPubkey]);

      const agentRun = await requestJson<{
        settlementMode: string;
        solana: {
          participants: { ownerPubkey: string; workerPubkey: string; verifierPubkey: string };
          addresses: { agentReputation: string; paymentIntent: string; reconciliationRecord: string };
          transactionBundle: { phases: Array<{ phase: string; signerPubkeys: string[]; instructions: unknown[] }> };
          instructions: {
            requestPayment: { instruction: { keys: Array<{ pubkey: string }> } };
            fundEscrow: { signerPubkeys: string[]; instruction: { keys: Array<{ pubkey: string }> } };
            releaseEscrow: { signerPubkeys: string[]; instruction: { keys: Array<{ pubkey: string }> } };
          };
        };
      }>(baseUrl, "/agent-runs/solana-plan", {
        method: "POST",
        body: JSON.stringify({
          mode: "deterministic",
          ownerPubkey,
          workerPubkey: beneficiaryPubkey,
          verifierPubkey,
          mint,
          escrowTokenAccount,
          payerTokenAccount,
          beneficiaryTokenAccount,
          goal: {
            goal: "Ship a backend Solana-planned campaign artifact.",
            budget: "30",
            taskId: "api-agent-run-plan",
          },
        }),
      });

      assert.equal(agentRun.settlementMode, "solana-plan");
      assert.equal(agentRun.solana.participants.ownerPubkey, ownerPubkey);
      assert.equal(agentRun.solana.instructions.fundEscrow.signerPubkeys[0], ownerPubkey);
      assert.equal(agentRun.solana.instructions.releaseEscrow.signerPubkeys[0], verifierPubkey);
      assert.deepEqual(
        agentRun.solana.transactionBundle.phases.map((phase) => phase.phase),
        ["initialize-agent-policy", "request-and-fund-escrow", "release-escrow"],
      );
      assert.equal(agentRun.solana.transactionBundle.phases[1]?.instructions.length, 2);
      assert.equal(
        agentRun.solana.instructions.requestPayment.instruction.keys[3]?.pubkey,
        agentRun.solana.addresses.paymentIntent,
      );
      assert.equal(
        agentRun.solana.instructions.releaseEscrow.instruction.keys[7]?.pubkey,
        agentRun.solana.addresses.reconciliationRecord,
      );
      assert.match(agentRun.solana.addresses.agentReputation, /^[1-9A-HJ-NP-Za-km-z]{32,44}$/);

      const priorOwnerKeypair = process.env.ACCURAL_OWNER_KEYPAIR;
      const priorVerifierKeypair = process.env.ACCURAL_VERIFIER_KEYPAIR;
      const priorExtraKeypairs = process.env.ACCURAL_EXTRA_SIGNER_KEYPAIRS;
      delete process.env.ACCURAL_OWNER_KEYPAIR;
      delete process.env.ACCURAL_VERIFIER_KEYPAIR;
      delete process.env.ACCURAL_EXTRA_SIGNER_KEYPAIRS;
      try {
        const client = new AccuralSolanaClient();
        const signer = Keypair.generate().publicKey;
        const bundle = client.transactionBundlePlan({
          bundleId: "backend-execute-missing-signer",
          phases: [
            {
              phase: "submit",
              description: "Backend should refuse execution without configured signer files.",
              signerPubkeys: [signer.toBase58()],
              instructions: [
                new TransactionInstruction({
                  programId: SystemProgram.programId,
                  data: Buffer.from([1]),
                  keys: [{ pubkey: signer, isSigner: true, isWritable: true }],
                }),
              ],
            },
          ],
        });
        await assert.rejects(
          () =>
            requestJson(baseUrl, "/solana/bundles/execute", {
              method: "POST",
              body: JSON.stringify({ bundle, simulateBeforeSend: false }),
            }),
          /missing/i,
        );
      } finally {
        if (priorOwnerKeypair === undefined) {
          delete process.env.ACCURAL_OWNER_KEYPAIR;
        } else {
          process.env.ACCURAL_OWNER_KEYPAIR = priorOwnerKeypair;
        }
        if (priorVerifierKeypair === undefined) {
          delete process.env.ACCURAL_VERIFIER_KEYPAIR;
        } else {
          process.env.ACCURAL_VERIFIER_KEYPAIR = priorVerifierKeypair;
        }
        if (priorExtraKeypairs === undefined) {
          delete process.env.ACCURAL_EXTRA_SIGNER_KEYPAIRS;
        } else {
          process.env.ACCURAL_EXTRA_SIGNER_KEYPAIRS = priorExtraKeypairs;
        }
      }
    },
    { settlementMode: "solana-rpc-control-plane", solanaRpcUrl: "http://127.0.0.1:8899" },
  );
});
