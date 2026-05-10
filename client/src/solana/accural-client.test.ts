import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import test from "node:test";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { ASSOCIATED_TOKEN_PROGRAM_ID } from "@solana/spl-token";
import {
  ACCURAL_PROGRAM_ID,
  ACTION_ALL,
  AccuralSolanaClient,
  accountDiscriminator,
  instructionDiscriminator,
  semanticReconciliationHash,
} from "./accural-client.js";

test("derives stable Accural PDAs for agent and task state", () => {
  const client = new AccuralSolanaClient({ rpcUrl: "http://127.0.0.1:8899" });
  const owner = new PublicKey("11111111111111111111111111111112");

  const agent = client.deriveAgentAddresses(owner, "agent-alpha");
  const task = client.deriveTaskAddresses(agent.agentRegistry, "task-alpha");

  assert.equal(agent.agentRegistry.toBase58(), client.deriveAgentAddresses(owner, "agent-alpha").agentRegistry.toBase58());
  assert.notEqual(agent.policyVault.toBase58(), agent.agentRegistry.toBase58());
  assert.notEqual(agent.agentReputation.toBase58(), agent.agentRegistry.toBase58());
  assert.notEqual(task.paymentIntent.toBase58(), task.escrowAccount.toBase58());
  assert.notEqual(task.reconciliationRecord.toBase58(), task.escrowAccount.toBase58());
});

test("builds Anchor-compatible initialize and release instruction accounts", () => {
  const client = new AccuralSolanaClient();
  const owner = Keypair.generate().publicKey;
  const verifier = Keypair.generate().publicKey;
  const agent = client.deriveAgentAddresses(owner, "agent-init");
  const task = client.deriveTaskAddresses(agent.agentRegistry, "task-init");
  const escrowTokenAccount = Keypair.generate().publicKey;
  const beneficiaryTokenAccount = Keypair.generate().publicKey;

  const initialize = client.initializeAgentIx({
    owner,
    agentRegistry: agent.agentRegistry,
    policyVault: agent.policyVault,
    agentReputation: agent.agentReputation,
    agentId: "agent-init",
  });
  assert.deepEqual(
    initialize.keys.map((key) => [key.pubkey.toBase58(), key.isSigner, key.isWritable]),
    [
      [owner.toBase58(), true, true],
      [agent.agentRegistry.toBase58(), false, true],
      [agent.policyVault.toBase58(), false, true],
      [agent.agentReputation.toBase58(), false, true],
      [SystemProgram.programId.toBase58(), false, false],
    ],
  );

  const release = client.releaseEscrowIx({
    verifier,
    policyVault: agent.policyVault,
    agentReputation: agent.agentReputation,
    paymentIntent: task.paymentIntent,
    escrowAccount: task.escrowAccount,
    escrowTokenAccount,
    beneficiaryTokenAccount,
    reconciliationRecord: task.reconciliationRecord,
    reconciliationHash: Buffer.alloc(32, 1),
    outcomeCode: 0,
    proofUri: "ipfs://proof/task-init",
  });
  assert.deepEqual(
    release.keys.map((key) => [key.pubkey.toBase58(), key.isSigner, key.isWritable]),
    [
      [verifier.toBase58(), true, true],
      [agent.policyVault.toBase58(), false, false],
      [agent.agentReputation.toBase58(), false, true],
      [task.paymentIntent.toBase58(), false, true],
      [task.escrowAccount.toBase58(), false, true],
      [escrowTokenAccount.toBase58(), false, true],
      [beneficiaryTokenAccount.toBase58(), false, true],
      [task.reconciliationRecord.toBase58(), false, true],
      [SystemProgram.programId.toBase58(), false, false],
      ["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", false, false],
    ],
  );
});

