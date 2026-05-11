const state = {
  agentId: "campaign-coordinator",
  paymentIntentId: "",
  latestTaskId: "",
  verifierPubkey: "",
};

const $ = (selector) => document.querySelector(selector);

const elements = {
  healthDot: $("#healthDot"),
  healthLabel: $("#healthLabel"),
  settlementMode: $("#settlementMode"),
  boundaryLabel: $("#boundaryLabel"),
  availableBudget: $("#availableBudget"),
  activeEscrow: $("#activeEscrow"),
  releasedSpend: $("#releasedSpend"),
  latestTask: $("#latestTask"),
  outputLog: $("#outputLog"),
  recordList: $("#recordList"),
  recordCount: $("#recordCount"),
  agentForm: $("#agentForm"),
  flowForm: $("#flowForm"),
  demoForm: $("#demoForm"),
  reconcileTaskId: $("#reconcileTaskId"),
};

function formValue(form, name) {
  const value = new FormData(form).get(name);
  return typeof value === "string" ? value.trim() : "";
}

function checkboxValue(form, name) {
  return new FormData(form).get(name) === "on";
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      "content-type": "application/json",
      ...(options.headers ?? {}),
    },
  });
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload.error ?? JSON.stringify(payload));
  }
  return payload;
}

function log(title, payload) {
  elements.outputLog.textContent = `${title}\n${JSON.stringify(payload, null, 2)}`;
}

function setBusy(button, busy) {
  if (!button) {
    return;
  }
  button.disabled = busy;
  button.dataset.label ??= button.textContent;
  button.textContent = busy ? "Working..." : button.dataset.label;
}

function setHealth(ok, label, detail) {
  elements.healthDot.classList.toggle("ready", ok);
  elements.healthDot.classList.toggle("error", !ok);
  elements.healthLabel.textContent = label;
  elements.settlementMode.textContent = detail;
}

async function refreshStatus() {
  try {
    const health = await api("/health");
    const settlement = await api("/settlement/status");
    setHealth(Boolean(health.ok), "Backend ready", settlement.settlementMode);
    elements.boundaryLabel.textContent = health.settlementBoundary;
    log("Backend status", { health, settlement });
  } catch (error) {
    setHealth(false, "Backend unavailable", error.message);
    elements.boundaryLabel.textContent = "Start the backend to use the console";
  }
}

async function loadBalance(agentId = state.agentId) {
  if (!agentId) {
    return;
  }
  const balance = await api(`/agents/${encodeURIComponent(agentId)}/balance`);
  elements.availableBudget.textContent = `${balance.availableBudget} ${balance.asset}`;
  elements.activeEscrow.textContent = `${balance.activeEscrow} ${balance.asset}`;
  elements.releasedSpend.textContent = `${balance.releasedSpend} ${balance.asset}`;
  log("Agent balance", balance);
}

async function createAgentAndPolicy() {
  const form = elements.agentForm;
  const agentId = formValue(form, "agentId");
  state.agentId = agentId;
  const agent = await api("/agents", {
    method: "POST",
    body: JSON.stringify({ agentId }),
  });
  const policy = await api("/policies", {
    method: "POST",
    body: JSON.stringify({
      agentId,
      sessionBudget: formValue(form, "sessionBudget"),
      maxPerTransaction: formValue(form, "maxPerTransaction"),
      approvalRequiredAbove: formValue(form, "approvalRequiredAbove"),
    }),
  });
  await loadBalance(agentId);
  log("Created agent and policy", { agent, policy });
}

function flowBody(paymentIntentId) {
  const form = elements.flowForm;
  return {
    agentId: formValue(elements.agentForm, "agentId"),
    taskId: formValue(form, "taskId"),
    amount: formValue(form, "amount"),
    beneficiaryPubkey: formValue(form, "beneficiaryPubkey"),
    verifierPubkey: formValue(form, "verifierPubkey"),
    purpose: formValue(form, "purpose"),
    proofUri: formValue(form, "proofUri"),
    humanApproved: checkboxValue(form, "humanApproved"),
    paymentIntentId,
  };
}

async function requestIntentOnly() {
  const body = flowBody("");
  state.agentId = body.agentId;
  const intent = await api("/payment-intents", {
    method: "POST",
    body: JSON.stringify({
      requesterAgentId: body.agentId,
      taskId: body.taskId,
      amount: body.amount,
      recipientPubkey: body.beneficiaryPubkey,
      purpose: body.purpose,
    }),
  });
  state.paymentIntentId = intent.intentId;
  state.latestTaskId = body.taskId;
  state.verifierPubkey = body.verifierPubkey;
  elements.latestTask.textContent = body.taskId;
  elements.reconcileTaskId.value = body.taskId;
  log("Payment intent requested", intent);
}

