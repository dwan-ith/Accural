export type AgentMode = "deterministic" | "llm";

export type CampaignGoal = {
  goal: string;
  budget: string;
  taskId: string;
};

export type AssignmentPlan = {
  agentId: string;
  taskId: string;
  budget: string;
  maxPerTransaction: string;
  approvalRequiredAbove: string;
  taskBrief: string;
};

export type WorkProposal = {
  agentId: string;
  amount: string;
  purpose: string;
};

export type WorkDelivery = {
  artifactUri: string;
  summary: string;
};

export type VerificationDecision = {
  approved: boolean;
  outcome: string;
  proofUri: string;
};

export type AgentWalletResult = {
  agentId: string | undefined;
  ownerPubkey: string;
  walletPubkey: string | undefined;
  custodyModel: string;
};

export type ServiceListingResult = {
  serviceType: string;
  agentId: string;
  description: string;
  price: string;
  asset: string;
  active: boolean;
};

export type PolicyResult = {
  agentId: string;
  maxPerTransaction: string;
  sessionBudget: string;
  sessionBudgetRemaining: string;
  approvalRequiredAbove: string;
  allowedActions: string[];
  blockedRecipients: string[];
  version: number;
};

export type PaymentIntentResult = {
  intentId: string | undefined;
  type: string;
  taskId: string;
  requesterAgentId: string;
  recipientPubkey: string;
  amount: string;
  asset: string;
  purpose: string;
  expiresAt: string;
  status: string | undefined;
};

export type EscrowResult = {
  escrowId: string | undefined;
  taskId: string;
  payerAgentId: string;
  beneficiaryPubkey: string;
  verifierPubkey: string;
  amount: string;
  asset: string;
  status: string | undefined;
  policy: PolicyResult | undefined;
  reconciliation: ReconciliationRef;
};

export type ReleaseResult = {
  escrowId: string | undefined;
  taskId: string;
  beneficiaryPubkey: string | undefined;
  amount: string;
  asset: string | undefined;
  status: string | undefined;
  reconciliation: ReconciliationRef;
};

export type ReconciliationRef = {
  recordId: string | undefined;
  transactionSignature: string | undefined;
  semanticHash: string | undefined;
};

export type ReconciliationEntry = {
  recordId: string | undefined;
  transactionSignature: string | undefined;
  taskId: string;
  agentId: string;
  eventType: string;
  amount: string;
  asset: string;
  purpose: string;
  outcome: string;
  proofUri: string | null;
  semanticHash: string | undefined;
  policySnapshot: unknown;
  createdAt: string;
};

export type BalanceResult = {
  agentId: string;
  walletPubkey: string;
  asset: string;
  sessionBudget: string;
  availableBudget: string;
  activeEscrow: string;
  releasedSpend: string;
  policy: PolicyResult | undefined;
};

export type DirectPaymentResult = {
  taskId: string;
  payerAgentId: string;
  recipientPubkey: string;
  amount: string;
  asset: string;
  purpose: string;
  reconciliation: ReconciliationRef;
};

export type ReputationResult = {
  agentId: string;
  totalTasksCompleted: number;
  totalVolume: string;
  asset: string;
};

export type AgentRunResult = {
  mode: AgentMode;
  settlementMode: "local-runtime";
  goal: CampaignGoal;
  plan: AssignmentPlan;
  proposal: WorkProposal;
  delivery: WorkDelivery;
  verification: VerificationDecision;
  accural: {
    coordinatorIdentity: AgentWalletResult;
    workerIdentity: AgentWalletResult;
    verifierIdentity: AgentWalletResult;
    policy: PolicyResult | undefined;
    paymentIntent: PaymentIntentResult;
    escrow: EscrowResult;
    release: ReleaseResult;
    reconciliation: ReconciliationEntry[];
    finalBalance: BalanceResult;
  };
};