test("builds Anchor-compatible fund escrow instruction accounts", () => {
  const client = new AccuralSolanaClient();
  const owner = Keypair.generate().publicKey;
  const agent = client.deriveAgentAddresses(owner, "agent-alpha");
  const task = client.deriveTaskAddresses(agent.agentRegistry, "task-alpha");
  const escrowTokenAccount = Keypair.generate().publicKey;
  const payerTokenAccount = Keypair.generate().publicKey;
  const mint = Keypair.generate().publicKey;
  const beneficiary = Keypair.generate().publicKey;
  const verifier = Keypair.generate().publicKey;

  const instruction = client.fundEscrowIx({
    owner,
    agentRegistry: agent.agentRegistry,
    policyVault: agent.policyVault,
    paymentIntent: task.paymentIntent,
    escrowAccount: task.escrowAccount,
    escrowTokenAccount,
    payerTokenAccount,
    mint,
    beneficiary,
    verifier,
    taskId: "task-alpha",
    amount: 1_000_000n,
    purpose: "Pay for deterministic work",
    humanApproved: false,
  });

  assert.equal(instruction.programId.toBase58(), ACCURAL_PROGRAM_ID.toBase58());
  assert.deepEqual(
    Array.from(instruction.data.subarray(0, 8)),
    Array.from(instructionDiscriminator("fund_escrow")),
  );
  assert.deepEqual(
    instruction.keys.map((key) => [key.pubkey.toBase58(), key.isSigner, key.isWritable]),
    [
      [owner.toBase58(), true, true],
      [agent.agentRegistry.toBase58(), false, false],
      [agent.policyVault.toBase58(), false, true],
      [task.paymentIntent.toBase58(), false, true],
      [task.escrowAccount.toBase58(), false, true],
      [escrowTokenAccount.toBase58(), false, true],
      [payerTokenAccount.toBase58(), false, true],
      [mint.toBase58(), false, false],
      [beneficiary.toBase58(), false, false],
      [verifier.toBase58(), false, false],
      [SystemProgram.programId.toBase58(), false, false],
      ["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", false, false],
    ],
  );
});

test("encodes set policy allowed action bitmask", () => {
  const client = new AccuralSolanaClient();
  const owner = Keypair.generate().publicKey;
  const agent = client.deriveAgentAddresses(owner, "agent-beta");

  const instruction = client.setPolicyIx({
    owner,
    agentRegistry: agent.agentRegistry,
    policyVault: agent.policyVault,
    maxPerTransaction: 15_000_000n,
    sessionBudget: 30_000_000n,
    approvalRequiredAbove: 12_000_000n,
  });

  assert.deepEqual(
    Array.from(instruction.data.subarray(0, 8)),
    Array.from(instructionDiscriminator("set_policy")),
  );
  assert.equal(instruction.data.readUInt16LE(8 + 8 + 8 + 8), ACTION_ALL);
  assert.equal(Buffer.from(instruction.data.subarray(8, 16)).readBigUInt64LE(), 15_000_000n);
});

test("builds direct payment and service registry instructions exposed by the IDL", () => {
  const client = new AccuralSolanaClient();
  const owner = Keypair.generate().publicKey;
  const recipient = Keypair.generate().publicKey;
  const mint = Keypair.generate().publicKey;
  const payerTokenAccount = Keypair.generate().publicKey;
  const recipientTokenAccount = Keypair.generate().publicKey;
  const agent = client.deriveAgentAddresses(owner, "agent-direct");
  const service = client.deriveServiceAddresses(agent.agentRegistry, "research");
  const direct = client.deriveDirectPaymentAddresses(agent.agentRegistry, "direct-task");

  const registerService = client.registerServiceIx({
    owner,
    agentRegistry: agent.agentRegistry,
    serviceListing: service.serviceListing,
    mint,
    serviceType: "research",
    description: "Research service",
    priceMinor: 2_000_000n,
  });
  assert.deepEqual(
    Array.from(registerService.data.subarray(0, 8)),
    Array.from(instructionDiscriminator("register_service")),
  );

  const directPayment = client.directPaymentIx({
    owner,
    agentRegistry: agent.agentRegistry,
    policyVault: agent.policyVault,
    reconciliationRecord: direct.reconciliationRecord,
    payerTokenAccount,
    recipientTokenAccount,
    mint,
    recipient,
    taskId: "direct-task",
    amount: 2_000_000n,
    purpose: "Pay research service",
    reconciliationHash: Buffer.alloc(32, 4),
    proofUri: "ipfs://proof/direct-task",
  });
  assert.deepEqual(
    Array.from(directPayment.data.subarray(0, 8)),
    Array.from(instructionDiscriminator("direct_payment")),
  );
  assert.equal(directPayment.keys[3]?.pubkey.toBase58(), direct.reconciliationRecord.toBase58());
  assert.equal(directPayment.keys[5]?.pubkey.toBase58(), recipientTokenAccount.toBase58());
});

