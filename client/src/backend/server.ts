import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { extname, relative, resolve } from "node:path";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { PublicKey } from "@solana/web3.js";
import {
  AccuralRuntime,
  type CreateEscrowInput,
  type DirectPaymentInput,
  type ReleaseEscrowInput,
  type RequestPaymentInput,
  type SetPolicyInput,
} from "../protocol.js";
import { runAgentDemo, runAgentSolanaPlan } from "../agents/run.js";
import { parseUsdcAmount } from "../money.js";
import { ACTION_ALL, AccuralSolanaClient } from "../solana/accural-client.js";
import type { AgentMode, CampaignGoal } from "../agents/types.js";

type JsonObject = Record<string, unknown>;
type SettlementMode = "local-sqlite-control-plane" | "solana-rpc-control-plane";
const staticRoot = resolve(
  fileURLToPath(new URL("../../public/", import.meta.url)),
);

export type BackendServerOptions = {
  runtime?: AccuralRuntime;
  settlementMode?: SettlementMode;
  solanaRpcUrl?: string;
};

export async function createBackendServer(
  options: BackendServerOptions = {},
): Promise<Server> {
  const runtime = options.runtime ?? new AccuralRuntime();
  await runtime.initialize();
  const settlementMode =
    options.settlementMode ??
    parseSettlementMode(process.env.ACCURAL_SETTLEMENT_MODE);
  const solanaClient =
    settlementMode === "solana-rpc-control-plane"
      ? new AccuralSolanaClient({
          rpcUrl:
            options.solanaRpcUrl ??
            process.env.ACCURAL_RPC_URL ??
            "http://127.0.0.1:8899",
        })
      : undefined;

  return createServer((request, response) => {
    handleRequest(
      request,
      response,
      runtime,
      settlementMode,
      solanaClient,
    ).catch((error: unknown) => {
      const message =
        error instanceof Error ? error.message : "Unknown backend error.";
      sendJson(response, 400, { error: message });
    });
  });
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  runtime: AccuralRuntime,
  settlementMode: SettlementMode,
  solanaClient: AccuralSolanaClient | undefined,
) {
  const method = request.method ?? "GET";
  const url = new URL(request.url ?? "/", "http://localhost");
  const parts = url.pathname.split("/").filter(Boolean);

  if (method === "OPTIONS") {
    sendJson(response, 204, {});
    return;
  }

  if (method === "GET" && url.pathname === "/health") {
    sendJson(response, 200, {
      ok: true,
      service: "accural-backend",
      role: "agent-native money coordination API",
      settlementMode,
      settlementBoundary: settlementBoundary(settlementMode),
    });
    return;
  }

  if (method === "GET" && url.pathname === "/settlement/status") {
    sendJson(
      response,
      200,
      await settlementStatus(settlementMode, solanaClient),
    );
    return;
  }

  if (method === "POST" && url.pathname === "/solana/agents/initialize-plan") {
    const client = requireSolanaClient(solanaClient);
    const body = await readJsonObject(request);
    const owner = requiredPubkey(body, "ownerPubkey");
    const agentId = requiredString(body, "agentId");
    const agent = client.deriveAgentAddresses(owner, agentId);
    const instruction = client.initializeAgentIx({
      owner,
      agentRegistry: agent.agentRegistry,
      policyVault: agent.policyVault,
      agentReputation: agent.agentReputation,
      agentId,
    });
    sendJson(response, 200, {
      settlementMode,
      signerPubkeys: [owner.toBase58()],
      addresses: presentAgentAddresses(agent),
      instruction: client.instructionPlan(instruction),
    });
    return;
  }

  if (method === "POST" && url.pathname === "/solana/policies/set-plan") {
    const client = requireSolanaClient(solanaClient);
    const body = await readJsonObject(request);
    const owner = requiredPubkey(body, "ownerPubkey");
    const agentId = requiredString(body, "agentId");
    const agent = client.deriveAgentAddresses(owner, agentId);
    const instruction = client.setPolicyIx({
      owner,
      agentRegistry: agent.agentRegistry,
      policyVault: agent.policyVault,
      maxPerTransaction: parseUsdcAmount(
        requiredString(body, "maxPerTransaction"),
      ),
      sessionBudget: parseUsdcAmount(requiredString(body, "sessionBudget")),
      approvalRequiredAbove: parseUsdcAmount(
        requiredString(body, "approvalRequiredAbove"),
      ),
      allowedActions: optionalNumber(body, "allowedActions") ?? ACTION_ALL,
    });
    sendJson(response, 200, {
      settlementMode,
      signerPubkeys: [owner.toBase58()],
      addresses: presentAgentAddresses(agent),
      instruction: client.instructionPlan(instruction),
    });
    return;
  }

  if (
    method === "POST" &&
    url.pathname === "/solana/payment-intents/request-plan"
  ) {
    const client = requireSolanaClient(solanaClient);
    const body = await readJsonObject(request);
    const owner = requiredPubkey(body, "ownerPubkey");
    const agentId = requiredString(body, "agentId");
    const taskId = requiredString(body, "taskId");
    const agent = client.deriveAgentAddresses(owner, agentId);
    const task = client.deriveTaskAddresses(agent.agentRegistry, taskId);
    const instruction = client.requestPaymentIx({
      owner,
      agentRegistry: agent.agentRegistry,
      policyVault: agent.policyVault,
      paymentIntent: task.paymentIntent,
      taskId,
      amount: parseUsdcAmount(requiredString(body, "amount")),
      mint: requiredPubkey(body, "mint"),
      recipient: requiredPubkey(body, "recipientPubkey"),
      purpose: requiredString(body, "purpose"),
      expiresAt: parseUnixTimestamp(body.expiresAt),
    });
    sendJson(response, 200, {
      settlementMode,
      signerPubkeys: [owner.toBase58()],
      addresses: {
        ...presentAgentAddresses(agent),
        ...presentTaskAddresses(task),
      },
      instruction: client.instructionPlan(instruction),
    });
    return;
  }

  if (method === "POST" && url.pathname === "/solana/escrows/fund-plan") {
    const client = requireSolanaClient(solanaClient);
    const body = await readJsonObject(request);
    const owner = requiredPubkey(body, "ownerPubkey");
    const agentId = requiredString(body, "agentId");
    const taskId = requiredString(body, "taskId");
    const agent = client.deriveAgentAddresses(owner, agentId);
    const task = client.deriveTaskAddresses(agent.agentRegistry, taskId);
    const mint = requiredPubkey(body, "mint");
    const beneficiary = requiredPubkey(body, "beneficiaryPubkey");
    const tokenAccounts = client.deriveTokenAccounts({
      owner,
      escrowAccount: task.escrowAccount,
      beneficiary,
      mint,
    });
    const escrowTokenAccount =
      optionalPubkey(body, "escrowTokenAccount") ??
      tokenAccounts.escrowTokenAccount;
    const payerTokenAccount =
      optionalPubkey(body, "payerTokenAccount") ??
      tokenAccounts.payerTokenAccount;
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
      verifier: requiredPubkey(body, "verifierPubkey"),
      taskId,
      amount: parseUsdcAmount(requiredString(body, "amount")),
      purpose: requiredString(body, "purpose"),
      humanApproved: optionalBoolean(body, "humanApproved") ?? false,
    });
    sendJson(response, 200, {
      settlementMode,
      signerPubkeys: [owner.toBase58()],
      addresses: {
        ...presentAgentAddresses(agent),
        ...presentTaskAddresses(task),
      },
      tokenAccounts: presentTokenAccounts({
        payerTokenAccount,
        escrowTokenAccount,
        beneficiaryTokenAccount: tokenAccounts.beneficiaryTokenAccount,
      }),
      setupInstructions: tokenSetupPlans(
        client,
        owner,
        tokenAccounts,
        {
          payerTokenAccount,
          escrowTokenAccount,
          beneficiaryTokenAccount: tokenAccounts.beneficiaryTokenAccount,
        },
        {
          payerOwner: owner,
          escrowOwner: task.escrowAccount,
          beneficiaryOwner: beneficiary,
          mint,
        },
      ),
      instruction: client.instructionPlan(instruction),
      preconditions: [
        "If you pass custom token accounts, they must already be initialized for this mint and owner.",
        "If you omit token accounts, idempotent ATA setup instructions are returned.",
        "payment intent must already exist and exactly match task, amount, mint, recipient, and purpose",
      ],
    });
    return;
  }

  if (method === "POST" && url.pathname === "/solana/escrows/release-plan") {
    const client = requireSolanaClient(solanaClient);
    const body = await readJsonObject(request);
    const owner = requiredPubkey(body, "ownerPubkey");
    const verifier = requiredPubkey(body, "verifierPubkey");
    const agentId = requiredString(body, "agentId");
    const taskId = requiredString(body, "taskId");
    const agent = client.deriveAgentAddresses(owner, agentId);
    const task = client.deriveTaskAddresses(agent.agentRegistry, taskId);
    const mint = optionalPubkey(body, "mint");
    const beneficiary = optionalPubkey(body, "beneficiaryPubkey");
    const derivedTokenAccounts =
      mint && beneficiary
        ? client.deriveTokenAccounts({
            owner,
            escrowAccount: task.escrowAccount,
            beneficiary,
            mint,
          })
        : undefined;
    const escrowTokenAccount =
      optionalPubkey(body, "escrowTokenAccount") ??
      derivedTokenAccounts?.escrowTokenAccount;
    const beneficiaryTokenAccount =
      optionalPubkey(body, "beneficiaryTokenAccount") ??
      derivedTokenAccounts?.beneficiaryTokenAccount;
    if (!escrowTokenAccount) {
      throw new Error(
        "escrowTokenAccount is required unless mint and beneficiaryPubkey are provided.",
      );
    }
    if (!beneficiaryTokenAccount) {
      throw new Error(
        "beneficiaryTokenAccount is required unless mint and beneficiaryPubkey are provided.",
      );
    }
    const instruction = client.releaseEscrowIx({
      verifier,
      policyVault: agent.policyVault,
      agentReputation: agent.agentReputation,
      paymentIntent: task.paymentIntent,
      escrowAccount: task.escrowAccount,
      escrowTokenAccount,
      beneficiaryTokenAccount,
      reconciliationRecord: task.reconciliationRecord,
      reconciliationHash: parseHash32(body.reconciliationHash),
      outcomeCode: optionalNumber(body, "outcomeCode") ?? 0,
      proofUri: requiredString(body, "proofUri"),
    });
    sendJson(response, 200, {
      settlementMode,
      signerPubkeys: [verifier.toBase58()],
      addresses: {
        ...presentAgentAddresses(agent),
        ...presentTaskAddresses(task),
      },
      tokenAccounts: presentTokenAccounts({
        payerTokenAccount: derivedTokenAccounts?.payerTokenAccount,
        escrowTokenAccount,
        beneficiaryTokenAccount,
      }),
      instruction: client.instructionPlan(instruction),
    });
    return;
  }

  if (method === "POST" && url.pathname === "/agents") {
    const body = await readJsonObject(request);
    const result = await runtime.createAgentWallet({
      agentId: requiredString(body, "agentId"),
      ownerPubkey: optionalString(body, "ownerPubkey"),
    });
    sendJson(response, 201, result);
    return;
  }

  if (
    method === "GET" &&
    parts.length === 3 &&
    parts[0] === "agents" &&
    parts[2] === "balance"
  ) {
    const result = await runtime.getBalance({ agentId: parts[1]! });
    sendJson(response, 200, result);
    return;
  }

  if (
    method === "GET" &&
    parts.length === 3 &&
    parts[0] === "agents" &&
    parts[2] === "reputation"
  ) {
    const result = await runtime.getReputation(parts[1]!);
    sendJson(response, 200, result);
    return;
  }

  if (method === "POST" && url.pathname === "/policies") {
    const body = await readJsonObject(request);
    const result = await runtime.setSpendPolicy({
      agentId: requiredString(body, "agentId"),
      maxPerTransaction: requiredString(body, "maxPerTransaction"),
      sessionBudget: requiredString(body, "sessionBudget"),
      approvalRequiredAbove: optionalString(body, "approvalRequiredAbove"),
      allowedActions: optionalStringArray(body, "allowedActions"),
      blockedRecipients: optionalStringArray(body, "blockedRecipients"),
    } satisfies SetPolicyInput);
    sendJson(response, 200, result);
    return;
  }

  if (method === "POST" && url.pathname === "/payment-intents") {
    const body = await readJsonObject(request);
    const result = await runtime.requestPayment({
      requesterAgentId: requiredString(body, "requesterAgentId"),
      taskId: requiredString(body, "taskId"),
      amount: requiredString(body, "amount"),
      recipientPubkey: requiredString(body, "recipientPubkey"),
      purpose: requiredString(body, "purpose"),
      expiresAt: optionalString(body, "expiresAt"),
    } satisfies RequestPaymentInput);
    sendJson(response, 201, result);
    return;
  }

  if (method === "POST" && url.pathname === "/escrows") {
    const body = await readJsonObject(request);
    const result = await runtime.createTaskEscrow({
      payerAgentId: requiredString(body, "payerAgentId"),
      taskId: requiredString(body, "taskId"),
      amount: requiredString(body, "amount"),
      purpose: requiredString(body, "purpose"),
      beneficiaryPubkey: requiredString(body, "beneficiaryPubkey"),
      verifierPubkey: requiredString(body, "verifierPubkey"),
      paymentIntentId: requiredString(body, "paymentIntentId"),
      humanApproved: optionalBoolean(body, "humanApproved"),
    } satisfies CreateEscrowInput);
    sendJson(response, 201, result);
    return;
  }

  if (
    method === "POST" &&
    parts.length === 3 &&
    parts[0] === "escrows" &&
    parts[2] === "release"
  ) {
    const body = await readJsonObject(request);
    const result = await runtime.releaseEscrow({
      taskId: parts[1]!,
      verifierPubkey: requiredString(body, "verifierPubkey"),
      outcome: requiredString(body, "outcome"),
      proofUri: requiredString(body, "proofUri"),
    } satisfies ReleaseEscrowInput);
    sendJson(response, 200, result);
    return;
  }

  if (method === "POST" && url.pathname === "/direct-payments") {
    const body = await readJsonObject(request);
    const result = await runtime.directPayment({
      payerAgentId: requiredString(body, "payerAgentId"),
      taskId: requiredString(body, "taskId"),
      amount: requiredString(body, "amount"),
      recipientPubkey: requiredString(body, "recipientPubkey"),
      purpose: requiredString(body, "purpose"),
      proofUri: requiredString(body, "proofUri"),
    } satisfies DirectPaymentInput);
    sendJson(response, 201, result);
    return;
  }

  if (method === "GET" && url.pathname === "/reconciliation") {
    const taskId = url.searchParams.get("taskId") ?? undefined;
    const result = await runtime.reconcilePayment(taskId);
    sendJson(response, 200, result);
    return;
  }

  if (method === "POST" && url.pathname === "/services") {
    const body = await readJsonObject(request);
    const result = await runtime.registerService({
      agentId: requiredString(body, "agentId"),
      serviceType: requiredString(body, "serviceType"),
      description: requiredString(body, "description"),
      price: requiredString(body, "price"),
    });
    sendJson(response, 201, result);
    return;
  }

  if (method === "GET" && url.pathname === "/services") {
    const serviceType = url.searchParams.get("serviceType") ?? undefined;
    const result = await runtime.listServices({ serviceType });
    sendJson(response, 200, result);
    return;
  }

  if (method === "POST" && url.pathname === "/agent-runs") {
    const body = await readJsonObject(request);
    const result = await runAgentDemo({
      runtime,
      mode: parseAgentMode(optionalString(body, "mode") ?? "deterministic"),
      goal: optionalGoal(body),
      resetState: optionalBoolean(body, "resetState") ?? true,
    });
    sendJson(response, 201, result);
    return;
  }

  if (method === "POST" && url.pathname === "/agent-runs/solana-plan") {
    const client = requireSolanaClient(solanaClient);
    const body = await readJsonObject(request);
    const result = await runAgentSolanaPlan({
      solanaClient: client,
      mode: parseAgentMode(optionalString(body, "mode") ?? "deterministic"),
      goal: optionalGoal(body),
      ownerPubkey: optionalString(body, "ownerPubkey"),
      workerPubkey: optionalString(body, "workerPubkey"),
      verifierPubkey: optionalString(body, "verifierPubkey"),
      mint: optionalString(body, "mint"),
      payerTokenAccount: optionalString(body, "payerTokenAccount"),
      escrowTokenAccount: optionalString(body, "escrowTokenAccount"),
      beneficiaryTokenAccount: optionalString(body, "beneficiaryTokenAccount"),
      humanApproved: optionalBoolean(body, "humanApproved"),
      expiresAt: parseOptionalUnixTimestamp(body.expiresAt),
    });
    sendJson(response, 201, result);
    return;
  }

  if (await tryServeStatic(request, response, url)) {
    return;
  }

  sendJson(response, 404, {
    error: "Route not found.",
    routes: [
      "GET /health",
      "POST /agents",
      "GET /agents/:agentId/balance",
      "GET /agents/:agentId/reputation",
      "POST /policies",
      "POST /payment-intents",
      "POST /escrows",
      "POST /escrows/:taskId/release",
      "POST /direct-payments",
      "GET /reconciliation?taskId=:taskId",
      "POST /agent-runs",
      "POST /agent-runs/solana-plan",
      "GET /settlement/status",
      "POST /solana/agents/initialize-plan",
      "POST /solana/policies/set-plan",
      "POST /solana/payment-intents/request-plan",
      "POST /solana/escrows/fund-plan",
      "POST /solana/escrows/release-plan",
    ],
  });
}

