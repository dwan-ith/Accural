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

export type AgentRunResult = {
  mode: AgentMode;
  settlementMode: "local-runtime";
  goal: CampaignGoal;
  plan: AssignmentPlan;
  proposal: WorkProposal;
  delivery: WorkDelivery;
  verification: VerificationDecision;
  accural: {
    coordinatorIdentity: unknown;
    workerIdentity: unknown;
    verifierIdentity: unknown;
    policy: unknown;
    paymentIntent: unknown;
    escrow: unknown;
    release: unknown;
    reconciliation: unknown;
    finalBalance: unknown;
  };
};
