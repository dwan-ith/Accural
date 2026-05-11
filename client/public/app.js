const state = {
  agentId: "campaign-coordinator",
  paymentIntentId: "",
  latestTaskId: "",
  verifierPubkey: "",
};

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => document.querySelectorAll(selector);

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
  mainNav: $("#mainNav"),
};

// --- Helpers ---

function formatCurrency(amount) {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2
  }).format(amount).replace('$', '') + ' USDC';
}

function formValue(form, name) {
  const input = form.querySelector(`[name="${name}"]`);
  const value = new FormData(form).get(name);
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }
  return input?.placeholder || "";
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
  const timestamp = new Date().toLocaleTimeString();
  const entry = `[${timestamp}] ${title.toUpperCase()}\n${JSON.stringify(payload, null, 2)}\n\n`;
  elements.outputLog.textContent = entry + elements.outputLog.textContent;
  // Limit log size
  if (elements.outputLog.textContent.length > 10000) {
    elements.outputLog.textContent = elements.outputLog.textContent.substring(0, 10000);
  }
}

function setBusy(button, busy) {
  if (!button) return;
  button.disabled = busy;
  const icon = button.querySelector('i');

  if (busy) {
    button.dataset.originalContent = button.innerHTML;
    button.innerHTML = `<i data-lucide="loader-2" class="spin"></i> Working...`;
    lucide.createIcons();
  } else if (button.dataset.originalContent) {
    button.innerHTML = button.dataset.originalContent;
    lucide.createIcons();
  }
}

function setHealth(ok, label, detail) {
  elements.healthDot.classList.toggle("ready", ok);
  elements.healthDot.classList.toggle("error", !ok);
  elements.healthLabel.textContent = label;
  elements.settlementMode.textContent = detail;
}

// --- Navigation ---

function updateNav() {
  const hash = window.location.hash || '#overview';
  $$('#mainNav a').forEach(a => {
    a.classList.toggle('active', a.getAttribute('href') === hash);
  });
}

window.addEventListener('hashchange', updateNav);
updateNav();

// --- ScrollSpy ---

function initScrollSpy() {
  const sections = $$('section[id], article[id]');
  const navLinks = $$('#mainNav a');

  const options = {
    root: null,
    rootMargin: '-20% 0px -60% 0px',
    threshold: 0
  };

  const observer = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        const id = entry.target.getAttribute('id');
        navLinks.forEach(link => {
          link.classList.toggle('active', link.getAttribute('href') === `#${id}`);
        });
      }
    });
  }, options);

  sections.forEach(section => observer.observe(section));
}

initScrollSpy();

// --- API Actions ---

async function refreshStatus() {
  try {
    const health = await api("/health");
    const settlement = await api("/settlement/status");
    setHealth(Boolean(health.ok), "Node Operations Active", settlement.settlementMode);
    elements.boundaryLabel.textContent = health.settlementBoundary || "Live Network Connection";
    log("Status Sync", { health, settlement });
  } catch (error) {
    setHealth(false, "Node Unavailable", error.message);
    elements.boundaryLabel.textContent = "Start the backend to use the console";
  }
}

async function loadBalance(agentId = state.agentId) {
  if (!agentId) return;
  try {
    const balance = await api(`/agents/${encodeURIComponent(agentId)}/balance`);
    updateBalanceDisplay(balance);
    log("Balance Sync", balance);
  } catch (error) {
    log("Balance Fetch Failed", { error: error.message });
  }
}

function updateBalanceDisplay(balance) {
  if (!balance) return;
  elements.availableBudget.textContent = formatCurrency(balance.availableBudget);
  elements.activeEscrow.textContent = formatCurrency(balance.activeEscrow);
  elements.releasedSpend.textContent = formatCurrency(balance.releasedSpend);
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
      sessionBudget: parseFloat(formValue(form, "sessionBudget")),
      maxPerTransaction: parseFloat(formValue(form, "maxPerTransaction")),
      approvalRequiredAbove: parseFloat(formValue(form, "approvalRequiredAbove")),
    }),
  });

  await loadBalance(agentId);
  log("Provisioning Complete", { agent, policy });
}

async function requestIntentOnly() {
  const form = elements.flowForm;
  const body = {
    agentId: formValue(elements.agentForm, "agentId"),
    taskId: formValue(form, "taskId"),
    amount: parseFloat(formValue(form, "amount")),
    recipientPubkey: formValue(form, "beneficiaryPubkey"),
    purpose: formValue(form, "purpose"),
  };

  state.agentId = body.agentId;
  const intent = await api("/payment-intents", {
    method: "POST",
    body: JSON.stringify({
      requesterAgentId: body.agentId,
      taskId: body.taskId,
      amount: body.amount,
      recipientPubkey: body.recipientPubkey,
      purpose: body.purpose,
    }),
  });

  state.paymentIntentId = intent.intentId;
  state.latestTaskId = body.taskId;
  state.verifierPubkey = formValue(form, "verifierPubkey");
  elements.latestTask.textContent = body.taskId;
  elements.reconcileTaskId.value = body.taskId;
  log("Intent Registered", intent);
}

