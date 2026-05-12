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
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { solanaRpcUrl } from "../config.js";
import { canonicalJson } from "../money.js";

export const ACCURAL_PROGRAM_ID = new PublicKey("HTVTUMeyRkpbakNASCQ44MzgjxKjrV5oG8rBSavMiPCS");
export const ACTION_REQUEST_PAYMENT = 1 << 0;
export const ACTION_CREATE_ESCROW = 1 << 1;
export const ACTION_RELEASE_ESCROW = 1 << 2;
export const ACTION_DIRECT_PAYMENT = 1 << 3;
export const ACTION_ALL =
  ACTION_REQUEST_PAYMENT | ACTION_CREATE_ESCROW | ACTION_RELEASE_ESCROW;
export const ACTION_ALL_WITH_DIRECT_PAYMENT = ACTION_ALL | ACTION_DIRECT_PAYMENT;
export const MAX_AGENT_ID_LEN = 32;
export const MAX_TASK_ID_LEN = 32;
export const MAX_PURPOSE_LEN = 160;
export const MAX_PROOF_URI_LEN = 200;
export const MAX_SERVICE_TYPE_LEN = 32;
export const MAX_DESCRIPTION_LEN = 160;

export type AgentAddresses = {
  agentRegistry: PublicKey;
  policyVault: PublicKey;
  agentReputation: PublicKey;
};

export type TaskAddresses = {
  paymentIntent: PublicKey;
  escrowAccount: PublicKey;
  reconciliationRecord: PublicKey;
};

export type ServiceAddresses = {
  serviceListing: PublicKey;
};

export type DirectPaymentAddresses = {
  reconciliationRecord: PublicKey;
};

export type TokenAccountAddresses = {
  payerTokenAccount: PublicKey;
  escrowTokenAccount: PublicKey;
  beneficiaryTokenAccount: PublicKey;
};

export type DirectPaymentTokenAccountAddresses = {
  payerTokenAccount: PublicKey;
  recipientTokenAccount: PublicKey;
};

export type DecodedPolicy = {
  maxPerTransaction: bigint;
  sessionBudgetTotal: bigint;
  sessionBudgetRemaining: bigint;
  approvalRequiredAbove: bigint;
  allowedActions: number;
  version: bigint;
};

export type DecodedPaymentIntent = {
  taskId: string;
  amount: bigint;
  mint: PublicKey;
  recipient: PublicKey;
  purpose: string;
  expiresAt: bigint;
  status: number;
};

export type DecodedEscrow = {
  taskId: string;
  amount: bigint;
  mint: PublicKey;
  escrowTokenAccount: PublicKey;
  paymentIntent: PublicKey;
  beneficiary: PublicKey;
  verifier: PublicKey;
  policyVersion: bigint;
  status: number;
};

export type DecodedAgentReputation = {
  agentRegistry: PublicKey;
  totalTasksCompleted: bigint;
  totalVolumeMinor: bigint;
};

export type DecodedReconciliationRecord = {
  escrow: PublicKey;
  agentRegistry: PublicKey;
  taskId: string;
  amount: bigint;
  mint: PublicKey;
  beneficiary: PublicKey;
  verifier: PublicKey;
  policyVersion: bigint;
  reconciliationHash: Buffer;
  outcomeCode: number;
  proofUri: string;
};

export type InstructionPlan = {
  programId: string;
  dataBase64: string;
  keys: Array<{
    pubkey: string;
    isSigner: boolean;
    isWritable: boolean;
  }>;
};

export type TransactionBundlePlan = {
  bundleId: string;
  phases: Array<{
    phase: string;
    description: string;
    signerPubkeys: string[];
    instructions: InstructionPlan[];
  }>;
};

export type ProgramDeploymentStatus = {
  rpcUrl: string;
  programId: string;
  deployed: boolean;
  executable: boolean;
  owner?: string;
  lamports?: number;
  dataLength?: number;
};

export class AccuralSolanaClient {
  readonly connection: Connection;
  readonly programId: PublicKey;

