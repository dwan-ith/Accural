import sqlite3 from "sqlite3";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dbPath = process.env.ACCURAL_DB_PATH ?? join(__dirname, "..", "reconciliation.db");
const db = new sqlite3.Database(dbPath);

export type AgentRecord = {
  agent_id: string;
  wallet_pubkey: string;
  owner_pubkey: string;
  created_at: string;
};

export type PolicyRecord = {
  agent_id: string;
  max_per_transaction_minor: string;
  session_budget_total_minor: string;
  session_budget_remaining_minor: string;
  approval_required_above_minor: string;
  allowed_actions_json: string;
  blocked_recipients_json: string;
  version: number;
  updated_at: string;
};

export type PaymentIntentRecord = {
  intent_id: string;
  task_id: string;
  requester_agent_id: string;
  recipient_pubkey: string;
  amount_minor: string;
  asset: string;
  purpose: string;
  expires_at: string;
  status: string;
  created_at: string;
};

export type EscrowRecord = {
  escrow_id: string;
  task_id: string;
  payer_agent_id: string;
  beneficiary_pubkey: string;
  verifier_pubkey: string;
  amount_minor: string;
  asset: string;
  purpose: string;
  payment_intent_id: string;
  status: string;
  created_at: string;
  released_at: string | null;
};

export type ReconciliationRecord = {
  record_id: string;
  transaction_signature: string;
  task_id: string;
  agent_id: string;
  event_type: string;
  amount_minor: string;
  asset: string;
  purpose: string;
  outcome: string;
  proof_uri: string | null;
  policy_snapshot_json: string;
  semantic_hash: string;
  created_at: string;
};

function run(sql: string, params: unknown[] = []) {
  return new Promise<{ changes: number; lastID: number }>((resolve, reject) => {
    db.run(sql, params, function onRun(err) {
      if (err) {
        reject(err);
      } else {
        resolve({ changes: this.changes, lastID: this.lastID });
      }
    });
  });
}

export async function withTransaction<T>(work: () => Promise<T>): Promise<T> {
  await run("BEGIN IMMEDIATE");
  try {
    const result = await work();
    await run("COMMIT");
    return result;
  } catch (error) {
    await run("ROLLBACK").catch(() => undefined);
    throw error;
  }
}

function get<T>(sql: string, params: unknown[] = []) {
  return new Promise<T | undefined>((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) {
        reject(err);
      } else {
        resolve(row as T | undefined);
      }
    });
  });
}

function all<T>(sql: string, params: unknown[] = []) {
  return new Promise<T[]>((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) {
        reject(err);
      } else {
        resolve(rows as T[]);
      }
    });
  });
}