async function runEscrowFlow() {
  await requestIntentOnly();
  const body = flowBody(state.paymentIntentId);
  const escrow = await api("/escrows", {
    method: "POST",
    body: JSON.stringify({
      payerAgentId: body.agentId,
      taskId: body.taskId,
      amount: body.amount,
      purpose: body.purpose,
      beneficiaryPubkey: body.beneficiaryPubkey,
      verifierPubkey: body.verifierPubkey,
      paymentIntentId: body.paymentIntentId,
      humanApproved: body.humanApproved,
    }),
  });
  const release = await api(`/escrows/${encodeURIComponent(body.taskId)}/release`, {
    method: "POST",
    body: JSON.stringify({
      verifierPubkey: body.verifierPubkey,
      outcome: "Verifier accepted the delivered artifact.",
      proofUri: body.proofUri,
    }),
  });
  await loadBalance(body.agentId);
  const reconciliation = await loadReconciliation(body.taskId, false);
  log("Escrow flow complete", { intentId: state.paymentIntentId, escrow, release, reconciliation });
}

async function runDemo() {
  const form = elements.demoForm;
  const taskId = formValue(form, "taskId");
  const result = await api("/agent-runs", {
    method: "POST",
    body: JSON.stringify({
      mode: "deterministic",
      goal: {
        goal: formValue(form, "goal"),
        budget: formValue(form, "budget"),
        taskId,
      },
    }),
  });
  state.agentId = result.plan.agentId;
  state.latestTaskId = taskId;
  elements.agentForm.elements.agentId.value = result.plan.agentId;
  elements.flowForm.elements.taskId.value = taskId;
  elements.reconcileTaskId.value = taskId;
  elements.latestTask.textContent = taskId;
  updateBalanceMetrics(result.accural.finalBalance);
  renderRecords(result.accural.reconciliation);
  log("Deterministic agent run", result);
}

function updateBalanceMetrics(balance) {
  if (!balance) {
    return;
  }
  elements.availableBudget.textContent = `${balance.availableBudget} ${balance.asset}`;
  elements.activeEscrow.textContent = `${balance.activeEscrow} ${balance.asset}`;
  elements.releasedSpend.textContent = `${balance.releasedSpend} ${balance.asset}`;
}

async function loadReconciliation(taskId = elements.reconcileTaskId.value.trim(), shouldLog = true) {
  const path = taskId ? `/reconciliation?taskId=${encodeURIComponent(taskId)}` : "/reconciliation";
  const records = await api(path);
  renderRecords(records);
  if (shouldLog) {
    log("Reconciliation records", records);
  }
  return records;
}

function renderRecords(records) {
  elements.recordCount.textContent = `${records.length} ${records.length === 1 ? "record" : "records"}`;
  elements.recordList.replaceChildren();
  if (records.length === 0) {
    const empty = document.createElement("p");
    empty.className = "empty-state";
    empty.textContent = "No reconciliation records yet.";
    elements.recordList.append(empty);
    return;
  }

  for (const record of records) {
    const item = document.createElement("article");
    item.className = "record";
    const title = document.createElement("strong");
    title.textContent = `${record.eventType} - ${record.amount} ${record.asset}`;
    const task = document.createElement("span");
    task.textContent = `Task: ${record.taskId}`;
    const outcome = document.createElement("span");
    outcome.textContent = `Outcome: ${record.outcome}`;
    const hash = document.createElement("span");
    hash.textContent = `Hash: ${record.semanticHash ?? "pending"}`;
    item.append(title, task, outcome, hash);
    elements.recordList.append(item);
  }
}

async function handleAction(button, action) {
  setBusy(button, true);
  try {
    await action();
  } catch (error) {
    log("Request failed", { error: error.message });
  } finally {
    setBusy(button, false);
  }
}

$("#refreshStatus").addEventListener("click", (event) => {
  handleAction(event.currentTarget, refreshStatus);
});

$("#loadBalance").addEventListener("click", (event) => {
  const agentId = formValue(elements.agentForm, "agentId");
  handleAction(event.currentTarget, () => loadBalance(agentId));
});

$("#requestIntent").addEventListener("click", (event) => {
  handleAction(event.currentTarget, requestIntentOnly);
});

$("#loadReconciliation").addEventListener("click", (event) => {
  handleAction(event.currentTarget, () => loadReconciliation());
});

$("#clearLog").addEventListener("click", () => {
  elements.outputLog.textContent = "Ready.";
});

elements.agentForm.addEventListener("submit", (event) => {
  event.preventDefault();
  handleAction(event.submitter, createAgentAndPolicy);
});

elements.flowForm.addEventListener("submit", (event) => {
  event.preventDefault();
  handleAction(event.submitter, runEscrowFlow);
});

elements.demoForm.addEventListener("submit", (event) => {
  event.preventDefault();
  handleAction(event.submitter, runDemo);
});

refreshStatus();
