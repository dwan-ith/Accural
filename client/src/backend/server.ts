import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { AccuralRuntime, type CreateEscrowInput, type ReleaseEscrowInput, type RequestPaymentInput, type SetPolicyInput } from "../protocol.js";
import { runAgentDemo } from "../agents/run.js";
import type { AgentMode, CampaignGoal } from "../agents/types.js";

type JsonObject = Record<string, unknown>;

export type BackendServerOptions = {
  runtime?: AccuralRuntime;
};

export async function createBackendServer(options: BackendServerOptions = {}): Promise<Server> {
  const runtime = options.runtime ?? new AccuralRuntime();
  await runtime.initialize();
  const settlementMode = "local-sqlite-control-plane";

  return createServer((request, response) => {
    handleRequest(request, response, runtime, settlementMode).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : "Unknown backend error.";
      sendJson(response, 400, { error: message });
    });
  });
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  runtime: AccuralRuntime,
  settlementMode: string,
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
      settlementBoundary:
        "This HTTP service drives the local SQLite runtime. Real settlement is the Anchor program/local-validator path.",
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

  if (method === "GET" && parts.length === 3 && parts[0] === "agents" && parts[2] === "balance") {
    const result = await runtime.getBalance({ agentId: parts[1]! });
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

  if (method === "POST" && parts.length === 3 && parts[0] === "escrows" && parts[2] === "release") {
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

  if (method === "GET" && url.pathname === "/reconciliation") {
    const taskId = url.searchParams.get("taskId") ?? undefined;
    const result = await runtime.reconcilePayment(taskId);
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

  sendJson(response, 404, {
    error: "Route not found.",
    routes: [
      "GET /health",
      "POST /agents",
      "GET /agents/:agentId/balance",
      "POST /policies",
      "POST /payment-intents",
      "POST /escrows",
      "POST /escrows/:taskId/release",
      "GET /reconciliation?taskId=:taskId",
      "POST /agent-runs",
    ],
  });
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