export async function initDb() {
  await run("PRAGMA foreign_keys = ON");
  await migrateLegacyTables();
  await run(`
    CREATE TABLE IF NOT EXISTS agents (
      agent_id TEXT PRIMARY KEY,
      wallet_pubkey TEXT NOT NULL,
      owner_pubkey TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await run(`
    CREATE TABLE IF NOT EXISTS policies (
      agent_id TEXT PRIMARY KEY REFERENCES agents(agent_id) ON DELETE CASCADE,
      max_per_transaction_minor TEXT NOT NULL,
      session_budget_total_minor TEXT NOT NULL,
      session_budget_remaining_minor TEXT NOT NULL,
      approval_required_above_minor TEXT NOT NULL,
      allowed_actions_json TEXT NOT NULL,
      blocked_recipients_json TEXT NOT NULL DEFAULT '[]',
      version INTEGER NOT NULL,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await run(`
    CREATE TABLE IF NOT EXISTS payment_intents (
      intent_id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      requester_agent_id TEXT NOT NULL REFERENCES agents(agent_id) ON DELETE CASCADE,
      recipient_pubkey TEXT NOT NULL,
      amount_minor TEXT NOT NULL,
      asset TEXT NOT NULL,
      purpose TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await run(`
    CREATE TABLE IF NOT EXISTS escrows (
      escrow_id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL UNIQUE,
      payer_agent_id TEXT NOT NULL REFERENCES agents(agent_id) ON DELETE CASCADE,
      beneficiary_pubkey TEXT NOT NULL,
      verifier_pubkey TEXT NOT NULL,
      amount_minor TEXT NOT NULL,
      asset TEXT NOT NULL,
      purpose TEXT NOT NULL,
      payment_intent_id TEXT NOT NULL REFERENCES payment_intents(intent_id),
      status TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      released_at TEXT
    )
  `);
  await run(`
    CREATE TABLE IF NOT EXISTS reconciliation_records (
      record_id TEXT PRIMARY KEY,
      transaction_signature TEXT UNIQUE NOT NULL,
      task_id TEXT NOT NULL,
      agent_id TEXT NOT NULL REFERENCES agents(agent_id) ON DELETE CASCADE,
      event_type TEXT NOT NULL,
      amount_minor TEXT NOT NULL,
      asset TEXT NOT NULL,
      purpose TEXT NOT NULL,
      outcome TEXT NOT NULL,
      proof_uri TEXT,
      policy_snapshot_json TEXT NOT NULL,
      semantic_hash TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
}

async function migrateLegacyTables() {
  const requiredColumnsByTable: Record<string, string[]> = {
    agents: ["agent_id", "wallet_pubkey", "owner_pubkey"],
    policies: [
      "agent_id",
      "max_per_transaction_minor",
      "session_budget_total_minor",
      "session_budget_remaining_minor",
      "approval_required_above_minor",
      "allowed_actions_json",
      "blocked_recipients_json",
      "version",
    ],
    payment_intents: ["intent_id", "task_id", "requester_agent_id", "recipient_pubkey", "amount_minor"],
    escrows: ["escrow_id", "task_id", "payer_agent_id", "beneficiary_pubkey", "verifier_pubkey"],
    reconciliation_records: ["record_id", "transaction_signature", "task_id", "semantic_hash"],
  };

  for (const [tableName, requiredColumns] of Object.entries(requiredColumnsByTable)) {
    const columns = await tableColumns(tableName);
    if (columns.length === 0) {
      continue;
    }

    if (requiredColumns.some((column) => !columns.includes(column))) {
      await run(`ALTER TABLE ${tableName} RENAME TO ${tableName}_legacy_${Date.now()}`);
    }
  }
}

async function tableColumns(tableName: string) {
  const rows = await all<{ name: string }>(`PRAGMA table_info(${tableName})`);
  return rows.map((row) => row.name);
}

export async function upsertAgent(agent: {
  agent_id: string;
  wallet_pubkey: string;
  owner_pubkey: string;
}) {
  await run(
    `
      INSERT INTO agents (agent_id, wallet_pubkey, owner_pubkey)
      VALUES (?, ?, ?)
      ON CONFLICT(agent_id) DO UPDATE SET
        wallet_pubkey = excluded.wallet_pubkey,
        owner_pubkey = excluded.owner_pubkey
    `,
    [agent.agent_id, agent.wallet_pubkey, agent.owner_pubkey],
  );
  return getAgent(agent.agent_id);
}

export function getAgent(agentId: string) {
  return get<AgentRecord>("SELECT * FROM agents WHERE agent_id = ?", [agentId]);
}

export async function upsertPolicy(policy: {
  agent_id: string;
  max_per_transaction_minor: string;
  session_budget_total_minor: string;
  session_budget_remaining_minor: string;
  approval_required_above_minor: string;
  allowed_actions_json: string;
  blocked_recipients_json: string;
}) {
  const existing = await getPolicy(policy.agent_id);
  const nextVersion = existing ? existing.version + 1 : 1;
  await run(
    `
      INSERT INTO policies (
        agent_id,
        max_per_transaction_minor,
        session_budget_total_minor,
        session_budget_remaining_minor,
        approval_required_above_minor,
        allowed_actions_json,
        blocked_recipients_json,
        version,
        updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(agent_id) DO UPDATE SET
        max_per_transaction_minor = excluded.max_per_transaction_minor,
        session_budget_total_minor = excluded.session_budget_total_minor,
        session_budget_remaining_minor = excluded.session_budget_remaining_minor,
        approval_required_above_minor = excluded.approval_required_above_minor,
        allowed_actions_json = excluded.allowed_actions_json,
        blocked_recipients_json = excluded.blocked_recipients_json,
        version = excluded.version,
        updated_at = CURRENT_TIMESTAMP
    `,
    [
      policy.agent_id,
      policy.max_per_transaction_minor,
      policy.session_budget_total_minor,
      policy.session_budget_remaining_minor,
      policy.approval_required_above_minor,
      policy.allowed_actions_json,
      policy.blocked_recipients_json,
      nextVersion,
    ],
  );
  return getPolicy(policy.agent_id);
}

export function getPolicy(agentId: string) {
  return get<PolicyRecord>("SELECT * FROM policies WHERE agent_id = ?", [agentId]);
}

export async function createPaymentIntent(intent: Omit<PaymentIntentRecord, "created_at">) {
  await run(
    `
      INSERT INTO payment_intents (
        intent_id,
        task_id,
        requester_agent_id,
        recipient_pubkey,
        amount_minor,
        asset,
        purpose,
        expires_at,
        status
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    [
      intent.intent_id,
      intent.task_id,
      intent.requester_agent_id,
      intent.recipient_pubkey,
      intent.amount_minor,
      intent.asset,
      intent.purpose,
      intent.expires_at,
      intent.status,
    ],
  );
  return getPaymentIntent(intent.intent_id);
}

export function getPaymentIntent(intentId: string) {
  return get<PaymentIntentRecord>("SELECT * FROM payment_intents WHERE intent_id = ?", [intentId]);
}

export async function updatePaymentIntentStatus(intentId: string, status: string) {
  await run("UPDATE payment_intents SET status = ? WHERE intent_id = ?", [status, intentId]);
  return getPaymentIntent(intentId);
}

export async function createEscrow(escrow: Omit<EscrowRecord, "created_at" | "released_at">) {
  await run(
    `
      INSERT INTO escrows (
        escrow_id,
        task_id,
        payer_agent_id,
        beneficiary_pubkey,
        verifier_pubkey,
        amount_minor,
        asset,
        purpose,
        payment_intent_id,
        status
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    [
      escrow.escrow_id,
      escrow.task_id,
      escrow.payer_agent_id,
      escrow.beneficiary_pubkey,
      escrow.verifier_pubkey,
      escrow.amount_minor,
      escrow.asset,
      escrow.purpose,
      escrow.payment_intent_id,
      escrow.status,
    ],
  );
  return getEscrow(escrow.escrow_id);
}

export function getEscrow(escrowId: string) {
  return get<EscrowRecord>("SELECT * FROM escrows WHERE escrow_id = ?", [escrowId]);
}

export function getEscrowByTask(taskId: string) {
  return get<EscrowRecord>("SELECT * FROM escrows WHERE task_id = ?", [taskId]);
}

export function getEscrowsByAgent(agentId: string) {
  return all<EscrowRecord>(
    "SELECT * FROM escrows WHERE payer_agent_id = ? ORDER BY created_at ASC, escrow_id ASC",
    [agentId],
  );
}

export async function markEscrowReleased(escrowId: string) {
  await run(
    "UPDATE escrows SET status = 'RELEASED', released_at = CURRENT_TIMESTAMP WHERE escrow_id = ? AND status = 'FUNDED'",
    [escrowId],
  );
  return getEscrow(escrowId);
}

export async function insertReconciliationRecord(
  record: Omit<ReconciliationRecord, "created_at">,
) {
  await run(
    `
      INSERT INTO reconciliation_records (
        record_id,
        transaction_signature,
        task_id,
        agent_id,
        event_type,
        amount_minor,
        asset,
        purpose,
        outcome,
        proof_uri,
        policy_snapshot_json,
        semantic_hash
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    [
      record.record_id,
      record.transaction_signature,
      record.task_id,
      record.agent_id,
      record.event_type,
      record.amount_minor,
      record.asset,
      record.purpose,
      record.outcome,
      record.proof_uri,
      record.policy_snapshot_json,
      record.semantic_hash,
    ],
  );
  return getReconciliationRecord(record.record_id);
}

export function getReconciliationRecord(recordId: string) {
  return get<ReconciliationRecord>("SELECT * FROM reconciliation_records WHERE record_id = ?", [
    recordId,
  ]);
}

export function getRecordsByTask(taskId: string) {
  return all<ReconciliationRecord>(
    "SELECT * FROM reconciliation_records WHERE task_id = ? ORDER BY rowid ASC",
    [taskId],
  );
}

export function getAllRecords() {
  return all<ReconciliationRecord>(
    "SELECT * FROM reconciliation_records ORDER BY rowid ASC",
  );
}

export async function resetDemoState() {
  await run("DELETE FROM reconciliation_records");
  await run("DELETE FROM escrows");
  await run("DELETE FROM payment_intents");
  await run("DELETE FROM policies");
  await run("DELETE FROM agents");
}
