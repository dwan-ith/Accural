import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { AccuralRuntime } from "./protocol.js";

const runtime = new AccuralRuntime();
await runtime.initialize();

const server = new McpServer({
  name: "Accural",
  version: "1.0.0",
});

function result(data: unknown) {
  const structuredContent =
    data && typeof data === "object" && !Array.isArray(data)
      ? (data as Record<string, unknown>)
      : { result: data };

  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
    structuredContent,
  };
}

function failure(error: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: error instanceof Error ? error.message : String(error),
      },
    ],
    isError: true as const,
  };
}

server.registerTool(
  "create_agent_wallet",
  {
    title: "Create Agent Wallet",
    description:
      "Create an Accural agent identity. This establishes the agent's financial profile before any spend policy or escrow can be used.",
    inputSchema: {
      agentId: z
        .string()
        .describe("Stable 1-32 character agent identifier, such as jarvis or research-agent."),
      ownerPubkey: z
        .string()
        .optional()
        .describe("Optional Solana owner public key. Defaults to this MCP session owner."),
    },
  },
  async (input) => {
    try {
      return result(await runtime.createAgentWallet(input));
    } catch (error) {
      return failure(error);
    }
  },
);

server.registerTool(
  "get_balance",
  {
    title: "Get Agent Balance",
    description:
      "Return the agent's policy budget, currently active escrow, released spend, and wallet identity.",
    inputSchema: {
      agentId: z.string(),
    },
  },
  async (input) => {
    try {
      return result(await runtime.getBalance(input));
    } catch (error) {
      return failure(error);
    }
  },
);

server.registerTool(
  "set_spend_policy",
  {
    title: "Set Spend Policy",
    description:
      "Set policy-enforced spend limits for an agent. Amounts are USDC decimal strings, never floats.",
    inputSchema: {
      agentId: z.string(),
      maxPerTransaction: z.string().describe("Maximum USDC per escrow, e.g. 10 or 2.50."),
      sessionBudget: z.string().describe("Total USDC budget for this session."),
      approvalRequiredAbove: z
        .string()
        .optional()
        .describe("USDC threshold above which a production policy should require extra approval."),
      allowedActions: z
        .array(z.enum(["request_payment", "create_task_escrow", "release_escrow"]))
        .optional(),
      blockedRecipients: z.array(z.string()).optional(),
    },
  },
  async (input) => {
    try {
      return result(await runtime.setSpendPolicy(input));
    } catch (error) {
      return failure(error);
    }
  },
);

server.registerTool(
  "request_payment",
  {
    title: "Request Payment",
    description:
      "Create an agent-readable payment intent. This does not move funds; it creates the request an agent can evaluate against policy.",
    inputSchema: {
      requesterAgentId: z.string(),
      taskId: z.string(),
      amount: z.string().describe("Requested USDC amount, e.g. 15 or 0.03."),
      recipientPubkey: z.string(),
      purpose: z.string(),
      expiresAt: z.string().optional().describe("Optional ISO timestamp. Defaults to 15 minutes."),
    },
  },
  async (input) => {
    try {
      return result(await runtime.requestPayment(input));
    } catch (error) {
      return failure(error);
    }
  },
);

server.registerTool(
  "create_task_escrow",
  {
    title: "Create Task Escrow",
    description:
      "Lock funds for task work after checking the payer agent's spend policy and required matching payment intent.",
    inputSchema: {
      payerAgentId: z.string(),
      taskId: z.string(),
      amount: z.string().describe("Escrowed USDC amount."),
      purpose: z.string(),
      beneficiaryPubkey: z.string(),
      verifierPubkey: z.string(),
      paymentIntentId: z
        .string()
        .describe("Required payment intent id. Accural escrows must be backed by a matching payment request."),
      humanApproved: z.boolean().optional(),
    },
  },
  async (input) => {
    try {
      return result(await runtime.createTaskEscrow(input));
    } catch (error) {
      return failure(error);
    }
  },
);

server.registerTool(
  "release_escrow",
  {
    title: "Release Escrow",
    description:
      "Release a funded task escrow after verifier approval and write semantic reconciliation memory.",
    inputSchema: {
      taskId: z.string(),
      verifierPubkey: z.string(),
      outcome: z.string().describe("Short explanation of what was verified."),
      proofUri: z.string().describe("URI for report, commit, artifact, receipt, or verifier evidence."),
    },
  },
  async (input) => {
    try {
      return result(await runtime.releaseEscrow(input));
    } catch (error) {
      return failure(error);
    }
  },
);

server.registerTool(
  "reconcile_payment",
  {
    title: "Reconcile Payment",
    description:
      "Read semantic payment memory for a task. Omitting taskId returns all local reconciliation records.",
    inputSchema: {
      taskId: z.string().optional(),
    },
  },
  async (input) => {
    try {
      return result(await runtime.reconcilePayment(input.taskId));
    } catch (error) {
      return failure(error);
    }
  },
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Accural MCP server running on stdio.");
  console.error(`Session owner: ${runtime.getSessionOwnerPubkey()}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
