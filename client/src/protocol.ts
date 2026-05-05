import { Keypair, PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import type {
  AgentWalletResult,
  BalanceResult,
  DirectPaymentResult,
  EscrowResult,
  PaymentIntentResult,
  PolicyResult,
  ReconciliationEntry,
  ReleaseResult,
  ReputationResult,
  ServiceListingResult,
} from "./agents/types.js";
import {
  createEscrow,
  createPaymentIntent,
  getAgent,
  getAllRecords,
  getEscrowByTask,
  getEscrowsByAgent,
  getPaymentIntent,
  getPolicy,
  getRecordsByTask,
  initDb,
  insertReconciliationRecord,
  markEscrowReleased,
  resetDemoState,
  updatePaymentIntentStatus,
  upsertAgent,
  upsertPolicy,
  upsertReputation,
  getReputation,
  withTransaction,
  upsertService,
  listServices as dbListServices,
  type EscrowRecord,
  type PolicyRecord,
} from "./db.js";
import {
  DEFAULT_ASSET,
  formatUsdcAmount,
  makeId,
  parseUsdcAmount,
  semanticHash,
} from "./money.js";

const DEFAULT_ALLOWED_ACTIONS = ["request_payment", "create_task_escrow", "release_escrow"];

export type SetPolicyInput = {
  agentId: string;
  maxPerTransaction: string;
  sessionBudget: string;
  approvalRequiredAbove?: string;
  allowedActions?: string[];
  blockedRecipients?: string[];
};

export type RequestPaymentInput = {
  requesterAgentId: string;
  taskId: string;
  amount: string;
  recipientPubkey: string;
  purpose: string;
  expiresAt?: string;
};

export type CreateEscrowInput = {
  payerAgentId: string;
  taskId: string;
  amount: string;
  purpose: string;
  beneficiaryPubkey: string;
  verifierPubkey: string;
  paymentIntentId: string;
  humanApproved?: boolean;
};

export type ReleaseEscrowInput = {
  taskId: string;
  verifierPubkey: string;
  outcome: string;
  proofUri: string;
};

export type RegisterServiceInput = {
  agentId: string;
  serviceType: string;
  description: string;
  price: string;
};

export type DirectPaymentInput = {
  payerAgentId: string;
  taskId: string;
  amount: string;
  recipientPubkey: string;
  purpose: string;
  proofUri: string;
};

export class AccuralRuntime {
  private readonly sessionOwner: Keypair;

  constructor(owner?: Keypair) {
    if (owner) {
      this.sessionOwner = owner;
    } else if (process.env.ACCURAL_SESSION_OWNER) {
      this.sessionOwner = Keypair.fromSecretKey(bs58.decode(process.env.ACCURAL_SESSION_OWNER));
    } else {
      this.sessionOwner = Keypair.generate();
      console.warn("No ACCURAL_SESSION_OWNER provided. Generated ephemeral session owner:", this.sessionOwner.publicKey.toBase58());
    }
  }

  async initialize() {
    await initDb();
  }

  async resetDemoState() {
    await resetDemoState();
  }

  getSessionOwnerPubkey() {
    return this.sessionOwner.publicKey.toBase58();
  }

  async createAgentWallet(input: { agentId: string; ownerPubkey?: string }): Promise<AgentWalletResult> {
    assertId(input.agentId, "agentId");
    const ownerPubkey = input.ownerPubkey ?? this.getSessionOwnerPubkey();
    assertPubkey(ownerPubkey, "ownerPubkey");

    const agentWallet = Keypair.generate();
    const agent = await upsertAgent({
      agent_id: input.agentId,
      wallet_pubkey: agentWallet.publicKey.toBase58(),
      owner_pubkey: ownerPubkey,
    });

    await this.setSpendPolicy({
      agentId: input.agentId,
      maxPerTransaction: "0",
      sessionBudget: "0",
      approvalRequiredAbove: "0",
      allowedActions: DEFAULT_ALLOWED_ACTIONS,
    });

    return {
      agentId: agent?.agent_id,
      ownerPubkey,
      walletPubkey: agent?.wallet_pubkey,
      custodyModel:
        "Demo identity only. Production funds should live in PDA escrow/token accounts or delegated SPL authority, not in MCP-server custody.",
    };
  }

  async registerService(input: RegisterServiceInput): Promise<ServiceListingResult> {
    assertId(input.agentId, "agentId");
    assertId(input.serviceType, "serviceType");
    await requireAgent(input.agentId);

    const priceMinor = parseUsdcAmount(input.price);

    const service = await upsertService({
      service_type: input.serviceType,
      agent_id: input.agentId,
      description: input.description,
      price_minor: priceMinor.toString(),
      asset: "USDC",
      active: 1,
    });

    return {
      serviceType: service!.service_type,
      agentId: service!.agent_id,
      description: service!.description,
      price: formatUsdcAmount(BigInt(service!.price_minor)),
      asset: service!.asset,
      active: service!.active === 1,
    };
  }

  async listServices(input?: { serviceType?: string }): Promise<ServiceListingResult[]> {
    const services = await dbListServices(input?.serviceType);
    return services.map(service => ({
      serviceType: service.service_type,
      agentId: service.agent_id,
      description: service.description,
      price: formatUsdcAmount(BigInt(service.price_minor)),
      asset: service.asset,
      active: service.active === 1,
    }));
  }

  async getBalance(input: { agentId: string }): Promise<BalanceResult> {
    assertId(input.agentId, "agentId");
    const agent = await requireAgent(input.agentId);
    const policy = await requirePolicy(input.agentId);
    const escrows = await getEscrowsByAgent(input.agentId);
    const activeEscrowMinor = escrows
      .filter((escrow) => escrow.status === "FUNDED")
      .reduce((sum, escrow) => sum + BigInt(escrow.amount_minor), 0n);

    return {
      agentId: input.agentId,
      walletPubkey: agent.wallet_pubkey,
      asset: DEFAULT_ASSET,
      sessionBudget: formatUsdcAmount(policy.session_budget_total_minor),
      availableBudget: formatUsdcAmount(policy.session_budget_remaining_minor),
      activeEscrow: formatUsdcAmount(activeEscrowMinor),
      releasedSpend: formatUsdcAmount(
        BigInt(policy.session_budget_total_minor) -
          BigInt(policy.session_budget_remaining_minor) -
          activeEscrowMinor,
      ),
      policy: presentPolicy(policy),
    };
  }

  async getReputation(agentId: string): Promise<ReputationResult> {
    assertId(agentId, "agentId");
    const reputation = await getReputation(agentId);
    return {
      agentId,
      totalTasksCompleted: reputation?.total_tasks_completed ?? 0,
      totalVolume: reputation ? formatUsdcAmount(reputation.total_volume_minor) : "0.00",
      asset: DEFAULT_ASSET,
    };
  }

  async setSpendPolicy(input: SetPolicyInput): Promise<PolicyResult | undefined> {
    assertId(input.agentId, "agentId");
    await requireAgent(input.agentId);

    const maxPerTransaction = parseUsdcAmount(input.maxPerTransaction);
    const sessionBudget = parseUsdcAmount(input.sessionBudget);
    const approvalRequiredAbove = parseUsdcAmount(input.approvalRequiredAbove ?? input.maxPerTransaction);
    if (maxPerTransaction > sessionBudget && sessionBudget !== 0n) {
      throw new Error("maxPerTransaction cannot exceed the session budget.");
    }

    const allowedActions = input.allowedActions ?? DEFAULT_ALLOWED_ACTIONS;
    for (const action of allowedActions) {
      if (!DEFAULT_ALLOWED_ACTIONS.includes(action)) {
        throw new Error(`Unsupported policy action: ${action}`);
      }
    }

    const blockedRecipients = input.blockedRecipients ?? [];
    for (const recipient of blockedRecipients) {
      assertPubkey(recipient, "blockedRecipients");
    }

    const policy = await upsertPolicy({
      agent_id: input.agentId,
      max_per_transaction_minor: maxPerTransaction.toString(),
      session_budget_total_minor: sessionBudget.toString(),
      session_budget_remaining_minor: sessionBudget.toString(),
      approval_required_above_minor: approvalRequiredAbove.toString(),
      allowed_actions_json: JSON.stringify(allowedActions),
      blocked_recipients_json: JSON.stringify(blockedRecipients),
    });

    return presentPolicy(policy);
  }

  async requestPayment(input: RequestPaymentInput): Promise<PaymentIntentResult> {
    assertId(input.requesterAgentId, "requesterAgentId");
    assertId(input.taskId, "taskId");
    assertPubkey(input.recipientPubkey, "recipientPubkey");

    await requireAgent(input.requesterAgentId);
    const policy = await requirePolicy(input.requesterAgentId);
    requireAllowedAction(policy, "request_payment");
    requireRecipientAllowed(policy, input.recipientPubkey);

    const amountMinor = parseUsdcAmount(input.amount);
    const expiresAt = input.expiresAt ?? new Date(Date.now() + 15 * 60_000).toISOString();
    assertFutureDate(expiresAt, "expiresAt");

    const intent = await createPaymentIntent({
      intent_id: makeId("pi"),
      task_id: input.taskId,
      requester_agent_id: input.requesterAgentId,
      recipient_pubkey: input.recipientPubkey,
      amount_minor: amountMinor.toString(),
      asset: DEFAULT_ASSET,
      purpose: input.purpose,
      expires_at: expiresAt,
      status: "REQUESTED",
    });

    return {
      intentId: intent?.intent_id,
      type: "payment_request",
      taskId: input.taskId,
      requesterAgentId: input.requesterAgentId,
      recipientPubkey: input.recipientPubkey,
      amount: formatUsdcAmount(amountMinor),
      asset: DEFAULT_ASSET,
      purpose: input.purpose,
      expiresAt,
      status: intent?.status,
    };
  }

  async createTaskEscrow(input: CreateEscrowInput): Promise<EscrowResult> {
    assertId(input.payerAgentId, "payerAgentId");
    assertId(input.taskId, "taskId");
    assertPubkey(input.beneficiaryPubkey, "beneficiaryPubkey");
    assertPubkey(input.verifierPubkey, "verifierPubkey");
    if (!input.paymentIntentId.trim()) {
      throw new Error("paymentIntentId is required; escrows must be backed by a payment intent.");
    }

    const amountMinor = parseUsdcAmount(input.amount);

    return withTransaction(async () => {
      await requireAgent(input.payerAgentId);
      const policy = await requirePolicy(input.payerAgentId);
      requireAllowedAction(policy, "create_task_escrow");
      requireRecipientAllowed(policy, input.beneficiaryPubkey);
      enforcePolicy(policy, amountMinor, input.humanApproved === true);

      if (await getEscrowByTask(input.taskId)) {
        throw new Error(`An escrow already exists for task ${input.taskId}.`);
      }

      await this.validatePaymentIntent(input, amountMinor);

      const remaining = BigInt(policy.session_budget_remaining_minor) - amountMinor;
      const updatedPolicy = await upsertPolicy({
        agent_id: policy.agent_id,
        max_per_transaction_minor: policy.max_per_transaction_minor,
        session_budget_total_minor: policy.session_budget_total_minor,
        session_budget_remaining_minor: remaining.toString(),
        approval_required_above_minor: policy.approval_required_above_minor,
        allowed_actions_json: policy.allowed_actions_json,
        blocked_recipients_json: policy.blocked_recipients_json,
      });

      const escrow = await createEscrow({
        escrow_id: makeId("escrow"),
        task_id: input.taskId,
        payer_agent_id: input.payerAgentId,
        beneficiary_pubkey: input.beneficiaryPubkey,
        verifier_pubkey: input.verifierPubkey,
        amount_minor: amountMinor.toString(),
        asset: DEFAULT_ASSET,
        purpose: input.purpose,
        payment_intent_id: input.paymentIntentId,
        status: "FUNDED",
      });

      await updatePaymentIntentStatus(input.paymentIntentId, "ESCROWED");

      const reconciliation = await this.writeReconciliation({
        escrow: escrow!,
        policy: updatedPolicy!,
        eventType: "ESCROW_FUNDED",
        purpose: input.purpose,
        outcome: "Funds locked pending verifier release.",
        proofUri: null,
      });

      return {
        escrowId: escrow?.escrow_id,
        taskId: input.taskId,
        payerAgentId: input.payerAgentId,
        beneficiaryPubkey: input.beneficiaryPubkey,
        verifierPubkey: input.verifierPubkey,
        amount: formatUsdcAmount(amountMinor),
        asset: DEFAULT_ASSET,
        status: escrow?.status,
        policy: presentPolicy(updatedPolicy),
        reconciliation,
      };
    });
  }

  async releaseEscrow(input: ReleaseEscrowInput): Promise<ReleaseResult> {
    assertId(input.taskId, "taskId");
    assertPubkey(input.verifierPubkey, "verifierPubkey");
    if (!input.proofUri.trim()) {
      throw new Error("proofUri is required to preserve semantic reconciliation memory.");
    }

    return withTransaction(async () => {
      const escrow = await getEscrowByTask(input.taskId);
      if (!escrow) {
        throw new Error(`No escrow exists for task ${input.taskId}.`);
      }
      if (escrow.status !== "FUNDED") {
        throw new Error(`Escrow ${escrow.escrow_id} is not releasable; current status is ${escrow.status}.`);
      }
      if (escrow.verifier_pubkey !== input.verifierPubkey) {
        throw new Error("Only the escrow verifier can release this task escrow.");
      }
      if (!escrow.payment_intent_id) {
        throw new Error("Escrow is missing its backing payment intent.");
      }

      const policy = await requirePolicy(escrow.payer_agent_id);
      requireAllowedAction(policy, "release_escrow");
      const releasedEscrow = await markEscrowReleased(escrow.escrow_id);
      await updatePaymentIntentStatus(escrow.payment_intent_id, "PAID");
      await upsertReputation(escrow.payer_agent_id, 1, BigInt(escrow.amount_minor));

      const reconciliation = await this.writeReconciliation({
        escrow: releasedEscrow!,
        policy,
        eventType: "ESCROW_RELEASED",
        purpose: "Release escrow after task verification.",
        outcome: input.outcome,
        proofUri: input.proofUri,
      });

      return {
        escrowId: releasedEscrow?.escrow_id,
        taskId: input.taskId,
        beneficiaryPubkey: releasedEscrow?.beneficiary_pubkey,
        amount: formatUsdcAmount(releasedEscrow!.amount_minor),
        asset: releasedEscrow?.asset,
        status: releasedEscrow?.status,
        reconciliation,
      };
    });
  }

  async directPayment(input: DirectPaymentInput): Promise<DirectPaymentResult> {
    assertId(input.payerAgentId, "payerAgentId");
    assertId(input.taskId, "taskId");
    assertPubkey(input.recipientPubkey, "recipientPubkey");
    if (!input.proofUri.trim()) {
      throw new Error("proofUri is required to preserve semantic reconciliation memory.");
    }

    const amountMinor = parseUsdcAmount(input.amount);

    return withTransaction(async () => {
      await requireAgent(input.payerAgentId);
      const policy = await requirePolicy(input.payerAgentId);
      requireAllowedAction(policy, "direct_payment");
      requireRecipientAllowed(policy, input.recipientPubkey);
      enforcePolicy(policy, amountMinor, true); // Assuming direct payments are explicitly requested

      const remaining = BigInt(policy.session_budget_remaining_minor) - amountMinor;
      const updatedPolicy = await upsertPolicy({
        agent_id: policy.agent_id,
        max_per_transaction_minor: policy.max_per_transaction_minor,
        session_budget_total_minor: policy.session_budget_total_minor,
        session_budget_remaining_minor: remaining.toString(),
        approval_required_above_minor: policy.approval_required_above_minor,
        allowed_actions_json: policy.allowed_actions_json,
        blocked_recipients_json: policy.blocked_recipients_json,
      });
      await upsertReputation(input.payerAgentId, 1, amountMinor);

      const reconciliation = await this.writeDirectPaymentReconciliation({
        taskId: input.taskId,
        payerAgentId: input.payerAgentId,
        amountMinor,
        policy: updatedPolicy!,
        eventType: "DIRECT_PAYMENT",
        purpose: input.purpose,
        outcome: "Direct payment made to recipient.",
        proofUri: input.proofUri,
      });

      return {
        taskId: input.taskId,
        payerAgentId: input.payerAgentId,
        recipientPubkey: input.recipientPubkey,
        amount: formatUsdcAmount(amountMinor),
        asset: DEFAULT_ASSET,
        purpose: input.purpose,
        reconciliation,
      };
    });
  }

  async reconcilePayment(taskId?: string): Promise<ReconciliationEntry[]> {
    if (taskId) {
      assertId(taskId, "taskId");
    }
    const records = taskId ? await getRecordsByTask(taskId) : await getAllRecords();
    return records.map((record) => ({
      recordId: record.record_id,
      transactionSignature: record.transaction_signature,
      taskId: record.task_id,
      agentId: record.agent_id,
      eventType: record.event_type,
      amount: formatUsdcAmount(record.amount_minor),
      asset: record.asset,
      purpose: record.purpose,
      outcome: record.outcome,
      proofUri: record.proof_uri,
      semanticHash: record.semantic_hash,
      policySnapshot: JSON.parse(record.policy_snapshot_json) as unknown,
      createdAt: record.created_at,
    }));
  }

  private async validatePaymentIntent(input: CreateEscrowInput, amountMinor: bigint) {
    const intent = await getPaymentIntent(input.paymentIntentId);
    if (!intent) {
      throw new Error(`Payment intent ${input.paymentIntentId} does not exist.`);
    }
    if (intent.status !== "REQUESTED") {
      throw new Error(`Payment intent ${intent.intent_id} is ${intent.status}, not REQUESTED.`);
    }
    if (new Date(intent.expires_at).getTime() <= Date.now()) {
      await updatePaymentIntentStatus(intent.intent_id, "EXPIRED");
      throw new Error(`Payment intent ${intent.intent_id} has expired.`);
    }
    if (intent.task_id !== input.taskId) {
      throw new Error("Payment intent taskId does not match escrow taskId.");
    }
    if (intent.requester_agent_id !== input.payerAgentId) {
      throw new Error("Payment intent requester does not match escrow payer agent.");
    }
    if (intent.recipient_pubkey !== input.beneficiaryPubkey) {
      throw new Error("Payment intent recipient does not match escrow beneficiary.");
    }
    if (BigInt(intent.amount_minor) !== amountMinor) {
      throw new Error("Payment intent amount does not match escrow amount.");
    }
    if (intent.purpose !== input.purpose) {
      throw new Error("Payment intent purpose does not match escrow purpose.");
    }
  }

  private async writeReconciliation(input: {
    escrow: EscrowRecord;
    policy: PolicyRecord;
    eventType: string;
    purpose: string;
    outcome: string;
    proofUri: string | null;
  }) {
    const recordId = makeId("rec");
    const transactionSignature = `local_${input.eventType.toLowerCase()}_${recordId}`;
    const policySnapshot = presentPolicy(input.policy);
    const semanticPayload = {
      recordId,
      transactionSignature,
      taskId: input.escrow.task_id,
      agentId: input.escrow.payer_agent_id,
      eventType: input.eventType,
      amountMinor: input.escrow.amount_minor,
      asset: input.escrow.asset,
      purpose: input.purpose,
      outcome: input.outcome,
      proofUri: input.proofUri,
      policySnapshot,
    };

    const record = await insertReconciliationRecord({
      record_id: recordId,
      transaction_signature: transactionSignature,
      task_id: input.escrow.task_id,
      agent_id: input.escrow.payer_agent_id,
      event_type: input.eventType,
      amount_minor: input.escrow.amount_minor,
      asset: input.escrow.asset,
      purpose: input.purpose,
      outcome: input.outcome,
      proof_uri: input.proofUri,
      policy_snapshot_json: JSON.stringify(policySnapshot),
      semantic_hash: semanticHash(semanticPayload),
    });

    return {
      recordId: record?.record_id,
      transactionSignature: record?.transaction_signature,
      semanticHash: record?.semantic_hash,
    };
  }

  private async writeDirectPaymentReconciliation(input: {
    taskId: string;
    payerAgentId: string;
    amountMinor: string;
    policy: PolicyRecord;
    eventType: string;
    purpose: string;
    outcome: string;
    proofUri: string | null;
  }) {
    const recordId = makeId("rec");
    const transactionSignature = `local_${input.eventType.toLowerCase()}_${recordId}`;
    const policySnapshot = presentPolicy(input.policy);
    const semanticPayload = {
      recordId,
      transactionSignature,
      taskId: input.taskId,
      agentId: input.payerAgentId,
      eventType: input.eventType,
      amountMinor: input.amountMinor,
      asset: DEFAULT_ASSET,
      purpose: input.purpose,
      outcome: input.outcome,
      proofUri: input.proofUri,
      policySnapshot,
    };

    const record = await insertReconciliationRecord({
      record_id: recordId,
      transaction_signature: transactionSignature,
      task_id: input.taskId,
      agent_id: input.payerAgentId,
      event_type: input.eventType,
      amount_minor: input.amountMinor,
      asset: DEFAULT_ASSET,
      purpose: input.purpose,
      outcome: input.outcome,
      proof_uri: input.proofUri,
      policy_snapshot_json: JSON.stringify(policySnapshot),
      semantic_hash: semanticHash(semanticPayload),
    });

    return {
      recordId: record?.record_id,
      transactionSignature: record?.transaction_signature,
      semanticHash: record?.semantic_hash,
    };
  }
}

function presentPolicy(policy: PolicyRecord | undefined) {
  if (!policy) {
    return undefined;
  }

  return {
    agentId: policy.agent_id,
    maxPerTransaction: formatUsdcAmount(policy.max_per_transaction_minor),
    sessionBudget: formatUsdcAmount(policy.session_budget_total_minor),
    sessionBudgetRemaining: formatUsdcAmount(policy.session_budget_remaining_minor),
    approvalRequiredAbove: formatUsdcAmount(policy.approval_required_above_minor),
    allowedActions: JSON.parse(policy.allowed_actions_json) as string[],
    blockedRecipients: JSON.parse(policy.blocked_recipients_json) as string[],
    version: policy.version,
  };
}

async function requireAgent(agentId: string) {
  const agent = await getAgent(agentId);
  if (!agent) {
    throw new Error(`Agent ${agentId} has not been created.`);
  }
  return agent;
}

async function requirePolicy(agentId: string) {
  const policy = await getPolicy(agentId);
  if (!policy) {
    throw new Error(`Agent ${agentId} does not have a spend policy.`);
  }
  return policy;
}

function enforcePolicy(policy: PolicyRecord, amountMinor: bigint, humanApproved: boolean) {
  if (amountMinor <= 0n) {
    throw new Error("Escrow amount must be greater than zero.");
  }
  if (amountMinor > BigInt(policy.max_per_transaction_minor)) {
    throw new Error("Amount exceeds the max_per_transaction policy.");
  }
  if (amountMinor > BigInt(policy.session_budget_remaining_minor)) {
    throw new Error("Amount exceeds the remaining session budget.");
  }
  if (amountMinor > BigInt(policy.approval_required_above_minor) && !humanApproved) {
    throw new Error("Amount requires human approval under the current policy.");
  }
}

function requireAllowedAction(policy: PolicyRecord, action: string) {
  const allowedActions = JSON.parse(policy.allowed_actions_json) as string[];
  if (!allowedActions.includes(action)) {
    throw new Error(`Policy does not allow ${action}.`);
  }
}

function requireRecipientAllowed(policy: PolicyRecord, recipient: string) {
  const blockedRecipients = JSON.parse(policy.blocked_recipients_json) as string[];
  if (blockedRecipients.includes(recipient)) {
    throw new Error("Recipient is blocked by policy.");
  }
}

function assertId(value: string, fieldName: string) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,31}$/.test(value)) {
    throw new Error(`${fieldName} must be 1-32 characters: letters, numbers, dot, underscore, or hyphen.`);
  }
}

function assertPubkey(value: string, fieldName: string) {
  try {
    new PublicKey(value);
  } catch {
    throw new Error(`${fieldName} must be a valid Solana public key.`);
  }
}

function assertFutureDate(value: string, fieldName: string) {
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) {
    throw new Error(`${fieldName} must be an ISO timestamp.`);
  }
  if (timestamp <= Date.now()) {
    throw new Error(`${fieldName} must be in the future.`);
  }
}
