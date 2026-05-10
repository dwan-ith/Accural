import { Keypair, PublicKey } from "@solana/web3.js";
import { parseUsdcAmount } from "../money.js";
import { AccuralRuntime } from "../protocol.js";
import {
  ACTION_ALL,
  AccuralSolanaClient,
  semanticReconciliationHash,
  type InstructionPlan,
} from "../solana/accural-client.js";
import {
  CampaignCoordinatorAgent,
  ArtifactVerifierAgent,
  SpecialistWorkerAgent,
} from "./agents.js";
import { OpenAiResponsesClient, type LlmClient } from "./llm.js";
import type { AgentMode, AgentRunResult, AgentSolanaPlanResult, CampaignGoal } from "./types.js";

export type RunAgentDemoInput = {
  mode: AgentMode;
  goal?: Partial<CampaignGoal>;
  runtime?: AccuralRuntime;
  llm?: LlmClient;
  resetState?: boolean;
};

export type RunAgentSolanaPlanInput = {
  mode: AgentMode;
  goal?: Partial<CampaignGoal>;
  llm?: LlmClient;
  solanaClient?: AccuralSolanaClient;
  ownerPubkey?: string;
  workerPubkey?: string;
  verifierPubkey?: string;
  mint?: string;
  payerTokenAccount?: string;
  escrowTokenAccount?: string;
  beneficiaryTokenAccount?: string;
  expiresAt?: bigint;
  humanApproved?: boolean;
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

export async function runAgentSolanaPlan(
  input: RunAgentSolanaPlanInput,
): Promise<AgentSolanaPlanResult> {
  const goal = defaultGoal(input.goal);
  const llm = input.mode === "llm" ? input.llm ?? new OpenAiResponsesClient() : input.llm;
  const coordinator = new CampaignCoordinatorAgent(input.mode, llm);
  const worker = new SpecialistWorkerAgent(input.mode, llm);
  const verifier = new ArtifactVerifierAgent(input.mode, llm);
  const client = input.solanaClient ?? new AccuralSolanaClient();

  const owner = parsePubkey(input.ownerPubkey ?? randomPubkey(), "ownerPubkey");
  const workerPubkey = parsePubkey(input.workerPubkey ?? randomPubkey(), "workerPubkey");
  const verifierPubkey = parsePubkey(input.verifierPubkey ?? randomPubkey(), "verifierPubkey");
  const mint = parsePubkey(input.mint ?? randomPubkey(), "mint");

  const plan = normalizePlan(await coordinator.plan(goal), goal, coordinator.agentId);
  const proposal = normalizeProposal(await worker.propose(plan, workerPubkey.toBase58()), worker.agentId);
  const amount = parseUsdcAmount(proposal.amount);
  const maxPerTransaction = parseUsdcAmount(plan.maxPerTransaction);
  const sessionBudget = parseUsdcAmount(plan.budget);
  const approvalRequiredAbove = parseUsdcAmount(plan.approvalRequiredAbove);
  validateSolanaSpendPlan({
    amount,
    maxPerTransaction,
    sessionBudget,
    approvalRequiredAbove,
    humanApproved: input.humanApproved ?? false,
  });

  const delivery = await worker.deliver(plan);
  const verification = await verifier.verify({ plan, delivery });
  if (!verification.approved) {
    throw new Error(`Verifier rejected work: ${verification.outcome}`);
  }

  const agent = client.deriveAgentAddresses(owner, coordinator.agentId);
  const task = client.deriveTaskAddresses(agent.agentRegistry, plan.taskId);
  const defaultTokenAccounts = client.deriveTokenAccounts({
    owner,
    escrowAccount: task.escrowAccount,
    beneficiary: workerPubkey,
    mint,
  });
  const payerTokenAccount = parsePubkey(
    input.payerTokenAccount ?? defaultTokenAccounts.payerTokenAccount.toBase58(),
    "payerTokenAccount",
  );
  const escrowTokenAccount = parsePubkey(
    input.escrowTokenAccount ?? defaultTokenAccounts.escrowTokenAccount.toBase58(),
    "escrowTokenAccount",
  );
  const beneficiaryTokenAccount = parsePubkey(
    input.beneficiaryTokenAccount ?? defaultTokenAccounts.beneficiaryTokenAccount.toBase58(),
    "beneficiaryTokenAccount",
  );
  const expiresAt = input.expiresAt ?? BigInt(Math.floor(Date.now() / 1000) + 15 * 60);
  const reconciliationHash = semanticReconciliationHash({
    agentId: coordinator.agentId,
    taskId: plan.taskId,
    amount: proposal.amount,
    beneficiaryPubkey: workerPubkey.toBase58(),
    outcome: verification.outcome,
    proofUri: verification.proofUri,
  });

  const initializeAgent = client.initializeAgentIx({
    owner,
    agentRegistry: agent.agentRegistry,
    policyVault: agent.policyVault,
    agentReputation: agent.agentReputation,
    agentId: coordinator.agentId,
  });
  const setPolicy = client.setPolicyIx({
    owner,
    agentRegistry: agent.agentRegistry,
    policyVault: agent.policyVault,
    maxPerTransaction,
    sessionBudget,
    approvalRequiredAbove,
    allowedActions: ACTION_ALL,
  });
  const requestPayment = client.requestPaymentIx({
    owner,
    agentRegistry: agent.agentRegistry,
    policyVault: agent.policyVault,
    paymentIntent: task.paymentIntent,
    taskId: plan.taskId,
    amount,
    mint,
    recipient: workerPubkey,
    purpose: proposal.purpose,
    expiresAt,
  });
  const setupPayerTokenAccount = maybeAtaSetup(
    client,
    owner,
    owner,
    mint,
    payerTokenAccount,
    defaultTokenAccounts.payerTokenAccount,
  );
  const setupEscrowTokenAccount = maybeAtaSetup(
    client,
    owner,
    task.escrowAccount,
    mint,
    escrowTokenAccount,
    defaultTokenAccounts.escrowTokenAccount,
  );
  const setupBeneficiaryTokenAccount = maybeAtaSetup(
    client,
    owner,
    workerPubkey,
    mint,
    beneficiaryTokenAccount,
    defaultTokenAccounts.beneficiaryTokenAccount,
  );
  const fundEscrow = client.fundEscrowIx({
    owner,
    agentRegistry: agent.agentRegistry,
    policyVault: agent.policyVault,
    paymentIntent: task.paymentIntent,
    escrowAccount: task.escrowAccount,
    escrowTokenAccount,
    payerTokenAccount,
    mint,
    beneficiary: workerPubkey,
    verifier: verifierPubkey,
    taskId: plan.taskId,
    amount,
    purpose: proposal.purpose,
    humanApproved: input.humanApproved ?? false,
  });
  const releaseEscrow = client.releaseEscrowIx({
    verifier: verifierPubkey,
    policyVault: agent.policyVault,
    agentReputation: agent.agentReputation,
    paymentIntent: task.paymentIntent,
    escrowAccount: task.escrowAccount,
    escrowTokenAccount,
    beneficiaryTokenAccount,
    reconciliationRecord: task.reconciliationRecord,
    reconciliationHash,
    outcomeCode: 0,
    proofUri: verification.proofUri,
  });
  const setupInstructions = [
    setupPayerTokenAccount,
    setupEscrowTokenAccount,
    setupBeneficiaryTokenAccount,
  ].filter((instruction) => instruction !== undefined);
  const transactionBundle = client.transactionBundlePlan({
    bundleId: `accural:${coordinator.agentId}:${plan.taskId}`,
    phases: [
      ...(setupInstructions.length > 0
        ? [
            {
              phase: "setup-token-accounts",
              description: "Idempotently create payer, escrow PDA, and beneficiary associated token accounts.",
              signerPubkeys: [owner.toBase58()],
              instructions: setupInstructions,
            },
          ]
        : []),
      {
        phase: "initialize-agent-policy",
        description: "Create the agent registry and policy vault, then set spend limits.",
        signerPubkeys: [owner.toBase58()],
        instructions: [initializeAgent, setPolicy],
      },
      {
        phase: "request-and-fund-escrow",
        description: "Create the payment intent and fund task escrow under on-chain policy checks.",
        signerPubkeys: [owner.toBase58()],
        instructions: [requestPayment, fundEscrow],
      },
      {
        phase: "release-escrow",
        description: "Release escrow only after verifier approval and anchor the reconciliation hash.",
        signerPubkeys: [verifierPubkey.toBase58()],
        instructions: [releaseEscrow],
      },
    ],
  });

  return {
    mode: input.mode,
    settlementMode: "solana-plan",
    goal,
    plan,
    proposal,
    delivery,
    verification,
    solana: {
      participants: {
        ownerPubkey: owner.toBase58(),
        workerPubkey: workerPubkey.toBase58(),
        verifierPubkey: verifierPubkey.toBase58(),
        mint: mint.toBase58(),
        payerTokenAccount: payerTokenAccount.toBase58(),
        escrowTokenAccount: escrowTokenAccount.toBase58(),
        beneficiaryTokenAccount: beneficiaryTokenAccount.toBase58(),
      },
      addresses: {
        agentRegistry: agent.agentRegistry.toBase58(),
        policyVault: agent.policyVault.toBase58(),
        agentReputation: agent.agentReputation.toBase58(),
        paymentIntent: task.paymentIntent.toBase58(),
        escrowAccount: task.escrowAccount.toBase58(),
        reconciliationRecord: task.reconciliationRecord.toBase58(),
      },
      instructions: {
        ...(setupPayerTokenAccount ? { setupPayerTokenAccount: signedPlan(client, setupPayerTokenAccount, owner) } : {}),
        ...(setupEscrowTokenAccount ? { setupEscrowTokenAccount: signedPlan(client, setupEscrowTokenAccount, owner) } : {}),
        ...(setupBeneficiaryTokenAccount
          ? { setupBeneficiaryTokenAccount: signedPlan(client, setupBeneficiaryTokenAccount, owner) }
          : {}),
        initializeAgent: signedPlan(client, initializeAgent, owner),
        setPolicy: signedPlan(client, setPolicy, owner),
        requestPayment: signedPlan(client, requestPayment, owner),
        fundEscrow: signedPlan(client, fundEscrow, owner),
        releaseEscrow: signedPlan(client, releaseEscrow, verifierPubkey),
      },
      transactionBundle,
      reconciliationHashHex: reconciliationHash.toString("hex"),
      preconditions: [
        "The owner signer controls the agent registry and payer token account.",
        "The payer token account must hold enough SPL token balance for the escrow amount.",
        ...customTokenAccountPreconditions(input),
        "The payment intent must be requested before funding escrow; the Anchor program enforces the match.",
        "The verifier signer must match the verifier recorded during escrow funding before release.",
      ],
    },
  };
}

function validateSolanaSpendPlan(input: {
  amount: bigint;
  maxPerTransaction: bigint;
  sessionBudget: bigint;
  approvalRequiredAbove: bigint;
  humanApproved: boolean;
}) {
  if (input.amount <= 0n) {
    throw new Error("proposal amount must be greater than zero.");
  }
  if (input.maxPerTransaction > input.sessionBudget) {
    throw new Error("maxPerTransaction cannot exceed the session budget.");
  }
  if (input.amount > input.maxPerTransaction) {
    throw new Error("proposal amount exceeds the maxPerTransaction policy.");
  }
  if (input.amount > input.sessionBudget) {
    throw new Error("proposal amount exceeds the session budget.");
  }
  if (input.amount > input.approvalRequiredAbove && !input.humanApproved) {
    throw new Error("proposal amount requires human approval under the policy.");
  }
}

function maybeAtaSetup(
  client: AccuralSolanaClient,
  payer: PublicKey,
  owner: PublicKey,
  mint: PublicKey,
  selectedTokenAccount: PublicKey,
  canonicalAta: PublicKey,
) {
  if (!selectedTokenAccount.equals(canonicalAta)) {
    return undefined;
  }
  return client.createAssociatedTokenAccountIx({
    payer,
    associatedTokenAccount: canonicalAta,
    owner,
    mint,
  });
}

function customTokenAccountPreconditions(input: RunAgentSolanaPlanInput) {
  const preconditions: string[] = [];
  if (input.payerTokenAccount) {
    preconditions.push("Custom payerTokenAccount must already be initialized for the selected mint and owner.");
  }
  if (input.escrowTokenAccount) {
    preconditions.push("Custom escrowTokenAccount must already be initialized for the selected mint with escrowAccount PDA ownership.");
  }
  if (input.beneficiaryTokenAccount) {
    preconditions.push("Custom beneficiaryTokenAccount must already be initialized for the selected mint and worker beneficiary.");
  }
  if (preconditions.length === 0) {
    preconditions.push("Idempotent associated-token-account setup instructions are included for payer, escrow PDA, and beneficiary.");
  }
  return preconditions;
}

function defaultGoal(goal: Partial<CampaignGoal> | undefined): CampaignGoal {
  return {
    goal: goal?.goal ?? "Launch a micro-SaaS campaign landing page with a constrained budget.",
    budget: goal?.budget ?? "30",
    taskId: goal?.taskId ?? "landing-page-hero",
  };
}

function randomPubkey() {
  return Keypair.generate().publicKey.toBase58();
}

function parsePubkey(value: string, name: string) {
  try {
    return new PublicKey(value);
  } catch {
    throw new Error(`${name} must be a valid Solana public key.`);
  }
}

function signedPlan(client: AccuralSolanaClient, instruction: Parameters<AccuralSolanaClient["instructionPlan"]>[0], signer: PublicKey) {
  return {
    signerPubkeys: [signer.toBase58()],
    instruction: client.instructionPlan(instruction) satisfies InstructionPlan,
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
