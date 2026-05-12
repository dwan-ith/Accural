import assert from "node:assert/strict";
import { Keypair, PublicKey } from "@solana/web3.js";
import {
  createMint,
  getAccount,
  getOrCreateAssociatedTokenAccount,
  mintTo,
} from "@solana/spl-token";
import { runAgentSolanaPlan } from "./agents/run.js";
import { parseUsdcAmount } from "./money.js";
import { ACCURAL_PROGRAM_ID, AccuralSolanaClient } from "./solana/accural-client.js";
import {
  bundlePlanHash,
  executeTransactionBundle,
  validateTransactionBundlePlan,
} from "./solana/execute-bundle.js";
import { solanaRpcUrl } from "./config.js";

const RPC_URL = solanaRpcUrl();
const USDC_DECIMALS = 6;

async function main() {
  const client = new AccuralSolanaClient({ rpcUrl: RPC_URL });
  await client.waitForRpc();
  const deployment = await client.assertProgramDeployed();

  const owner = Keypair.generate();
  const verifier = Keypair.generate();
  const worker = Keypair.generate();

  await retryAirdrop(client, owner.publicKey);
  await retryAirdrop(client, verifier.publicKey);

  const mint = await createMint(client.connection, owner, owner.publicKey, null, USDC_DECIMALS);
  const agentPlan = await runAgentSolanaPlan({
    mode: "deterministic",
    solanaClient: client,
    ownerPubkey: owner.publicKey.toBase58(),
    workerPubkey: worker.publicKey.toBase58(),
    verifierPubkey: verifier.publicKey.toBase58(),
    mint: mint.toBase58(),
    goal: {
      goal: "Run a real agent-planned Solana escrow settlement.",
      budget: "30",
      taskId: "agent-e2e",
    },
  });

  const payerToken = await getOrCreateAssociatedTokenAccount(
    client.connection,
    owner,
    mint,
    owner.publicKey,
  );
  await mintTo(
    client.connection,
    owner,
    mint,
    payerToken.address,
    owner,
    Number(parseUsdcAmount(agentPlan.plan.budget)),
  );

  const validation = validateTransactionBundlePlan(agentPlan.solana.transactionBundle);
  assert.equal(validation.ok, true, validation.errors.join(" "));

  const execution = await executeTransactionBundle({
    client,
    bundle: agentPlan.solana.transactionBundle,
    signers: new Map([
      [owner.publicKey.toBase58(), owner],
      [verifier.publicKey.toBase58(), verifier],
    ]),
    simulateBeforeSend: true,
  });

  const policy = await client.fetchPolicy(new PublicKey(agentPlan.solana.addresses.policyVault));
  const intent = await client.fetchPaymentIntent(new PublicKey(agentPlan.solana.addresses.paymentIntent));
  const escrow = await client.fetchEscrow(new PublicKey(agentPlan.solana.addresses.escrowAccount));
  const reconciliation = await client.fetchReconciliationRecord(
    new PublicKey(agentPlan.solana.addresses.reconciliationRecord),
  );
  const reputation = await client.fetchAgentReputation(
    new PublicKey(agentPlan.solana.addresses.agentReputation),
  );
  const beneficiaryToken = await getAccount(
    client.connection,
    new PublicKey(agentPlan.solana.participants.beneficiaryTokenAccount),
  );
  const escrowToken = await getAccount(
    client.connection,
    new PublicKey(agentPlan.solana.participants.escrowTokenAccount),
  );

  const amount = parseUsdcAmount(agentPlan.proposal.amount);
  assert.equal(policy.sessionBudgetRemaining, parseUsdcAmount(agentPlan.plan.budget) - amount);
  assert.equal(intent.status, 2);
  assert.equal(escrow.status, 1);
  assert.equal(escrow.amount, amount);
  assert.equal(escrow.beneficiary.toBase58(), worker.publicKey.toBase58());
  assert.equal(escrow.verifier.toBase58(), verifier.publicKey.toBase58());
  assert.equal(beneficiaryToken.amount, amount);
  assert.equal(escrowToken.amount, 0n);
  assert.equal(reconciliation.taskId, agentPlan.plan.taskId);
  assert.equal(reconciliation.amount, amount);
  assert.equal(reconciliation.proofUri, agentPlan.verification.proofUri);
  assert.equal(reconciliation.reconciliationHash.toString("hex"), agentPlan.solana.reconciliationHashHex);
  assert.equal(reputation.totalTasksCompleted, 1n);
  assert.equal(reputation.totalVolumeMinor, amount);

  console.log(
    JSON.stringify(
      {
        status: "ok",
        rpcUrl: RPC_URL,
        programId: ACCURAL_PROGRAM_ID.toBase58(),
        deployment,
        bundleId: execution.bundleId,
        bundleHash: bundlePlanHash(agentPlan.solana.transactionBundle),
        phaseSignatures: execution.phases,
        owner: owner.publicKey.toBase58(),
        worker: worker.publicKey.toBase58(),
        verifier: verifier.publicKey.toBase58(),
        mint: mint.toBase58(),
        agentRegistry: agentPlan.solana.addresses.agentRegistry,
        policyVault: agentPlan.solana.addresses.policyVault,
        agentReputation: agentPlan.solana.addresses.agentReputation,
        paymentIntent: agentPlan.solana.addresses.paymentIntent,
        escrowAccount: agentPlan.solana.addresses.escrowAccount,
        escrowTokenAccount: agentPlan.solana.participants.escrowTokenAccount,
        beneficiaryTokenAccount: agentPlan.solana.participants.beneficiaryTokenAccount,
        reconciliationRecord: agentPlan.solana.addresses.reconciliationRecord,
        amount: amount.toString(),
      },
      null,
      2,
    ),
  );
}

async function retryAirdrop(client: AccuralSolanaClient, pubkey: Keypair["publicKey"]) {
  for (let attempt = 1; attempt <= 10; attempt++) {
    try {
      return await client.airdrop(pubkey);
    } catch (error) {
      if (attempt === 10) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