test("derives and plans associated token accounts for escrow settlement", () => {
  const client = new AccuralSolanaClient();
  const owner = Keypair.generate().publicKey;
  const beneficiary = Keypair.generate().publicKey;
  const mint = Keypair.generate().publicKey;
  const agent = client.deriveAgentAddresses(owner, "agent-gamma");
  const task = client.deriveTaskAddresses(agent.agentRegistry, "task-gamma");

  const tokenAccounts = client.deriveTokenAccounts({
    owner,
    escrowAccount: task.escrowAccount,
    beneficiary,
    mint,
  });
  const repeated = client.deriveTokenAccounts({
    owner,
    escrowAccount: task.escrowAccount,
    beneficiary,
    mint,
  });

  assert.equal(tokenAccounts.escrowTokenAccount.toBase58(), repeated.escrowTokenAccount.toBase58());
  assert.notEqual(tokenAccounts.escrowTokenAccount.toBase58(), tokenAccounts.payerTokenAccount.toBase58());

  const setup = client.createAssociatedTokenAccountIx({
    payer: owner,
    associatedTokenAccount: tokenAccounts.escrowTokenAccount,
    owner: task.escrowAccount,
    mint,
  });

  assert.equal(setup.programId.toBase58(), ASSOCIATED_TOKEN_PROGRAM_ID.toBase58());
  assert.equal(setup.keys[0]?.pubkey.toBase58(), owner.toBase58());
  assert.equal(setup.keys[1]?.pubkey.toBase58(), tokenAccounts.escrowTokenAccount.toBase58());
  assert.equal(setup.keys[2]?.pubkey.toBase58(), task.escrowAccount.toBase58());
});

test("rejects instruction inputs that violate Anchor account string limits", () => {
  const client = new AccuralSolanaClient();
  const owner = Keypair.generate().publicKey;
  const agent = client.deriveAgentAddresses(owner, "agent-delta");
  const task = client.deriveTaskAddresses(agent.agentRegistry, "task-delta");

  assert.throws(
    () =>
      client.requestPaymentIx({
        owner,
        agentRegistry: agent.agentRegistry,
        policyVault: agent.policyVault,
        paymentIntent: task.paymentIntent,
        taskId: "task-delta",
        amount: 1_000_000n,
        mint: Keypair.generate().publicKey,
        recipient: Keypair.generate().publicKey,
        purpose: "x".repeat(161),
        expiresAt: 1_800_000_000n,
      }),
    /purpose must be non-empty and at most 160 UTF-8 bytes/,
  );
});

test("decodes reconciliation record account data", async () => {
  const client = new AccuralSolanaClient();
  const escrow = Keypair.generate().publicKey;
  const agentRegistry = Keypair.generate().publicKey;
  const mint = Keypair.generate().publicKey;
  const beneficiary = Keypair.generate().publicKey;
  const verifier = Keypair.generate().publicKey;
  const reconciliationHash = Buffer.alloc(32, 7);
  const accountData = Buffer.concat([
    accountDiscriminator("ReconciliationRecord"),
    escrow.toBuffer(),
    agentRegistry.toBuffer(),
    encodeStringForTest("decode-task"),
    encodeU64ForTest(10_000_000n),
    mint.toBuffer(),
    beneficiary.toBuffer(),
    verifier.toBuffer(),
    encodeU64ForTest(3n),
    reconciliationHash,
    encodeU16ForTest(2),
    encodeStringForTest("ipfs://proof/decode-task"),
    Buffer.from([255]),
  ]);

  const address = Keypair.generate().publicKey;
  client.connection.getAccountInfo = (async () => ({
    data: accountData,
    executable: false,
    lamports: 1,
    owner: ACCURAL_PROGRAM_ID,
    rentEpoch: 0,
  })) as typeof client.connection.getAccountInfo;

  const decoded = await client.fetchReconciliationRecord(address);
  assert.equal(decoded.escrow.toBase58(), escrow.toBase58());
  assert.equal(decoded.agentRegistry.toBase58(), agentRegistry.toBase58());
  assert.equal(decoded.taskId, "decode-task");
  assert.equal(decoded.amount, 10_000_000n);
  assert.equal(decoded.mint.toBase58(), mint.toBase58());
  assert.equal(decoded.beneficiary.toBase58(), beneficiary.toBase58());
  assert.equal(decoded.verifier.toBase58(), verifier.toBase58());
  assert.equal(decoded.policyVersion, 3n);
  assert.equal(decoded.reconciliationHash.toString("hex"), reconciliationHash.toString("hex"));
  assert.equal(decoded.outcomeCode, 2);
  assert.equal(decoded.proofUri, "ipfs://proof/decode-task");
});