async function tryServeStatic(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
) {
  if (request.method !== "GET") {
    return false;
  }

  const pathname = decodeURIComponent(url.pathname);
  const requestedFile = pathname === "/" ? "index.html" : pathname.slice(1);
  const resolvedFile = resolve(staticRoot, requestedFile);
  if (relative(staticRoot, resolvedFile).startsWith("..")) {
    return false;
  }

  try {
    const content = await readFile(resolvedFile);
    response.statusCode = 200;
    response.setHeader("Content-Type", contentType(resolvedFile));
    response.setHeader("Cache-Control", "no-store");
    response.end(content);
    return true;
  } catch {
    if (!extname(pathname)) {
      try {
        const content = await readFile(resolve(staticRoot, "index.html"));
        response.statusCode = 200;
        response.setHeader("Content-Type", "text/html; charset=utf-8");
        response.setHeader("Cache-Control", "no-store");
        response.end(content);
        return true;
      } catch {
        return false;
      }
    }
    return false;
  }
}

function contentType(filePath: string) {
  switch (extname(filePath)) {
    case ".css":
      return "text/css; charset=utf-8";
    case ".js":
      return "text/javascript; charset=utf-8";
    case ".svg":
      return "image/svg+xml";
    case ".json":
      return "application/json; charset=utf-8";
    default:
      return "text/html; charset=utf-8";
  }
}

