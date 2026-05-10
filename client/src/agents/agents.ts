import type { LlmClient } from "./llm.js";
import type {
  AgentMode,
  AssignmentPlan,
  CampaignGoal,
  VerificationDecision,
  WorkDelivery,
  WorkProposal,
} from "./types.js";

export class CampaignCoordinatorAgent {
  readonly agentId = "campaign-coordinator";

  constructor(
    private readonly mode: AgentMode,
    private readonly llm?: LlmClient,
  ) {}

  async plan(goal: CampaignGoal): Promise<AssignmentPlan> {
    if (this.mode === "deterministic") {
      return {
        agentId: this.agentId,
        taskId: goal.taskId,
        budget: goal.budget,
        maxPerTransaction: "15",
        approvalRequiredAbove: "12",
        taskBrief: `Commission a focused deliverable for: ${goal.goal}`,
      };
    }

    return requireLlm(this.llm).completeJson<AssignmentPlan>({
      agentName: this.agentId,
      systemPrompt:
        "You are the coordinator agent for Accural. Convert a user goal into a budgeted task plan. Use concise JSON fields: agentId, taskId, budget, maxPerTransaction, approvalRequiredAbove, taskBrief.",
      userPrompt: JSON.stringify(goal),
    });
  }
}

export class SpecialistWorkerAgent {
  readonly agentId = "specialist-worker";

  constructor(
    private readonly mode: AgentMode,
    private readonly llm?: LlmClient,
  ) {}

  async propose(plan: AssignmentPlan, recipientPubkey: string): Promise<WorkProposal> {
    if (this.mode === "deterministic") {
      return {
        agentId: this.agentId,
        amount: "10",
        purpose: `Produce artifact for ${plan.taskId}.`,
      };
    }

    return requireLlm(this.llm).completeJson<WorkProposal>({
      agentName: this.agentId,
      systemPrompt:
        "You are a worker agent in an Accural task market. Create a payment request proposal. Return JSON fields: agentId, amount, purpose. Amount must fit under the provided maxPerTransaction.",
      userPrompt: JSON.stringify({ plan, recipientPubkey }),
    });
  }

  async deliver(plan: AssignmentPlan): Promise<WorkDelivery> {
    if (this.mode === "deterministic") {
      return {
        artifactUri: `ipfs://accural-demo/${plan.taskId}`,
        summary: `Completed deterministic artifact for ${plan.taskBrief}`,
      };
    }

    return requireLlm(this.llm).completeJson<WorkDelivery>({
      agentName: this.agentId,
      systemPrompt:
        "You are a worker agent. Produce a concise delivery record for the completed task. Return JSON fields: artifactUri, summary. Use a fake ipfs:// URI for artifactUri.",
      userPrompt: JSON.stringify(plan),
    });
  }
}

export class ArtifactVerifierAgent {
  readonly agentId = "artifact-verifier";

  constructor(
    private readonly mode: AgentMode,
    private readonly llm?: LlmClient,
  ) {}

  async verify(input: {
    plan: AssignmentPlan;
    delivery: WorkDelivery;
  }): Promise<VerificationDecision> {
    if (this.mode === "deterministic") {
      const approved =
        input.delivery.artifactUri.startsWith("ipfs://") &&
        input.delivery.summary.toLowerCase().includes("artifact");

      return {
        approved,
        outcome: approved
          ? `Verifier accepted artifact for ${input.plan.taskId}.`
          : `Verifier rejected artifact for ${input.plan.taskId}.`,
        proofUri: input.delivery.artifactUri,
      };
    }

    return requireLlm(this.llm).completeJson<VerificationDecision>({
      agentName: this.agentId,
      systemPrompt:
        "You are a verifier agent. Decide if the delivered artifact satisfies the task. Return JSON fields: approved, outcome, proofUri. Only approve if proofUri is present and the summary plausibly matches the task.",
      userPrompt: JSON.stringify(input),
    });
  }
}

function requireLlm(llm: LlmClient | undefined) {
  if (!llm) {
    throw new Error("LLM mode requires an LlmClient.");
  }
  return llm;
}