  constructor(input: { rpcUrl?: string; connection?: Connection; programId?: PublicKey } = {}) {
    this.connection = input.connection ?? new Connection(solanaRpcUrl(input.rpcUrl), "confirmed");
    this.programId = input.programId ?? ACCURAL_PROGRAM_ID;
  }

  async getProgramDeploymentStatus(): Promise<ProgramDeploymentStatus> {
    const account = await this.connection.getAccountInfo(this.programId, "confirmed");
    const endpoint = this.connection.rpcEndpoint;
    return {
      rpcUrl: endpoint,
      programId: this.programId.toBase58(),
      deployed: Boolean(account),
      executable: Boolean(account?.executable),
      ...(account
        ? {
            owner: account.owner.toBase58(),
            lamports: account.lamports,
            dataLength: account.data.length,
          }
        : {}),
    };
  }

  async assertProgramDeployed() {
    const status = await this.getProgramDeploymentStatus();
    if (!status.deployed) {
      throw new Error(`Accural program ${status.programId} is not deployed on ${status.rpcUrl}.`);
    }
    if (!status.executable) {
      throw new Error(`Accural program ${status.programId} exists on ${status.rpcUrl} but is not executable.`);
    }
    return status;
  }

  deriveAgentAddresses(owner: PublicKey, agentId: string): AgentAddresses {
    validateAccuralIdentifier(agentId, MAX_AGENT_ID_LEN, "agentId");
    const agentRegistry = this.pda(["registry", owner, agentId]);
    return {
      agentRegistry,
      policyVault: this.pda(["policy", agentRegistry]),
      agentReputation: this.pda(["reputation", agentRegistry]),
    };
  }

  deriveTaskAddresses(agentRegistry: PublicKey, taskId: string): TaskAddresses {
    validateAccuralIdentifier(taskId, MAX_TASK_ID_LEN, "taskId");
    const escrowAccount = this.pda(["escrow", agentRegistry, taskId]);
    return {
      paymentIntent: this.pda(["payment_intent", agentRegistry, taskId]),
      escrowAccount,
      reconciliationRecord: this.pda(["reconciliation", escrowAccount]),
    };
  }

  deriveServiceAddresses(agentRegistry: PublicKey, serviceType: string): ServiceAddresses {
    validateAccuralIdentifier(serviceType, MAX_SERVICE_TYPE_LEN, "serviceType");
    return {
      serviceListing: this.pda(["service", agentRegistry, serviceType]),
    };
  }

  deriveDirectPaymentAddresses(agentRegistry: PublicKey, taskId: string): DirectPaymentAddresses {
    validateAccuralIdentifier(taskId, MAX_TASK_ID_LEN, "taskId");
    return {
      reconciliationRecord: this.pda(["reconciliation", agentRegistry, taskId]),
    };
  }

  deriveTokenAccounts(input: {
    owner: PublicKey;
    escrowAccount: PublicKey;
    beneficiary: PublicKey;
    mint: PublicKey;
  }): TokenAccountAddresses {
    return {
      payerTokenAccount: getAssociatedTokenAddressSync(input.mint, input.owner),
      escrowTokenAccount: getAssociatedTokenAddressSync(input.mint, input.escrowAccount, true),
      beneficiaryTokenAccount: getAssociatedTokenAddressSync(input.mint, input.beneficiary),
    };
  }

  createAssociatedTokenAccountIx(input: {
    payer: PublicKey;
    associatedTokenAccount: PublicKey;
    owner: PublicKey;
    mint: PublicKey;
  }) {
    return createAssociatedTokenAccountIdempotentInstruction(
      input.payer,
      input.associatedTokenAccount,
      input.owner,
      input.mint,
    );
  }

  initializeAgentIx(input: {
    owner: PublicKey;
    agentRegistry: PublicKey;
    policyVault: PublicKey;
    agentReputation: PublicKey;
    agentId: string;
  }) {
    validateAccuralIdentifier(input.agentId, MAX_AGENT_ID_LEN, "agentId");
    return this.ix("initialize_agent", encodeString(input.agentId), [
      meta(input.owner, true, true),
      meta(input.agentRegistry, false, true),
      meta(input.policyVault, false, true),
      meta(input.agentReputation, false, true),
      meta(SystemProgram.programId, false, false),
    ]);
  }