async function settlementStatus(
  settlementMode: SettlementMode,
  solanaClient: AccuralSolanaClient | undefined,
) {
  if (settlementMode === "local-sqlite-control-plane") {
    return {
      settlementMode,
      ready: true,
      settlesOnChain: false,
      note: "Local mode exercises Accural semantics without submitting Solana transactions.",
    };
  }

  if (!solanaClient) {
    return {
      settlementMode,
      ready: false,
      settlesOnChain: true,
      error: "Solana client was not configured.",
    };
  }

  try {
    const blockhash =
      await solanaClient.connection.getLatestBlockhash("confirmed");
    const deployment = await solanaClient.getProgramDeploymentStatus();
    return {
      settlementMode,
      ready: deployment.deployed && deployment.executable,
      settlesOnChain: true,
      rpcReady: true,
      programDeployed: deployment.deployed,
      programExecutable: deployment.executable,
      programId: deployment.programId,
      programOwner: deployment.owner,
      programDataLength: deployment.dataLength,
      latestBlockhash: blockhash.blockhash,
    };
  } catch (error) {
    return {
      settlementMode,
      ready: false,
      settlesOnChain: true,
      rpcReady: false,
      programId: solanaClient.programId.toBase58(),
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function settlementBoundary(settlementMode: SettlementMode) {
  if (settlementMode === "solana-rpc-control-plane") {
    return "Backend is configured to inspect Solana RPC/program readiness. Transaction submission should use the Solana settlement client.";
  }
  return "This HTTP service drives the local SQLite runtime. Real settlement is the Anchor program/local-validator path.";
}

function parseSettlementMode(value: string | undefined): SettlementMode {
  if (value === "solana" || value === "solana-rpc-control-plane") {
    return "solana-rpc-control-plane";
  }
  return "local-sqlite-control-plane";
}

function requireSolanaClient(solanaClient: AccuralSolanaClient | undefined) {
  if (!solanaClient) {
    throw new Error(
      "Solana settlement mode is required for this route. Set ACCURAL_SETTLEMENT_MODE=solana.",
    );
  }
  return solanaClient;
}

function presentAgentAddresses(
  addresses: ReturnType<AccuralSolanaClient["deriveAgentAddresses"]>,
) {
  return {
    agentRegistry: addresses.agentRegistry.toBase58(),
    policyVault: addresses.policyVault.toBase58(),
    agentReputation: addresses.agentReputation.toBase58(),
  };
}

function presentTaskAddresses(
  addresses: ReturnType<AccuralSolanaClient["deriveTaskAddresses"]>,
) {
  return {
    paymentIntent: addresses.paymentIntent.toBase58(),
    escrowAccount: addresses.escrowAccount.toBase58(),
    reconciliationRecord: addresses.reconciliationRecord.toBase58(),
  };
}

function presentTokenAccounts(addresses: {
  payerTokenAccount?: PublicKey;
  escrowTokenAccount: PublicKey;
  beneficiaryTokenAccount: PublicKey;
}) {
  return {
    payerTokenAccount: addresses.payerTokenAccount?.toBase58(),
    escrowTokenAccount: addresses.escrowTokenAccount.toBase58(),
    beneficiaryTokenAccount: addresses.beneficiaryTokenAccount.toBase58(),
  };
}

function tokenSetupPlans(
  client: AccuralSolanaClient,
  payer: PublicKey,
  canonical: ReturnType<AccuralSolanaClient["deriveTokenAccounts"]>,
  selected: ReturnType<AccuralSolanaClient["deriveTokenAccounts"]>,
  owners: {
    payerOwner: PublicKey;
    escrowOwner: PublicKey;
    beneficiaryOwner: PublicKey;
    mint: PublicKey;
  },
) {
  return {
    ...(selected.payerTokenAccount.equals(canonical.payerTokenAccount)
      ? {
          setupPayerTokenAccount: signedInstructionPlan(
            client,
            client.createAssociatedTokenAccountIx({
              payer,
              associatedTokenAccount: canonical.payerTokenAccount,
              owner: owners.payerOwner,
              mint: owners.mint,
            }),
            payer,
          ),
        }
      : {}),
    ...(selected.escrowTokenAccount.equals(canonical.escrowTokenAccount)
      ? {
          setupEscrowTokenAccount: signedInstructionPlan(
            client,
            client.createAssociatedTokenAccountIx({
              payer,
              associatedTokenAccount: canonical.escrowTokenAccount,
              owner: owners.escrowOwner,
              mint: owners.mint,
            }),
            payer,
          ),
        }
      : {}),
    ...(selected.beneficiaryTokenAccount.equals(
      canonical.beneficiaryTokenAccount,
    )
      ? {
          setupBeneficiaryTokenAccount: signedInstructionPlan(
            client,
            client.createAssociatedTokenAccountIx({
              payer,
              associatedTokenAccount: canonical.beneficiaryTokenAccount,
              owner: owners.beneficiaryOwner,
              mint: owners.mint,
            }),
            payer,
          ),
        }
      : {}),
  };
}

function signedInstructionPlan(
  client: AccuralSolanaClient,
  instruction: Parameters<AccuralSolanaClient["instructionPlan"]>[0],
  signer: PublicKey,
) {
  return {
    signerPubkeys: [signer.toBase58()],
    instruction: client.instructionPlan(instruction),
  };
}

function sendJson(
  response: ServerResponse,
  statusCode: number,
  payload: unknown,
) {
  response.statusCode = statusCode;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Access-Control-Allow-Headers", "content-type");
  response.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  if (statusCode === 204) {
    response.end();
    return;
  }
  response.end(JSON.stringify(payload, null, 2));
}

async function readJsonObject(request: IncomingMessage): Promise<JsonObject> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }

  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) {
    return {};
  }

  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("JSON body must be an object.");
  }
  return parsed as JsonObject;
}

