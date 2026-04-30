import { Keypair } from "@solana/web3.js";
import { AccuralRuntime } from "../protocol.js";
import {
  CampaignCoordinatorAgent,
  ArtifactVerifierAgent,
  SpecialistWorkerAgent,
} from "./agents.js";
import { OpenAiResponsesClient, type LlmClient } from "./llm.js";
import type { AgentMode, AgentRunResult, CampaignGoal } from "./types.js";

export type RunAgentDemoInput = {
  mode: AgentMode;
  goal?: Partial<CampaignGoal>;
  runtime?: AccuralRuntime;
  llm?: LlmClient;
  resetState?: boolean;
};

export async function runAgentDemo(input: RunAgentDemoInput): Promise<AgentRunResult> {
  const runtime = input.runtime ?? new AccuralRuntime();
  await runtime.initialize();
  if (input.resetState ?? true) {
    await runtime.resetDemoState();
  }

  const goal: CampaignGoal = {
    goal: input.goal?.goal ?? "Launch a micro-SaaS campaign landing page with a constrained budget.",
    budget: input.goal?.budget ?? "30",
    taskId: input.goal?.taskId ?? "landing-page-hero",
  };

  const llm = input.mode === "llm" ? input.llm ?? new OpenAiResponsesClient() : input.llm;

  const coordinator = new CampaignCoordinatorAgent(input.mode, llm);
  const worker = new SpecialistWorkerAgent(input.mode, llm);
  const verifier = new ArtifactVerifierAgent(input.mode, llm);

  const ownerPubkey = Keypair.generate().publicKey.toBase58();
  const workerPubkey = Keypair.generate().publicKey.toBase58();
  const verifierPubkey = Keypair.generate().publicKey.toBase58();

  const coordinatorIdentity = await runtime.createAgentWallet({
    agentId: coordinator.agentId,
    ownerPubkey,
  });
  const workerIdentity = await runtime.createAgentWallet({
    agentId: worker.agentId,
    ownerPubkey,
  });
  const verifierIdentity = await runtime.createAgentWallet({
    agentId: verifier.agentId,
    ownerPubkey,
  });

  const plan = normalizePlan(await coordinator.plan(goal), goal, coordinator.agentId);

  const policy = await runtime.setSpendPolicy({
    agentId: coordinator.agentId,
    maxPerTransaction: plan.maxPerTransaction,
    sessionBudget: plan.budget,
    approvalRequiredAbove: plan.approvalRequiredAbove,
  });

  const proposal = normalizeProposal(await worker.propose(plan, workerPubkey), worker.agentId);
  const paymentIntent = await runtime.requestPayment({
    requesterAgentId: coordinator.agentId,
    taskId: plan.taskId,
    amount: proposal.amount,
    recipientPubkey: workerPubkey,
    purpose: proposal.purpose,
  });

  const escrow = await runtime.createTaskEscrow({
    payerAgentId: coordinator.agentId,
    taskId: plan.taskId,
    amount: proposal.amount,
    purpose: proposal.purpose,
    beneficiaryPubkey: workerPubkey,
    verifierPubkey,
    paymentIntentId: String(paymentIntent.intentId),
  });

  const delivery = await worker.deliver(plan);
  const verification = await verifier.verify({ plan, delivery });
  if (!verification.approved) {
    throw new Error(`Verifier rejected work: ${verification.outcome}`);
  }

  const release = await runtime.releaseEscrow({
    taskId: plan.taskId,
    verifierPubkey,
    outcome: verification.outcome,
    proofUri: verification.proofUri,
  });

  const reconciliation = await runtime.reconcilePayment(plan.taskId);
  const finalBalance = await runtime.getBalance({ agentId: coordinator.agentId });

  return {
    mode: input.mode,
    settlementMode: "local-runtime",
    goal,
    plan,
    proposal,
    delivery,
    verification,
    accural: {
      coordinatorIdentity,
      workerIdentity,
      verifierIdentity,
      policy,
      paymentIntent,
      escrow,
      release,
      reconciliation,
      finalBalance,
    },
  };
}

function normalizePlan(plan: unknown, goal: CampaignGoal, fallbackAgentId: string) {
  const candidate = plan as Partial<CampaignGoal> & {
    agentId?: unknown;
    taskId?: unknown;
    budget?: unknown;
    maxPerTransaction?: unknown;
    approvalRequiredAbove?: unknown;
    taskBrief?: unknown;
  };

  return {
    agentId: stringOr(candidate.agentId, fallbackAgentId),
    taskId: stringOr(candidate.taskId, goal.taskId),
    budget: stringOr(candidate.budget, goal.budget),
    maxPerTransaction: stringOr(candidate.maxPerTransaction, "15"),
    approvalRequiredAbove: stringOr(candidate.approvalRequiredAbove, "12"),
    taskBrief: stringOr(candidate.taskBrief, goal.goal),
  };
}

function normalizeProposal(proposal: unknown, fallbackAgentId: string) {
  const candidate = proposal as {
    agentId?: unknown;
    amount?: unknown;
    purpose?: unknown;
  };

  return {
    agentId: stringOr(candidate.agentId, fallbackAgentId),
    amount: stringOr(candidate.amount, "10"),
    purpose: stringOr(candidate.purpose, "Complete delegated task."),
  };
}

function stringOr(value: unknown, fallback: string) {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}