  deriveDirectPaymentTokenAccounts(input: {
    owner: PublicKey;
    recipient: PublicKey;
    mint: PublicKey;
  }): DirectPaymentTokenAccountAddresses {
    return {
      payerTokenAccount: getAssociatedTokenAddressSync(input.mint, input.owner),
      recipientTokenAccount: getAssociatedTokenAddressSync(input.mint, input.recipient),
    };
  }

  setPolicyIx(input: {
    owner: PublicKey;
    agentRegistry: PublicKey;
    policyVault: PublicKey;
    maxPerTransaction: bigint;
    sessionBudget: bigint;
    approvalRequiredAbove: bigint;
    allowedActions?: number;
  }) {
    return this.ix(
      "set_policy",
      Buffer.concat([
        encodeU64(input.maxPerTransaction),
        encodeU64(input.sessionBudget),
        encodeU64(input.approvalRequiredAbove),
        encodeU16(input.allowedActions ?? ACTION_ALL),
      ]),
      [
        meta(input.owner, true, true),
        meta(input.agentRegistry, false, false),
        meta(input.policyVault, false, true),
      ],
    );
  }

  registerServiceIx(input: {
    owner: PublicKey;
    agentRegistry: PublicKey;
    serviceListing: PublicKey;
    mint: PublicKey;
    serviceType: string;
    description: string;
    priceMinor: bigint;
  }) {
    validateAccuralIdentifier(input.serviceType, MAX_SERVICE_TYPE_LEN, "serviceType");
    validateAccuralText(input.description, MAX_DESCRIPTION_LEN, "description");
    return this.ix(
      "register_service",
      Buffer.concat([
        encodeString(input.serviceType),
        encodeString(input.description),
        encodeU64(input.priceMinor),
      ]),
      [
        meta(input.owner, true, true),
        meta(input.agentRegistry, false, false),
        meta(input.serviceListing, false, true),
        meta(input.mint, false, false),
        meta(SystemProgram.programId, false, false),
      ],
    );
  }

  deactivateServiceIx(input: {
    owner: PublicKey;
    agentRegistry: PublicKey;
    serviceListing: PublicKey;
  }) {
    return this.ix("deactivate_service", Buffer.alloc(0), [
      meta(input.owner, true, true),
      meta(input.agentRegistry, false, false),
      meta(input.serviceListing, false, true),
    ]);
  }

