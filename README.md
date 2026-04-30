# Accural

Accural is an agent-native financial coordination protocol for Solana. It is not a bank, wallet UI, or dashboard. It is the policy, payment-intent, escrow, settlement-proof, and reconciliation layer that lets AI agents coordinate money safely.

The MVP in this repo has three parts:

- `programs/accural`: the core Anchor protocol for agent registry, policy vaults, payment intents, task escrow, verifier release, and on-chain reconciliation hashes.
- `client`: one agent-facing interface for the protocol. It also keeps a deterministic local ledger plus semantic reconciliation index in SQLite for tests and demos.
- `client/src/backend`: the HTTP backend API for apps, agents, and observers that should call Accural over a normal service boundary instead of importing demo scripts.
- `client/src/agents`: actual AI-agent orchestration code that uses Accural. It supports deterministic mode for stable demos/tests and LLM mode for model-driven decisions.

The product center is the protocol. The client provides a TypeScript SDK, an MCP server, and agents that call Accural.

## Agent Capabilities

- `create_agent_wallet`: creates an agent financial identity.
- `get_balance`: returns the policy budget, active escrow, released spend, and wallet identity for an agent.
- `set_spend_policy`: sets USDC-denominated session budget, per-transaction limits, approval threshold, and allowed actions.
- `request_payment`: creates an agent-readable payment intent. The Anchor program now has a first-class `request_payment` instruction/account for this primitive.
- `create_task_escrow`: checks policy and a required matching payment intent, locks task funds, and writes reconciliation memory.
- `release_escrow`: requires the verifier identity, releases task escrow, and records proof/outcome.
- `reconcile_payment`: returns semantic payment history for a task or all local records.

## Local Demo

```powershell
cd client
npm.cmd test
npm.cmd run demo
npm.cmd run agents:demo
```

`npm.cmd test` runs type-checking, compiles TypeScript, and executes policy/escrow/reconciliation plus agent-orchestration regression tests. `npm.cmd run agents:demo` executes a deterministic agent loop:

1. `campaign-coordinator` receives the user goal and budget.
2. `specialist-worker` proposes a priced task.
3. Accural creates identities, policy, payment intent, and escrow.
4. `specialist-worker` delivers an artifact URI.
5. `artifact-verifier` approves or rejects the delivery.
6. Accural releases escrow and returns reconciliation memory.

To run the same flow with LLM-backed agent decisions:

```powershell
cd client
$env:OPENAI_API_KEY = "..."
npm.cmd run agents:demo:llm
```

Set `ACCURAL_LLM_MODEL` to override the default model. Deterministic mode does not require an API key.

## Backend API

Run the backend:

```powershell
cd client
npm.cmd run backend:start
```

By default it listens on `http://127.0.0.1:8787`. Override with `ACCURAL_BACKEND_HOST` and `ACCURAL_BACKEND_PORT`.

Implemented routes:

- `GET /health`
- `POST /agents`
- `GET /agents/:agentId/balance`
- `POST /policies`
- `POST /payment-intents`
- `POST /escrows`
- `POST /escrows/:taskId/release`
- `GET /reconciliation?taskId=:taskId`
- `POST /agent-runs`

`npm.cmd test` exercises the backend over real HTTP: create agent, set policy, request payment, fund escrow, release escrow, read reconciliation, and run the deterministic agent endpoint. This backend is the local service boundary; Solana settlement remains in the Anchor program and local-validator e2e path.

`GET /health` reports `settlementMode: "local-sqlite-control-plane"` so consumers do not confuse the HTTP demo backend with on-chain settlement.

Build before running the MCP server:

```powershell
cd client
npm.cmd run build
node dist/index.js
```

Prefer `node dist/index.js` in MCP client configs. Running through `npm run start` can print npm lifecycle output before JSON-RPC on some systems, which is unsafe for stdio transports.

## Solana Deployment (Devnet Recommended)

Due to OS-level restrictions with `solana-test-validator` on Windows (specifically genesis archive extraction bugs and lockfile incompatibilities), we strongly recommend deploying the program directly to the **Solana Devnet** rather than relying on native local-validators.

1. Configure your local Solana CLI to target devnet:
```powershell
solana config set --url devnet
```
2. Build the Anchor program natively via `cargo-build-sbf`:
```powershell
cargo-build-sbf --manifest-path programs\accural\Cargo.toml --sbf-out-dir target\deploy
```
3. Deploy to devnet:
```powershell
solana program deploy target/deploy/accural.so
```
4. Run the TypeScript e2e tests pointing to devnet:
```powershell
cd client
$env:ACCURAL_RPC_URL="https://api.devnet.solana.com"
npm.cmd run solana:e2e
```

## Important Boundaries

The MCP local ledger is not pretending to be settlement. It exists so agents and tests can exercise Accural's policy, escrow, intent, and reconciliation semantics deterministically. Production Accural should not use MCP-server custody for agent funds.

The production path is:

1. Agent identity lives in `AgentRegistry`.
2. Spend rules live in `PolicyVault`.
3. Agent-readable payment requests live in `PaymentIntent`.
4. Task escrow must reference a matching `PaymentIntent` for the same task, amount, mint, recipient, and purpose.
5. Task funds move into a PDA-owned SPL token escrow account.
6. Verifier release transfers funds to the beneficiary and marks the intent paid.
7. Full semantic reconciliation lives off-chain, while its hash is anchored in `ReconciliationRecord`.
