import assert from "node:assert/strict";
import { Keypair } from "@solana/web3.js";
import {
  createMint,
  getAccount,
  getOrCreateAssociatedTokenAccount,
  mintTo,
} from "@solana/spl-token";
import {
  ACTION_ALL,
  ACCURAL_PROGRAM_ID,
  AccuralSolanaClient,
  semanticReconciliationHash,
} from "./solana/accural-client.js";
import { solanaRpcUrl } from "./config.js";

const RPC_URL = solanaRpcUrl();
const USDC_DECIMALS = 6;

async function main() {
  const client = new AccuralSolanaClient({ rpcUrl: RPC_URL });
  await client.waitForRpc();
  await client.assertProgramDeployed();

  const owner = Keypair.generate();
  const verifier = Keypair.generate();
  const beneficiary = Keypair.generate();

  await retryAirdrop(client, owner.publicKey);
  await retryAirdrop(client, verifier.publicKey);

  const agentId = "accural-agent";
  const taskId = "hero";
  const amount = 10_000_000n;
  const policyBudget = 30_000_000n;
  const purpose = "Escrow hero design";
  const proofUri = "ipfs://proof/hero";

  const mint = await createMint(client.connection, owner, owner.publicKey, null, USDC_DECIMALS);
  const ownerToken = await getOrCreateAssociatedTokenAccount(
    client.connection,
    owner,
    mint,
    owner.publicKey,
  );
  const beneficiaryToken = await getOrCreateAssociatedTokenAccount(
    client.connection,
    owner,
    mint,
    beneficiary.publicKey,
  );
  await mintTo(client.connection, owner, mint, ownerToken.address, owner, Number(policyBudget));

  const agent = client.deriveAgentAddresses(owner.publicKey, agentId);
  const task = client.deriveTaskAddresses(agent.agentRegistry, taskId);
  const escrowToken = await getOrCreateAssociatedTokenAccount(
    client.connection,
    owner,
    mint,
    task.escrowAccount,
    true,
  );

  await client.sendIx(
    client.initializeAgentIx({
      owner: owner.publicKey,
      agentRegistry: agent.agentRegistry,
      policyVault: agent.policyVault,
      agentReputation: agent.agentReputation,
      agentId,
    }),
    [owner],
  );

  await client.sendIx(
    client.setPolicyIx({
      owner: owner.publicKey,
      agentRegistry: agent.agentRegistry,
      policyVault: agent.policyVault,
      maxPerTransaction: 15_000_000n,
      sessionBudget: policyBudget,
      approvalRequiredAbove: 12_000_000n,
      allowedActions: ACTION_ALL,
    }),
    [owner],
  );

  const policyBefore = await client.fetchPolicy(agent.policyVault);
  assert.equal(policyBefore.sessionBudgetRemaining, policyBudget);
  assert.equal(policyBefore.allowedActions, ACTION_ALL);

  await client.sendIx(
    client.requestPaymentIx({
      owner: owner.publicKey,
      agentRegistry: agent.agentRegistry,
      policyVault: agent.policyVault,
      paymentIntent: task.paymentIntent,
      taskId,
      amount,
      mint,
      recipient: beneficiary.publicKey,
      purpose,
      expiresAt: BigInt(Math.floor(Date.now() / 1000) + 3600),
    }),
    [owner],
  );

  const intent = await client.fetchPaymentIntent(task.paymentIntent);
  assert.equal(intent.taskId, taskId);
  assert.equal(intent.amount, amount);
  assert.equal(intent.recipient.toBase58(), beneficiary.publicKey.toBase58());
  assert.equal(intent.status, 0);

  await client.sendIx(
    client.fundEscrowIx({
      owner: owner.publicKey,
      agentRegistry: agent.agentRegistry,
      policyVault: agent.policyVault,
      paymentIntent: task.paymentIntent,
      escrowAccount: task.escrowAccount,
      escrowTokenAccount: escrowToken.address,
      payerTokenAccount: ownerToken.address,
      mint,
      beneficiary: beneficiary.publicKey,
      verifier: verifier.publicKey,
      taskId,
      amount,
      purpose,
      humanApproved: false,
    }),
    [owner],
  );

  const escrow = await client.fetchEscrow(task.escrowAccount);
  const escrowedIntent = await client.fetchPaymentIntent(task.paymentIntent);
  assert.equal(escrow.taskId, taskId);
  assert.equal(escrow.amount, amount);
  assert.equal(escrow.paymentIntent.toBase58(), task.paymentIntent.toBase58());
  assert.equal(escrow.beneficiary.toBase58(), beneficiary.publicKey.toBase58());
  assert.equal(escrow.verifier.toBase58(), verifier.publicKey.toBase58());
  assert.equal(escrow.status, 0);
  assert.equal(escrowedIntent.status, 1);

  const policyAfterFund = await client.fetchPolicy(agent.policyVault);
  assert.equal(policyAfterFund.sessionBudgetRemaining, policyBudget - amount);

  const escrowTokenState = await getAccount(client.connection, escrowToken.address);
  assert.equal(escrowTokenState.amount, amount);

  const reconciliationHash = semanticReconciliationHash({
    taskId,
    agentId,
    amount: amount.toString(),
    outcome: "accepted",
    proofUri,
  });

  await client.sendIx(
    client.releaseEscrowIx({
      verifier: verifier.publicKey,
      policyVault: agent.policyVault,
      agentReputation: agent.agentReputation,
      paymentIntent: task.paymentIntent,
      escrowAccount: task.escrowAccount,
      escrowTokenAccount: escrowToken.address,
      beneficiaryTokenAccount: beneficiaryToken.address,
      reconciliationRecord: task.reconciliationRecord,
      reconciliationHash,
      outcomeCode: 0,
      proofUri,
    }),
    [verifier],
  );

  const releasedEscrow = await client.fetchEscrow(task.escrowAccount);
  const paidIntent = await client.fetchPaymentIntent(task.paymentIntent);
  const reputation = await client.fetchAgentReputation(agent.agentReputation);
  assert.equal(releasedEscrow.status, 1);
  assert.equal(paidIntent.status, 2);
  assert.equal(reputation.totalTasksCompleted, 1n);
  assert.equal(reputation.totalVolumeMinor, amount);

  const beneficiaryTokenState = await getAccount(client.connection, beneficiaryToken.address);
  assert.equal(beneficiaryTokenState.amount, amount);

  const reconciliationInfo = await client.connection.getAccountInfo(
    task.reconciliationRecord,
    "confirmed",
  );
  assert.ok(reconciliationInfo, "reconciliation account should exist");

  console.log(
    JSON.stringify(
      {
        status: "ok",
        rpcUrl: RPC_URL,
        programId: ACCURAL_PROGRAM_ID.toBase58(),
        owner: owner.publicKey.toBase58(),
        agentRegistry: agent.agentRegistry.toBase58(),
        policyVault: agent.policyVault.toBase58(),
        agentReputation: agent.agentReputation.toBase58(),
        paymentIntent: task.paymentIntent.toBase58(),
        escrowAccount: task.escrowAccount.toBase58(),
        escrowTokenAccount: escrowToken.address.toBase58(),
        beneficiaryTokenAccount: beneficiaryToken.address.toBase58(),
        reconciliationRecord: task.reconciliationRecord.toBase58(),
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