async function runEscrowFlow() {
  await requestIntentOnly();
  const form = elements.flowForm;
  const body = {
    agentId: formValue(elements.agentForm, "agentId"),
    taskId: formValue(form, "taskId"),
    amount: parseFloat(formValue(form, "amount")),
    purpose: formValue(form, "purpose"),
    beneficiaryPubkey: formValue(form, "beneficiaryPubkey"),
    verifierPubkey: formValue(form, "verifierPubkey"),
    proofUri: formValue(form, "proofUri"),
    humanApproved: checkboxValue(form, "humanApproved"),
  };

  const escrow = await api("/escrows", {
    method: "POST",
    body: JSON.stringify({
      payerAgentId: body.agentId,
      taskId: body.taskId,
      amount: body.amount,
      purpose: body.purpose,
      beneficiaryPubkey: body.beneficiaryPubkey,
      verifierPubkey: body.verifierPubkey,
      paymentIntentId: state.paymentIntentId,
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
  const records = await loadReconciliation(body.taskId, false);
  log("Pipeline Execution Complete", { intentId: state.paymentIntentId, escrow, release, recordsCount: records.length });
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
        budget: parseFloat(formValue(form, "budget")),
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

  updateBalanceDisplay(result.accural.finalBalance);
  renderRecords(result.accural.reconciliation);
  log("Orchestration Success", result);
}

async function loadReconciliation(taskId = elements.reconcileTaskId.value.trim(), shouldLog = true) {
  const path = taskId ? `/reconciliation?taskId=${encodeURIComponent(taskId)}` : "/reconciliation";
  const records = await api(path);
  renderRecords(records);
  if (shouldLog) {
    log("Audit Records Loaded", records);
  }
  return records;
}

function renderRecords(records) {
  elements.recordCount.textContent = `${records.length} ${records.length === 1 ? "record" : "records"}`;
  elements.recordList.replaceChildren();

  if (records.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = "No audit records found for current session.";
    elements.recordList.append(empty);
    return;
  }

  for (const record of records) {
    const item = document.createElement("article");
    item.className = "record";

    const title = document.createElement("strong");
    title.textContent = `${record.eventType} - ${record.amount} ${record.asset}`;

    const task = document.createElement("span");
    task.textContent = `Task Ref: ${record.taskId}`;

    const hash = document.createElement("span");
    hash.textContent = `Hash: ${record.semanticHash || "PENDING"}`;

    item.append(title, task, hash);
    elements.recordList.append(item);
  }
}

// --- Event Handlers ---

async function handleAction(button, action) {
  setBusy(button, true);
  try {
    await action();
  } catch (error) {
    log("Action Failed", { error: error.message });
  } finally {
    setBusy(button, false);
  }
}

$("#refreshStatus")?.addEventListener("click", (event) => {
  handleAction(event.currentTarget, refreshStatus);
});

$("#loadBalance")?.addEventListener("click", (event) => {
  const agentId = formValue(elements.agentForm, "agentId");
  handleAction(event.currentTarget, () => loadBalance(agentId));
});

$("#requestIntent")?.addEventListener("click", (event) => {
  handleAction(event.currentTarget, requestIntentOnly);
});

$("#loadReconciliation")?.addEventListener("click", (event) => {
  handleAction(event.currentTarget, () => loadReconciliation());
});

$("#clearLog")?.addEventListener("click", () => {
  elements.outputLog.textContent = "Protocol Logs Cleared.";
});

elements.agentForm?.addEventListener("submit", (event) => {
  event.preventDefault();
  handleAction(event.submitter, createAgentAndPolicy);
});

elements.flowForm?.addEventListener("submit", (event) => {
  event.preventDefault();
  handleAction(event.submitter, runEscrowFlow);
});

elements.demoForm?.addEventListener("submit", (event) => {
  event.preventDefault();
  handleAction(event.submitter, runDemo);
});

// --- Init ---
refreshStatus();
if (window.lucide) {
  lucide.createIcons();
}

// Global styles for animations
const style = document.createElement('style');
style.textContent = `
  @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
  .spin { animation: spin 1s linear infinite; display: inline-block; }
`;
document.head.appendChild(style);