  requestPaymentIx(input: {
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
    validateAccuralIdentifier(input.taskId, MAX_TASK_ID_LEN, "taskId");
    validateAccuralText(input.purpose, MAX_PURPOSE_LEN, "purpose");
    return this.ix(
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

  fundEscrowIx(input: {
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
    validateAccuralIdentifier(input.taskId, MAX_TASK_ID_LEN, "taskId");
    validateAccuralText(input.purpose, MAX_PURPOSE_LEN, "purpose");
    return this.ix(
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

  cancelPaymentIntentIx(input: {
    owner: PublicKey;
    agentRegistry: PublicKey;
    paymentIntent: PublicKey;
  }) {
    return this.ix("cancel_payment_intent", Buffer.alloc(0), [
      meta(input.owner, true, true),
      meta(input.agentRegistry, false, false),
      meta(input.paymentIntent, false, true),
    ]);
  }

  refundEscrowIx(input: {
    owner: PublicKey;
    agentRegistry: PublicKey;
    paymentIntent: PublicKey;
    escrowAccount: PublicKey;
    escrowTokenAccount: PublicKey;
    payerTokenAccount: PublicKey;
  }) {
    return this.ix("refund_escrow", Buffer.alloc(0), [
      meta(input.owner, true, true),
      meta(input.agentRegistry, false, false),
      meta(input.paymentIntent, false, true),
      meta(input.escrowAccount, false, true),
      meta(input.escrowTokenAccount, false, true),
      meta(input.payerTokenAccount, false, true),
      meta(TOKEN_PROGRAM_ID, false, false),
    ]);
  }

  releaseEscrowIx(input: {
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
    validateAccuralText(input.proofUri, MAX_PROOF_URI_LEN, "proofUri");
    return this.ix(
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

  directPaymentIx(input: {
    owner: PublicKey;
    agentRegistry: PublicKey;
    policyVault: PublicKey;
    reconciliationRecord: PublicKey;
    payerTokenAccount: PublicKey;
    recipientTokenAccount: PublicKey;
    mint: PublicKey;
    recipient: PublicKey;
    taskId: string;
    amount: bigint;
    purpose: string;
    reconciliationHash: Buffer;
    proofUri: string;
  }) {
    validateAccuralIdentifier(input.taskId, MAX_TASK_ID_LEN, "taskId");
    validateAccuralText(input.purpose, MAX_PURPOSE_LEN, "purpose");
    validateAccuralText(input.proofUri, MAX_PROOF_URI_LEN, "proofUri");
    return this.ix(
      "direct_payment",
      Buffer.concat([
        encodeString(input.taskId),
        encodeU64(input.amount),
        encodeString(input.purpose),
        input.reconciliationHash.subarray(0, 32),
        encodeString(input.proofUri),
      ]),
      [
        meta(input.owner, true, true),
        meta(input.agentRegistry, false, false),
        meta(input.policyVault, false, true),
        meta(input.reconciliationRecord, false, true),
        meta(input.payerTokenAccount, false, true),
        meta(input.recipientTokenAccount, false, true),
        meta(input.mint, false, false),
        meta(input.recipient, false, false),
        meta(SystemProgram.programId, false, false),
        meta(TOKEN_PROGRAM_ID, false, false),
      ],
    );
  }

  async fetchPolicy(address: PublicKey): Promise<DecodedPolicy> {
    const data = await this.fetchAccountData(address, "PolicyVault");
    const cursor = new Cursor(data.subarray(8));
    cursor.pubkey();
    return {
      maxPerTransaction: cursor.u64(),
      sessionBudgetTotal: cursor.u64(),
      sessionBudgetRemaining: cursor.u64(),
      approvalRequiredAbove: cursor.u64(),
      allowedActions: cursor.u16(),
      version: cursor.u64(),
    };
  }

  async fetchPaymentIntent(address: PublicKey): Promise<DecodedPaymentIntent> {
    const data = await this.fetchAccountData(address, "PaymentIntent");
    const cursor = new Cursor(data.subarray(8));
    cursor.pubkey();
    return {
      taskId: cursor.string(),
      amount: cursor.u64(),
      mint: cursor.pubkey(),
      recipient: cursor.pubkey(),
      purpose: cursor.string(),
      expiresAt: cursor.i64(),
      status: cursor.u8(),
    };
  }

  async fetchEscrow(address: PublicKey): Promise<DecodedEscrow> {
    const data = await this.fetchAccountData(address, "EscrowAccount");
    const cursor = new Cursor(data.subarray(8));
    cursor.pubkey();
    return {
      taskId: cursor.string(),
      amount: cursor.u64(),
      mint: cursor.pubkey(),
      escrowTokenAccount: cursor.pubkey(),
      paymentIntent: cursor.pubkey(),
      beneficiary: cursor.pubkey(),
      verifier: cursor.pubkey(),
      policyVersion: cursor.u64(),
      status: cursor.u8(),
    };
  }

  async fetchAgentReputation(address: PublicKey): Promise<DecodedAgentReputation> {
    const data = await this.fetchAccountData(address, "AgentReputation");
    const cursor = new Cursor(data.subarray(8));
    return {
      agentRegistry: cursor.pubkey(),
      totalTasksCompleted: cursor.u64(),
      totalVolumeMinor: cursor.u64(),
    };
  }

  async fetchReconciliationRecord(address: PublicKey): Promise<DecodedReconciliationRecord> {
    const data = await this.fetchAccountData(address, "ReconciliationRecord");
    const cursor = new Cursor(data.subarray(8));
    return {
      escrow: cursor.pubkey(),
      agentRegistry: cursor.pubkey(),
      taskId: cursor.string(),
      amount: cursor.u64(),
      mint: cursor.pubkey(),
      beneficiary: cursor.pubkey(),
      verifier: cursor.pubkey(),
      policyVersion: cursor.u64(),
      reconciliationHash: cursor.bytes(32),
      outcomeCode: cursor.u16(),
      proofUri: cursor.string(),
    };
  }

  async fetchAccountData(address: PublicKey, accountName: string) {
    const account = await this.connection.getAccountInfo(address, "confirmed");
    assert.ok(account, `${accountName} account should exist`);
    const data = account.data;
    assert.deepEqual(
      Array.from(data.subarray(0, 8)),
      Array.from(accountDiscriminator(accountName)),
      `${accountName} discriminator mismatch`,
    );
    return data;
  }

  async waitForRpc(timeoutMs = 20_000) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      try {
        await this.connection.getLatestBlockhash("confirmed");
        return;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }
    throw new Error("Solana RPC did not become ready before timeout.");
  }

  async airdrop(pubkey: PublicKey, sol = 1) {
    const signature = await this.connection.requestAirdrop(pubkey, sol * LAMPORTS_PER_SOL);
    const latest = await this.connection.getLatestBlockhash("confirmed");
    await this.connection.confirmTransaction({ signature, ...latest }, "confirmed");
    return signature;
  }

  sendIx(instruction: TransactionInstruction, signers: Keypair[]) {
    const tx = new Transaction().add(instruction);
    return sendAndConfirmTransaction(this.connection, tx, signers, { commitment: "confirmed" });
  }

  instructionDiscriminator(name: string) {
    return instructionDiscriminator(name);
  }

  accountDiscriminator(name: string) {
    return accountDiscriminator(name);
  }

  instructionPlan(instruction: TransactionInstruction): InstructionPlan {
    return {
      programId: instruction.programId.toBase58(),
      dataBase64: Buffer.from(instruction.data).toString("base64"),
      keys: instruction.keys.map((key) => ({
        pubkey: key.pubkey.toBase58(),
        isSigner: key.isSigner,
        isWritable: key.isWritable,
      })),
    };
  }

  transactionBundlePlan(input: {
    bundleId: string;
    phases: Array<{
      phase: string;
      description: string;
      signerPubkeys: string[];
      instructions: TransactionInstruction[];
    }>;
  }): TransactionBundlePlan {
    return {
      bundleId: input.bundleId,
      phases: input.phases.map((phase) => ({
        phase: phase.phase,
        description: phase.description,
        signerPubkeys: Array.from(new Set(phase.signerPubkeys)),
        instructions: phase.instructions.map((instruction) => this.instructionPlan(instruction)),
      })),
    };
  }

  private ix(name: string, args: Buffer, keys: TransactionInstruction["keys"]) {
    return new TransactionInstruction({
      programId: this.programId,
      keys,
      data: Buffer.concat([instructionDiscriminator(name), args]),
    });
  }

  private pda(seeds: Array<string | PublicKey>) {
    return PublicKey.findProgramAddressSync(
      seeds.map((seed) => (typeof seed === "string" ? Buffer.from(seed) : seed.toBuffer())),
      this.programId,
    )[0];
  }
}

export function semanticReconciliationHash(value: unknown) {
  return createHash("sha256").update(canonicalJson(value)).digest();
}

export function instructionDiscriminator(name: string) {
  return createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);
}

export function accountDiscriminator(name: string) {
  return createHash("sha256").update(`account:${name}`).digest().subarray(0, 8);
}

export function validateAccuralIdentifier(value: string, maxBytes: number, name: string) {
  const bytes = Buffer.byteLength(value, "utf8");
  if (!value.trim() || bytes > maxBytes) {
    throw new Error(`${name} must be non-empty and at most ${maxBytes} UTF-8 bytes.`);
  }
}

export function validateAccuralText(value: string, maxBytes: number, name: string) {
  const bytes = Buffer.byteLength(value, "utf8");
  if (!value.trim() || bytes > maxBytes) {
    throw new Error(`${name} must be non-empty and at most ${maxBytes} UTF-8 bytes.`);
  }
}

function meta(pubkey: PublicKey, isSigner: boolean, isWritable: boolean) {
  return { pubkey, isSigner, isWritable };
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

  bytes(length: number) {
    const start = this.take(length);
    return this.data.subarray(start, this.offset);
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
