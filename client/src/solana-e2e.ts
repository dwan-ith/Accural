import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  createAccount,
  createMint,
  getAccount,
  getOrCreateAssociatedTokenAccount,
  mintTo,
} from "@solana/spl-token";

const PROGRAM_ID = new PublicKey("HTVTUMeyRkpbakNASCQ44MzgjxKjrV5oG8rBSavMiPCS");
const RPC_URL = process.env.ACCURAL_RPC_URL ?? "http://127.0.0.1:8899";
const USDC_DECIMALS = 6;

const ACTION_REQUEST_PAYMENT = 1 << 0;
const ACTION_CREATE_ESCROW = 1 << 1;
const ACTION_RELEASE_ESCROW = 1 << 2;

type DecodedPolicy = {
  agentRegistry: PublicKey;
  maxPerTransaction: bigint;
  sessionBudgetTotal: bigint;
  sessionBudgetRemaining: bigint;
  approvalRequiredAbove: bigint;
  allowedActions: number;
  version: bigint;
  bump: number;
};

type DecodedPaymentIntent = {
  agentRegistry: PublicKey;
  taskId: string;
  amount: bigint;
  mint: PublicKey;
  recipient: PublicKey;
  purpose: string;
  expiresAt: bigint;
  status: number;
  bump: number;
};

type DecodedEscrow = {
  agentRegistry: PublicKey;
  taskId: string;
  amount: bigint;
  mint: PublicKey;
  escrowTokenAccount: PublicKey;
  paymentIntent: PublicKey;
  beneficiary: PublicKey;
  verifier: PublicKey;
  policyVersion: bigint;
  status: number;
  bump: number;
};

type DecodedReputation = {
  agentRegistry: PublicKey;
  totalTasksCompleted: bigint;
  totalVolumeMinor: bigint;
  bump: number;
};

