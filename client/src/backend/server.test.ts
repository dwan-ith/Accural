import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Keypair } from "@solana/web3.js";

process.env.ACCURAL_DB_PATH = join(mkdtempSync(join(tmpdir(), "accural-backend-")), "test.db");

const { createBackendServer } = await import("./server.js");

function pubkey() {
  return Keypair.generate().publicKey.toBase58();
}

async function withBackend<T>(fn: (baseUrl: string) => Promise<T>) {
  const server = await createBackendServer();
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

test("serves the policy, escrow, release, and reconciliation backend API over HTTP", async () => {
  await withBackend(async (baseUrl) => {
    const agentId = "api-agent";
    const beneficiaryPubkey = pubkey();
    const verifierPubkey = pubkey();

    const health = await requestJson<{ ok: boolean; service: string }>(baseUrl, "/health");
    assert.equal(health.ok, true);
    assert.equal(health.service, "accural-backend");

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
  });
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
  });
});