function requiredString(body: JsonObject, key: string) {
  const value = body[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${key} must be a non-empty string.`);
  }
  return value.trim();
}

function requiredPubkey(body: JsonObject, key: string) {
  const value = requiredString(body, key);
  try {
    return new PublicKey(value);
  } catch {
    throw new Error(`${key} must be a valid Solana public key.`);
  }
}

function optionalPubkey(body: JsonObject, key: string) {
  const value = optionalString(body, key);
  if (value === undefined) {
    return undefined;
  }
  try {
    return new PublicKey(value);
  } catch {
    throw new Error(`${key} must be a valid Solana public key when provided.`);
  }
}

function optionalNumber(body: JsonObject, key: string) {
  const value = body[key];
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new Error(`${key} must be an integer when provided.`);
  }
  return value;
}

function optionalString(body: JsonObject, key: string) {
  const value = body[key];
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${key} must be a non-empty string when provided.`);
  }
  return value.trim();
}

function optionalStringArray(body: JsonObject, key: string) {
  const value = body[key];
  if (value === undefined || value === null) {
    return undefined;
  }
  if (
    !Array.isArray(value) ||
    value.some((item) => typeof item !== "string" || !item.trim())
  ) {
    throw new Error(
      `${key} must be an array of non-empty strings when provided.`,
    );
  }
  return value.map((item) => item.trim());
}