test("decodes agent reputation account data", async () => {
  const client = new AccuralSolanaClient();
  const agentRegistry = Keypair.generate().publicKey;
  const accountData = Buffer.concat([
    accountDiscriminator("AgentReputation"),
    agentRegistry.toBuffer(),
    encodeU64ForTest(3n),
    encodeU64ForTest(42_000_000n),
    Buffer.from([254]),
  ]);

  client.connection.getAccountInfo = (async () => ({
    data: accountData,
    executable: false,
    lamports: 1,
    owner: ACCURAL_PROGRAM_ID,
    rentEpoch: 0,
  })) as typeof client.connection.getAccountInfo;

  const decoded = await client.fetchAgentReputation(Keypair.generate().publicKey);
  assert.equal(decoded.agentRegistry.toBase58(), agentRegistry.toBase58());
  assert.equal(decoded.totalTasksCompleted, 3n);
  assert.equal(decoded.totalVolumeMinor, 42_000_000n);
});

test("reports Accural program deployment readiness", async () => {
  const client = new AccuralSolanaClient();
  client.connection.getAccountInfo = (async () => ({
    data: Buffer.from([1, 2, 3]),
    executable: true,
    lamports: 123,
    owner: SystemProgram.programId,
    rentEpoch: 0,
  })) as typeof client.connection.getAccountInfo;

  const status = await client.getProgramDeploymentStatus();
  assert.equal(status.programId, ACCURAL_PROGRAM_ID.toBase58());
  assert.equal(status.deployed, true);
  assert.equal(status.executable, true);
  assert.equal(status.owner, SystemProgram.programId.toBase58());
  assert.equal(status.lamports, 123);
  assert.equal(status.dataLength, 3);
  assert.equal((await client.assertProgramDeployed()).deployed, true);
});

test("rejects missing or non-executable Accural program deployment", async () => {
  const missing = new AccuralSolanaClient();
  missing.connection.getAccountInfo = (async () => null) as typeof missing.connection.getAccountInfo;
  await assert.rejects(
    () => missing.assertProgramDeployed(),
    /is not deployed/,
  );

  const nonExecutable = new AccuralSolanaClient();
  nonExecutable.connection.getAccountInfo = (async () => ({
    data: Buffer.from([1]),
    executable: false,
    lamports: 1,
    owner: SystemProgram.programId,
    rentEpoch: 0,
  })) as typeof nonExecutable.connection.getAccountInfo;
  await assert.rejects(
    () => nonExecutable.assertProgramDeployed(),
    /is not executable/,
  );
});

test("hashes reconciliation records canonically regardless of object key order", () => {
  const left = semanticReconciliationHash({
    taskId: "canonical",
    amount: "10",
    proofUri: "ipfs://proof/canonical",
  });
  const right = semanticReconciliationHash({
    proofUri: "ipfs://proof/canonical",
    amount: "10",
    taskId: "canonical",
  });

  assert.equal(left.toString("hex"), right.toString("hex"));
});

function encodeStringForTest(value: string) {
  const bytes = Buffer.from(value, "utf8");
  return Buffer.concat([encodeU32ForTest(bytes.length), bytes]);
}

function encodeU32ForTest(value: number) {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32LE(value);
  return buffer;
}

function encodeU16ForTest(value: number) {
  const buffer = Buffer.alloc(2);
  buffer.writeUInt16LE(value);
  return buffer;
}

function encodeU64ForTest(value: bigint) {
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64LE(value);
  return buffer;
}
