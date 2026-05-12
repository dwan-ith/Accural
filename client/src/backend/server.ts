import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { Keypair, PublicKey } from "@solana/web3.js";
import { parseBooleanEnv, parseSettlementMode, solanaRpcUrl, type SettlementMode } from "../config.js";
import { AccuralRuntime, type CreateEscrowInput, type DirectPaymentInput, type ReleaseEscrowInput, type RequestPaymentInput, type SetPolicyInput } from "../protocol.js";
import { runAgentDemo, runAgentSolanaPlan } from "../agents/run.js";
import { parseUsdcAmount } from "../money.js";
import { ACTION_ALL, AccuralSolanaClient, semanticReconciliationHash, type TransactionBundlePlan } from "../solana/accural-client.js";
import { bundlePlanHash, executeTransactionBundle, validateTransactionBundlePlan } from "../solana/execute-bundle.js";
import type { AgentMode, CampaignGoal } from "../agents/types.js";

type JsonObject = Record<string, unknown>;

export type BackendServerOptions = {
  runtime?: AccuralRuntime;
  settlementMode?: SettlementMode;
  solanaRpcUrl?: string;
};

export async function createBackendServer(options: BackendServerOptions = {}): Promise<Server> {
  const settlementMode = options.settlementMode ?? parseSettlementMode(process.env.ACCURAL_SETTLEMENT_MODE);
  const runtime = options.runtime ?? (settlementMode === "local-sqlite-control-plane" ? new AccuralRuntime() : undefined);
  if (runtime) {
    await runtime.initialize();
  }
  const solanaClient =
    settlementMode === "solana-rpc-control-plane"
      ? new AccuralSolanaClient({
          rpcUrl: solanaRpcUrl(options.solanaRpcUrl),
        })
      : undefined;

  return createServer((request, response) => {
    handleRequest(request, response, runtime, settlementMode, solanaClient).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : "Unknown backend error.";
      sendJson(response, 400, { error: message });
    });
  });
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  runtime: AccuralRuntime | undefined,
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
    sendJson(response, 200, await settlementStatus(settlementMode, solanaClient));
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
      maxPerTransaction: parseUsdcAmount(requiredString(body, "maxPerTransaction")),
      sessionBudget: parseUsdcAmount(requiredString(body, "sessionBudget")),
      approvalRequiredAbove: parseUsdcAmount(requiredString(body, "approvalRequiredAbove")),
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

  if (method === "POST" && url.pathname === "/solana/payment-intents/request-plan") {
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
      addresses: { ...presentAgentAddresses(agent), ...presentTaskAddresses(task) },
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
    const escrowTokenAccount = optionalPubkey(body, "escrowTokenAccount") ?? tokenAccounts.escrowTokenAccount;
    const payerTokenAccount = optionalPubkey(body, "payerTokenAccount") ?? tokenAccounts.payerTokenAccount;
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
      addresses: { ...presentAgentAddresses(agent), ...presentTaskAddresses(task) },
      tokenAccounts: presentTokenAccounts({
        payerTokenAccount,
        escrowTokenAccount,
        beneficiaryTokenAccount: tokenAccounts.beneficiaryTokenAccount,
      }),
      setupInstructions: tokenSetupPlans(client, owner, tokenAccounts, {
        payerTokenAccount,
        escrowTokenAccount,
        beneficiaryTokenAccount: tokenAccounts.beneficiaryTokenAccount,
      }, {
        payerOwner: owner,
        escrowOwner: task.escrowAccount,
        beneficiaryOwner: beneficiary,
        mint,
      }),
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
    const derivedTokenAccounts = mint && beneficiary
      ? client.deriveTokenAccounts({
          owner,
          escrowAccount: task.escrowAccount,
          beneficiary,
          mint,
        })
      : undefined;
    const escrowTokenAccount =
      optionalPubkey(body, "escrowTokenAccount") ?? derivedTokenAccounts?.escrowTokenAccount;
    const beneficiaryTokenAccount =
      optionalPubkey(body, "beneficiaryTokenAccount") ?? derivedTokenAccounts?.beneficiaryTokenAccount;
    if (!escrowTokenAccount) {
      throw new Error("escrowTokenAccount is required unless mint and beneficiaryPubkey are provided.");
    }
    if (!beneficiaryTokenAccount) {
      throw new Error("beneficiaryTokenAccount is required unless mint and beneficiaryPubkey are provided.");
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
      addresses: { ...presentAgentAddresses(agent), ...presentTaskAddresses(task) },
      tokenAccounts: presentTokenAccounts({
        payerTokenAccount: derivedTokenAccounts?.payerTokenAccount,
        escrowTokenAccount,
        beneficiaryTokenAccount,
      }),
      instruction: client.instructionPlan(instruction),
    });
    return;
  }

  if (method === "POST" && url.pathname === "/solana/services/register-plan") {
    const client = requireSolanaClient(solanaClient);
    const body = await readJsonObject(request);
    const owner = requiredPubkey(body, "ownerPubkey");
    const agentId = requiredString(body, "agentId");
    const serviceType = requiredString(body, "serviceType");
    const agent = client.deriveAgentAddresses(owner, agentId);
    const service = client.deriveServiceAddresses(agent.agentRegistry, serviceType);
    const instruction = client.registerServiceIx({
      owner,
      agentRegistry: agent.agentRegistry,
      serviceListing: service.serviceListing,
      mint: requiredPubkey(body, "mint"),
      serviceType,
      description: requiredString(body, "description"),
      priceMinor: parseUsdcAmount(requiredString(body, "price")),
    });
    sendJson(response, 200, {
      settlementMode,
      signerPubkeys: [owner.toBase58()],
      addresses: { ...presentAgentAddresses(agent), serviceListing: service.serviceListing.toBase58() },
      instruction: client.instructionPlan(instruction),
    });
    return;
  }

  if (method === "POST" && url.pathname === "/solana/services/deactivate-plan") {
    const client = requireSolanaClient(solanaClient);
    const body = await readJsonObject(request);
    const owner = requiredPubkey(body, "ownerPubkey");
    const agentId = requiredString(body, "agentId");
    const serviceType = requiredString(body, "serviceType");
    const agent = client.deriveAgentAddresses(owner, agentId);
    const service = client.deriveServiceAddresses(agent.agentRegistry, serviceType);
    const instruction = client.deactivateServiceIx({
      owner,
      agentRegistry: agent.agentRegistry,
      serviceListing: service.serviceListing,
    });
    sendJson(response, 200, {
      settlementMode,
      signerPubkeys: [owner.toBase58()],
      addresses: { ...presentAgentAddresses(agent), serviceListing: service.serviceListing.toBase58() },
      instruction: client.instructionPlan(instruction),
    });
    return;
  }

  if (method === "POST" && url.pathname === "/solana/direct-payments/plan") {
    const client = requireSolanaClient(solanaClient);
    const body = await readJsonObject(request);
    const owner = requiredPubkey(body, "ownerPubkey");
    const agentId = requiredString(body, "agentId");
    const taskId = requiredString(body, "taskId");
    const mint = requiredPubkey(body, "mint");
    const recipient = requiredPubkey(body, "recipientPubkey");
    const agent = client.deriveAgentAddresses(owner, agentId);
    const directPayment = client.deriveDirectPaymentAddresses(agent.agentRegistry, taskId);
    const canonicalTokenAccounts = client.deriveDirectPaymentTokenAccounts({ owner, recipient, mint });
    const payerTokenAccount = optionalPubkey(body, "payerTokenAccount") ?? canonicalTokenAccounts.payerTokenAccount;
    const recipientTokenAccount = optionalPubkey(body, "recipientTokenAccount") ?? canonicalTokenAccounts.recipientTokenAccount;
    const amount = parseUsdcAmount(requiredString(body, "amount"));
    const purpose = requiredString(body, "purpose");
    const proofUri = requiredString(body, "proofUri");
    const reconciliationHash = parseHash32(body.reconciliationHash, {
      taskId,
      agentId,
      amount: amount.toString(),
      recipientPubkey: recipient.toBase58(),
      purpose,
      proofUri,
    });
    const instruction = client.directPaymentIx({
      owner,
      agentRegistry: agent.agentRegistry,
      policyVault: agent.policyVault,
      reconciliationRecord: directPayment.reconciliationRecord,
      payerTokenAccount,
      recipientTokenAccount,
      mint,
      recipient,
      taskId,
      amount,
      purpose,
      reconciliationHash,
      proofUri,
    });
    sendJson(response, 200, {
      settlementMode,
      signerPubkeys: [owner.toBase58()],
      addresses: {
        ...presentAgentAddresses(agent),
        reconciliationRecord: directPayment.reconciliationRecord.toBase58(),
      },
      tokenAccounts: {
        payerTokenAccount: payerTokenAccount.toBase58(),
        recipientTokenAccount: recipientTokenAccount.toBase58(),
      },
      setupInstructions: directPaymentTokenSetupPlans(client, owner, canonicalTokenAccounts, {
        payerTokenAccount,
        recipientTokenAccount,
      }, {
        payerOwner: owner,
        recipientOwner: recipient,
        mint,
      }),
      instruction: client.instructionPlan(instruction),
      reconciliationHashHex: reconciliationHash.toString("hex"),
      preconditions: [
        "The policy must include the direct_payment action and enough remaining session budget.",
        "The payer token account must hold enough SPL token balance for the payment amount.",
      ],
    });
    return;
  }

  if (method === "POST" && url.pathname === "/solana/bundles/execute") {
    const client = requireSolanaClient(solanaClient);
    const body = await readJsonObject(request);
    const bundle = requiredBundle(body.bundle);
    const validation = validateTransactionBundlePlan(bundle);
    if (!validation.ok) {
      throw new Error(`Invalid transaction bundle: ${validation.errors.join(" ")}`);
    }
    const signers = loadConfiguredBackendSigners();
    const missingSigners = requiredBundleSigners(bundle).filter((signer) => !signers.has(signer));
    if (missingSigners.length > 0) {
      throw new Error(
        `Backend signer configuration is missing ${missingSigners.join(", ")}. Configure ACCURAL_OWNER_KEYPAIR, ACCURAL_VERIFIER_KEYPAIR, or ACCURAL_EXTRA_SIGNER_KEYPAIRS.`,
      );
    }
    const result = await executeTransactionBundle({
      client,
      bundle,
      signers,
      simulateBeforeSend: optionalBoolean(body, "simulateBeforeSend") ?? parseBooleanEnv(process.env.ACCURAL_SIMULATE_BEFORE_SEND, true),
    });
    sendJson(response, 200, {
      settlementMode,
      settlesOnChain: true,
      ...result,
      verifiedBundleHash: bundlePlanHash(bundle),
    });
    return;
  }

  if (method === "POST" && url.pathname === "/agents") {
    const localRuntime = requireLocalRuntime(runtime);
    const body = await readJsonObject(request);
    const result = await localRuntime.createAgentWallet({
      agentId: requiredString(body, "agentId"),
      ownerPubkey: optionalString(body, "ownerPubkey"),
    });
    sendJson(response, 201, result);
    return;
  }

  if (method === "GET" && parts.length === 3 && parts[0] === "agents" && parts[2] === "balance") {
    const localRuntime = requireLocalRuntime(runtime);
    const result = await localRuntime.getBalance({ agentId: parts[1]! });
    sendJson(response, 200, result);
    return;
  }

  if (method === "GET" && parts.length === 3 && parts[0] === "agents" && parts[2] === "reputation") {
    const localRuntime = requireLocalRuntime(runtime);
    const result = await localRuntime.getReputation(parts[1]!);
    sendJson(response, 200, result);
    return;
  }

  if (method === "POST" && url.pathname === "/policies") {
    const localRuntime = requireLocalRuntime(runtime);
    const body = await readJsonObject(request);
    const result = await localRuntime.setSpendPolicy({
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
    const localRuntime = requireLocalRuntime(runtime);
    const body = await readJsonObject(request);
    const result = await localRuntime.requestPayment({
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
    const localRuntime = requireLocalRuntime(runtime);
    const body = await readJsonObject(request);
    const result = await localRuntime.createTaskEscrow({
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

  if (method === "POST" && parts.length === 3 && parts[0] === "escrows" && parts[2] === "release") {
    const localRuntime = requireLocalRuntime(runtime);
    const body = await readJsonObject(request);
    const result = await localRuntime.releaseEscrow({
      taskId: parts[1]!,
      verifierPubkey: requiredString(body, "verifierPubkey"),
      outcome: requiredString(body, "outcome"),
      proofUri: requiredString(body, "proofUri"),
    } satisfies ReleaseEscrowInput);
    sendJson(response, 200, result);
    return;
  }

  if (method === "POST" && url.pathname === "/direct-payments") {
    const localRuntime = requireLocalRuntime(runtime);
    const body = await readJsonObject(request);
    const result = await localRuntime.directPayment({
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
    const localRuntime = requireLocalRuntime(runtime);
    const taskId = url.searchParams.get("taskId") ?? undefined;
    const result = await localRuntime.reconcilePayment(taskId);
    sendJson(response, 200, result);
    return;
  }

  if (method === "POST" && url.pathname === "/services") {
    const localRuntime = requireLocalRuntime(runtime);
    const body = await readJsonObject(request);
    const result = await localRuntime.registerService({
      agentId: requiredString(body, "agentId"),
      serviceType: requiredString(body, "serviceType"),
      description: requiredString(body, "description"),
      price: requiredString(body, "price"),
    });
    sendJson(response, 201, result);
    return;
  }

  if (method === "GET" && url.pathname === "/services") {
    const localRuntime = requireLocalRuntime(runtime);
    const serviceType = url.searchParams.get("serviceType") ?? undefined;
    const result = await localRuntime.listServices({ serviceType });
    sendJson(response, 200, result);
    return;
  }

  if (method === "POST" && url.pathname === "/agent-runs") {
    const body = await readJsonObject(request);
    if (settlementMode === "solana-rpc-control-plane") {
      const client = requireSolanaClient(solanaClient);
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
      sendJson(response, 201, {
        ...result,
        settlementBoundary: "Agent decisions produced wallet-ready Solana transaction phases. No SQLite payment state was mutated.",
      });
      return;
    }
    const localRuntime = requireLocalRuntime(runtime);
    const result = await runAgentDemo({
      runtime: localRuntime,
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
      "POST /solana/services/register-plan",
      "POST /solana/services/deactivate-plan",
      "POST /solana/direct-payments/plan",
      "POST /solana/bundles/execute",
    ],
  });
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
    const blockhash = await solanaClient.connection.getLatestBlockhash("confirmed");
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

function requireSolanaClient(solanaClient: AccuralSolanaClient | undefined) {
  if (!solanaClient) {
    throw new Error("Solana settlement mode is required for this route. Set ACCURAL_SETTLEMENT_MODE=solana or omit it for the default Solana mode.");
  }
  return solanaClient;
}

function requireLocalRuntime(runtime: AccuralRuntime | undefined) {
  if (!runtime) {
    throw new Error("This route uses the local SQLite control plane. Set ACCURAL_SETTLEMENT_MODE=local to enable it.");
  }
  return runtime;
}

function presentAgentAddresses(addresses: ReturnType<AccuralSolanaClient["deriveAgentAddresses"]>) {
  return {
    agentRegistry: addresses.agentRegistry.toBase58(),
    policyVault: addresses.policyVault.toBase58(),
    agentReputation: addresses.agentReputation.toBase58(),
  };
}

function presentTaskAddresses(addresses: ReturnType<AccuralSolanaClient["deriveTaskAddresses"]>) {
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
    ...(selected.beneficiaryTokenAccount.equals(canonical.beneficiaryTokenAccount)
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

function directPaymentTokenSetupPlans(
  client: AccuralSolanaClient,
  payer: PublicKey,
  canonical: ReturnType<AccuralSolanaClient["deriveDirectPaymentTokenAccounts"]>,
  selected: ReturnType<AccuralSolanaClient["deriveDirectPaymentTokenAccounts"]>,
  owners: {
    payerOwner: PublicKey;
    recipientOwner: PublicKey;
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
    ...(selected.recipientTokenAccount.equals(canonical.recipientTokenAccount)
      ? {
          setupRecipientTokenAccount: signedInstructionPlan(
            client,
            client.createAssociatedTokenAccountIx({
              payer,
              associatedTokenAccount: canonical.recipientTokenAccount,
              owner: owners.recipientOwner,
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

function requiredBundle(value: unknown): TransactionBundlePlan {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("bundle must be a transaction bundle object.");
  }
  const bundle = value as TransactionBundlePlan;
  if (typeof bundle.bundleId !== "string" || !Array.isArray(bundle.phases)) {
    throw new Error("bundle must include bundleId and phases.");
  }
  return bundle;
}

function requiredBundleSigners(bundle: TransactionBundlePlan) {
  return Array.from(new Set(bundle.phases.flatMap((phase) => phase.signerPubkeys)));
}

function loadConfiguredBackendSigners() {
  const paths = [
    process.env.ACCURAL_OWNER_KEYPAIR,
    process.env.ACCURAL_VERIFIER_KEYPAIR,
    ...(process.env.ACCURAL_EXTRA_SIGNER_KEYPAIRS?.split(";") ?? []),
  ]
    .map((item) => item?.trim())
    .filter((item): item is string => Boolean(item));
  const signers = new Map<string, Keypair>();
  for (const path of paths) {
    const signer = loadKeypair(path);
    signers.set(signer.publicKey.toBase58(), signer);
  }
  return signers;
}

function loadKeypair(path: string) {
  const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
  if (!Array.isArray(raw) || raw.some((item) => typeof item !== "number")) {
    throw new Error(`${path} must contain a Solana CLI keypair JSON array.`);
  }
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

function sendJson(response: ServerResponse, statusCode: number, payload: unknown) {
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
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) {
    throw new Error(`${key} must be an array of non-empty strings when provided.`);
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

function parseHash32(value: unknown, semanticFallback?: unknown) {
  if (typeof value !== "string" || !value.trim()) {
    return semanticReconciliationHash(semanticFallback ?? { generatedAt: new Date(0).toISOString() });
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
  const port = Number.parseInt(process.env.ACCURAL_BACKEND_PORT ?? "8787", 10);
  const host = process.env.ACCURAL_BACKEND_HOST ?? "127.0.0.1";
  const server = await createBackendServer();
  server.listen(port, host, () => {
    console.log(`Accural backend listening on http://${host}:${port}`);
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