async function main() {
  const connection = new Connection(RPC_URL, "confirmed");
  await waitForValidator(connection);

  const owner = Keypair.generate();
  const verifier = Keypair.generate();
  const beneficiary = Keypair.generate();

  await airdrop(connection, owner.publicKey);
  await airdrop(connection, verifier.publicKey);

  const agentId = "jarvis";
  const taskId = "hero";
  const amount = 10_000_000n;
  const policyBudget = 30_000_000n;
  const purpose = "Escrow hero design";
  const proofUri = "ipfs://proof/hero";

  const mint = await createMint(connection, owner, owner.publicKey, null, USDC_DECIMALS);
  const ownerToken = await getOrCreateAssociatedTokenAccount(
    connection,
    owner,
    mint,
    owner.publicKey,
  );
  const beneficiaryToken = await getOrCreateAssociatedTokenAccount(
    connection,
    owner,
    mint,
    beneficiary.publicKey,
  );
  await mintTo(connection, owner, mint, ownerToken.address, owner, Number(policyBudget));

  const agentRegistry = pda(["registry", owner.publicKey, agentId]);
  const policyVault = pda(["policy", agentRegistry]);
  const agentReputation = pda(["reputation", agentRegistry]);
  const paymentIntent = pda(["payment_intent", agentRegistry, taskId]);
  const escrowAccount = pda(["escrow", agentRegistry, taskId]);
  const reconciliationRecord = pda(["reconciliation", escrowAccount]);
  const escrowTokenAccount = await createAccount(connection, owner, mint, escrowAccount);

  await sendIx(
    connection,
    initializeAgentIx({
      owner: owner.publicKey,
      agentRegistry,
      policyVault,
      agentReputation,
      agentId,
    }),
    [owner],
  );

  await sendIx(
    connection,
    setPolicyIx({
      owner: owner.publicKey,
      agentRegistry,
      policyVault,
      maxPerTransaction: 15_000_000n,
      sessionBudget: policyBudget,
      approvalRequiredAbove: 12_000_000n,
      allowedActions: ACTION_REQUEST_PAYMENT | ACTION_CREATE_ESCROW | ACTION_RELEASE_ESCROW,
    }),
    [owner],
  );

  const policyBefore = await fetchPolicy(connection, policyVault);
  assert.equal(policyBefore.sessionBudgetRemaining, policyBudget);
  assert.equal(policyBefore.allowedActions, 7);

  await sendIx(
    connection,
    requestPaymentIx({
      owner: owner.publicKey,
      agentRegistry,
      policyVault,
      paymentIntent,
      taskId,
      amount,
      mint,
      recipient: beneficiary.publicKey,
      purpose,
      expiresAt: BigInt(Math.floor(Date.now() / 1000) + 3600),
    }),
    [owner],
  );

  const intent = await fetchPaymentIntent(connection, paymentIntent);
  assert.equal(intent.taskId, taskId);
  assert.equal(intent.amount, amount);
  assert.equal(intent.recipient.toBase58(), beneficiary.publicKey.toBase58());
  assert.equal(intent.status, 0);

  await sendIx(
    connection,
    fundEscrowIx({
      owner: owner.publicKey,
      agentRegistry,
      policyVault,
      paymentIntent,
      escrowAccount,
      escrowTokenAccount,
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

  const escrow = await fetchEscrow(connection, escrowAccount);
  const escrowedIntent = await fetchPaymentIntent(connection, paymentIntent);
  assert.equal(escrow.taskId, taskId);
  assert.equal(escrow.amount, amount);
  assert.equal(escrow.beneficiary.toBase58(), beneficiary.publicKey.toBase58());
  assert.equal(escrow.verifier.toBase58(), verifier.publicKey.toBase58());
  assert.equal(escrow.status, 0);
  assert.equal(escrowedIntent.status, 1);

  const policyAfterFund = await fetchPolicy(connection, policyVault);
  assert.equal(policyAfterFund.sessionBudgetRemaining, policyBudget - amount);

  const escrowTokenState = await getAccount(connection, escrowTokenAccount);
  assert.equal(escrowTokenState.amount, amount);

  const reconciliationHash = createHash("sha256")
    .update(
      JSON.stringify({
        taskId,
        agentId,
        amount: amount.toString(),
        outcome: "accepted",
        proofUri,
      }),
    )
    .digest();

  await sendIx(
    connection,
    releaseEscrowIx({
      verifier: verifier.publicKey,
      policyVault,
      agentReputation,
      paymentIntent,
      escrowAccount,
      escrowTokenAccount,
      beneficiaryTokenAccount: beneficiaryToken.address,
      reconciliationRecord,
      reconciliationHash,
      outcomeCode: 0,
      proofUri,
    }),
    [verifier],
  );

  const releasedEscrow = await fetchEscrow(connection, escrowAccount);
  const paidIntent = await fetchPaymentIntent(connection, paymentIntent);
  assert.equal(releasedEscrow.status, 1);
  assert.equal(paidIntent.status, 2);

  const beneficiaryTokenState = await getAccount(connection, beneficiaryToken.address);
  assert.equal(beneficiaryTokenState.amount, amount);

  const reputation = await fetchReputation(connection, agentReputation);
  assert.equal(reputation.totalTasksCompleted, 1n);
  assert.equal(reputation.totalVolumeMinor, amount);

  const reconciliationInfo = await connection.getAccountInfo(reconciliationRecord, "confirmed");
  assert.ok(reconciliationInfo, "reconciliation account should exist");

  console.log(
    JSON.stringify(
      {
        status: "ok",
        rpcUrl: RPC_URL,
        programId: PROGRAM_ID.toBase58(),
        owner: owner.publicKey.toBase58(),
        agentRegistry: agentRegistry.toBase58(),
        policyVault: policyVault.toBase58(),
        paymentIntent: paymentIntent.toBase58(),
        escrowAccount: escrowAccount.toBase58(),
        escrowTokenAccount: escrowTokenAccount.toBase58(),
        beneficiaryTokenAccount: beneficiaryToken.address.toBase58(),
        reconciliationRecord: reconciliationRecord.toBase58(),
        amount: amount.toString(),
      },
      null,
      2,
    ),
  );
}

function initializeAgentIx(input: {
  owner: PublicKey;
  agentRegistry: PublicKey;
  policyVault: PublicKey;
  agentReputation: PublicKey;
  agentId: string;
}) {
  return ix("initialize_agent", encodeString(input.agentId), [
    meta(input.owner, true, true),
    meta(input.agentRegistry, false, true),
    meta(input.policyVault, false, true),
    meta(input.agentReputation, false, true),
    meta(SystemProgram.programId, false, false),
  ]);
}

function setPolicyIx(input: {
  owner: PublicKey;
  agentRegistry: PublicKey;
  policyVault: PublicKey;
  maxPerTransaction: bigint;
  sessionBudget: bigint;
  approvalRequiredAbove: bigint;
  allowedActions: number;
}) {
  return ix(
    "set_policy",
    Buffer.concat([
      encodeU64(input.maxPerTransaction),
      encodeU64(input.sessionBudget),
      encodeU64(input.approvalRequiredAbove),
      encodeU16(input.allowedActions),
    ]),
    [
      meta(input.owner, true, true),
      meta(input.agentRegistry, false, false),
      meta(input.policyVault, false, true),
    ],
  );
}

function requestPaymentIx(input: {
  owner: PublicKey;
  agentRegistry: PublicKey;
  policyVault: PublicKey;
  paymentIntent: PublicKey;
  taskId: string;
  amount: bigint;
  mint: PublicKey;
  recipient: PublicKey;
  purpose: string;
  expiresAt: bigint;
}) {
  return ix(
    "request_payment",
    Buffer.concat([
      encodeString(input.taskId),
      encodeU64(input.amount),
      input.mint.toBuffer(),
      input.recipient.toBuffer(),
      encodeString(input.purpose),
      encodeI64(input.expiresAt),
    ]),
    [
      meta(input.owner, true, true),
      meta(input.agentRegistry, false, false),
      meta(input.policyVault, false, false),
      meta(input.paymentIntent, false, true),
      meta(SystemProgram.programId, false, false),
    ],
  );
}

function fundEscrowIx(input: {
  owner: PublicKey;
  agentRegistry: PublicKey;
  policyVault: PublicKey;
  paymentIntent: PublicKey;
  escrowAccount: PublicKey;
  escrowTokenAccount: PublicKey;
  payerTokenAccount: PublicKey;
  mint: PublicKey;
  beneficiary: PublicKey;
  verifier: PublicKey;
  taskId: string;
  amount: bigint;
  purpose: string;
  humanApproved: boolean;
}) {
  return ix(
    "fund_escrow",
    Buffer.concat([
      encodeString(input.taskId),
      encodeU64(input.amount),
      encodeString(input.purpose),
      Buffer.from([input.humanApproved ? 1 : 0]),
    ]),
    [
      meta(input.owner, true, true),
      meta(input.agentRegistry, false, false),
      meta(input.policyVault, false, true),
      meta(input.paymentIntent, false, true),
      meta(input.escrowAccount, false, true),
      meta(input.escrowTokenAccount, false, true),
      meta(input.payerTokenAccount, false, true),
      meta(input.mint, false, false),
      meta(input.beneficiary, false, false),
      meta(input.verifier, false, false),
      meta(SystemProgram.programId, false, false),
      meta(TOKEN_PROGRAM_ID, false, false),
    ],
  );
}

function releaseEscrowIx(input: {
  verifier: PublicKey;
  policyVault: PublicKey;
  agentReputation: PublicKey;
  paymentIntent: PublicKey;
  escrowAccount: PublicKey;
  escrowTokenAccount: PublicKey;
  beneficiaryTokenAccount: PublicKey;
  reconciliationRecord: PublicKey;
  reconciliationHash: Buffer;
  outcomeCode: number;
  proofUri: string;
}) {
  return ix(
    "release_escrow",
    Buffer.concat([
      input.reconciliationHash.subarray(0, 32),
      encodeU16(input.outcomeCode),
      encodeString(input.proofUri),
    ]),
    [
      meta(input.verifier, true, true),
      meta(input.policyVault, false, false),
      meta(input.agentReputation, false, true),
      meta(input.paymentIntent, false, true),
      meta(input.escrowAccount, false, true),
      meta(input.escrowTokenAccount, false, true),
      meta(input.beneficiaryTokenAccount, false, true),
      meta(input.reconciliationRecord, false, true),
      meta(SystemProgram.programId, false, false),
      meta(TOKEN_PROGRAM_ID, false, false),
    ],
  );
}

async function fetchPolicy(connection: Connection, address: PublicKey): Promise<DecodedPolicy> {
  const data = await fetchAccountData(connection, address, "PolicyVault");
  const cursor = new Cursor(data.subarray(8));
  return {
    agentRegistry: cursor.pubkey(),
    maxPerTransaction: cursor.u64(),
    sessionBudgetTotal: cursor.u64(),
    sessionBudgetRemaining: cursor.u64(),
    approvalRequiredAbove: cursor.u64(),
    allowedActions: cursor.u16(),
    version: cursor.u64(),
    bump: cursor.u8(),
  };
}

async function fetchPaymentIntent(
  connection: Connection,
  address: PublicKey,
): Promise<DecodedPaymentIntent> {
  const data = await fetchAccountData(connection, address, "PaymentIntent");
  const cursor = new Cursor(data.subarray(8));
  return {
    agentRegistry: cursor.pubkey(),
    taskId: cursor.string(),
    amount: cursor.u64(),
    mint: cursor.pubkey(),
    recipient: cursor.pubkey(),
    purpose: cursor.string(),
    expiresAt: cursor.i64(),
    status: cursor.u8(),
    bump: cursor.u8(),
  };
}

async function fetchEscrow(connection: Connection, address: PublicKey): Promise<DecodedEscrow> {
  const data = await fetchAccountData(connection, address, "EscrowAccount");
  const cursor = new Cursor(data.subarray(8));
  return {
    agentRegistry: cursor.pubkey(),
    taskId: cursor.string(),
    amount: cursor.u64(),
    mint: cursor.pubkey(),
    escrowTokenAccount: cursor.pubkey(),
    paymentIntent: cursor.pubkey(),
    beneficiary: cursor.pubkey(),
    verifier: cursor.pubkey(),
    policyVersion: cursor.u64(),
    status: cursor.u8(),
    bump: cursor.u8(),
  };
}

async function fetchReputation(connection: Connection, address: PublicKey): Promise<DecodedReputation> {
  const data = await fetchAccountData(connection, address, "AgentReputation");
  const cursor = new Cursor(data.subarray(8));
  return {
    agentRegistry: cursor.pubkey(),
    totalTasksCompleted: cursor.u64(),
    totalVolumeMinor: cursor.u64(),
    bump: cursor.u8(),
  };
}

async function fetchAccountData(connection: Connection, address: PublicKey, name: string) {
  const account = await connection.getAccountInfo(address, "confirmed");
  assert.ok(account, `${name} account should exist`);
  const data = account.data;
  assert.deepEqual(
    Array.from(data.subarray(0, 8)),
    Array.from(accountDiscriminator(name)),
    `${name} discriminator mismatch`,
  );
  return data;
}

async function waitForValidator(connection: Connection) {
  const started = Date.now();
  while (Date.now() - started < 20_000) {
    try {
      await connection.getLatestBlockhash("confirmed");
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  throw new Error(`Local validator did not become ready at ${RPC_URL}`);
}

async function airdrop(connection: Connection, pubkey: PublicKey) {
  for (let i = 0; i < 10; i++) {
    try {
      console.log(`Attempting airdrop to ${pubkey.toBase58()} (attempt ${i + 1})`);
      const signature = await connection.requestAirdrop(pubkey, 1 * LAMPORTS_PER_SOL);
      const latest = await connection.getLatestBlockhash("confirmed");
      await connection.confirmTransaction({ signature, ...latest }, "confirmed");
      console.log(`Airdrop successful for ${pubkey.toBase58()}`);
      return;
    } catch (e) {
      console.log(`Airdrop failed: ${e}`);
      if (i === 9) throw e;
      await new Promise(r => setTimeout(r, 2000));
    }
  }
}

async function sendIx(connection: Connection, instruction: TransactionInstruction, signers: Keypair[]) {
  const tx = new Transaction().add(instruction);
  return sendAndConfirmTransaction(connection, tx, signers, { commitment: "confirmed" });
}

function ix(name: string, args: Buffer, keys: TransactionInstruction["keys"]) {
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys,
    data: Buffer.concat([instructionDiscriminator(name), args]),
  });
}

function meta(pubkey: PublicKey, isSigner: boolean, isWritable: boolean) {
  return { pubkey, isSigner, isWritable };
}

function pda(seeds: Array<string | PublicKey>) {
  return PublicKey.findProgramAddressSync(
    seeds.map((seed) => (typeof seed === "string" ? Buffer.from(seed) : seed.toBuffer())),
    PROGRAM_ID,
  )[0];
}

function instructionDiscriminator(name: string) {
  return createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);
}

function accountDiscriminator(name: string) {
  return createHash("sha256").update(`account:${name}`).digest().subarray(0, 8);
}

function encodeString(value: string) {
  const bytes = Buffer.from(value, "utf8");
  return Buffer.concat([encodeU32(bytes.length), bytes]);
}

function encodeU32(value: number) {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32LE(value);
  return buffer;
}

function encodeU16(value: number) {
  const buffer = Buffer.alloc(2);
  buffer.writeUInt16LE(value);
  return buffer;
}

function encodeU64(value: bigint) {
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64LE(value);
  return buffer;
}

function encodeI64(value: bigint) {
  const buffer = Buffer.alloc(8);
  buffer.writeBigInt64LE(value);
  return buffer;
}

class Cursor {
  private offset = 0;

  constructor(private readonly data: Buffer) {}

  u8() {
    return this.data.readUInt8(this.take(1));
  }

  u16() {
    return this.data.readUInt16LE(this.take(2));
  }

  u64() {
    return this.data.readBigUInt64LE(this.take(8));
  }

  i64() {
    return this.data.readBigInt64LE(this.take(8));
  }

  pubkey() {
    return new PublicKey(this.data.subarray(this.take(32), this.offset));
  }

  string() {
    const length = this.data.readUInt32LE(this.take(4));
    const start = this.take(length);
    return this.data.subarray(start, this.offset).toString("utf8");
  }

  private take(length: number) {
    const start = this.offset;
    this.offset += length;
    return start;
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