function optionalBoolean(body: JsonObject, key: string) {
  const value = body[key];
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "boolean") {
    throw new Error(`${key} must be a boolean when provided.`);
  }
  return value;
}

function parseUnixTimestamp(value: unknown) {
  if (typeof value === "number" && Number.isInteger(value)) {
    return BigInt(value);
  }
  if (typeof value === "string" && /^\d+$/.test(value)) {
    return BigInt(value);
  }
  if (typeof value === "string" && value.trim()) {
    const timestamp = new Date(value).getTime();
    if (Number.isFinite(timestamp)) {
      return BigInt(Math.floor(timestamp / 1000));
    }
  }
  return BigInt(Math.floor(Date.now() / 1000) + 15 * 60);
}

function parseOptionalUnixTimestamp(value: unknown) {
  if (value === undefined || value === null) {
    return undefined;
  }
  return parseUnixTimestamp(value);
}

function parseHash32(value: unknown) {
  if (typeof value !== "string" || !value.trim()) {
    return createHash("sha256").update(String(Date.now())).digest();
  }

  const trimmed = value.trim();
  const hex = trimmed.startsWith("0x") ? trimmed.slice(2) : trimmed;
  if (/^[0-9a-fA-F]{64}$/.test(hex)) {
    return Buffer.from(hex, "hex");
  }

  const decoded = Buffer.from(trimmed, "base64");
  if (decoded.length === 32) {
    return decoded;
  }

  throw new Error("reconciliationHash must be a 32-byte hex or base64 value.");
}

function optionalGoal(body: JsonObject): Partial<CampaignGoal> | undefined {
  const value = body.goal;
  if (value === undefined || value === null) {
    return undefined;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("goal must be an object when provided.");
  }

  const goal = value as JsonObject;
  return {
    goal: optionalString(goal, "goal"),
    budget: optionalString(goal, "budget"),
    taskId: optionalString(goal, "taskId"),
  };
}

function parseAgentMode(value: string): AgentMode {
  if (value !== "deterministic" && value !== "llm") {
    throw new Error("mode must be deterministic or llm.");
  }
  return value;
}

async function main() {
  const port = Number.parseInt(
    process.env.PORT ?? process.env.ACCURAL_BACKEND_PORT ?? "8787",
    10,
  );
  const host = process.env.ACCURAL_BACKEND_HOST ?? "0.0.0.0";
  const server = await createBackendServer();
  server.listen(port, host, () => {
    console.log(`Accural backend listening on http://${host}:${port}`);
  });
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  await main();
}
