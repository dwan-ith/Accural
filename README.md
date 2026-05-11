# Accural

Accural is an agent-native financial coordination protocol for Solana. It is not a bank, wallet UI, or dashboard. It is the policy, payment-intent, escrow, settlement-proof, and reconciliation layer that lets AI agents coordinate money safely.

The MVP in this repo has three parts:

- `programs/accural`: the core Anchor protocol for agent registry, policy vaults, payment intents, task escrow, verifier release, and on-chain reconciliation hashes.
- `client`: one agent-facing interface for the protocol. It also keeps a deterministic local ledger plus semantic reconciliation index in SQLite for tests and demos.
- `client/src/backend`: the HTTP backend API for apps, agents, and observers that should call Accural over a normal service boundary instead of importing demo scripts.
- `client/src/agents`: actual AI-agent orchestration code that uses Accural. It supports deterministic mode for stable demos/tests and LLM mode for model-driven decisions.
- `client/src/solana`: reusable Solana transaction client code for PDA derivation, Anchor instruction construction, account decoding, and e2e settlement flow.

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
npm.cmd run agents:solana-plan
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

Before a demo, run the project-level verifier from the repo root:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\verify-mvp.ps1
```

Add `-IncludeSolanaStatus` when an RPC endpoint should be checked, and `-RunAgentSolanaE2E` when the Accural program is deployed and you want the full agent-planned on-chain proof path. The default verifier is intentionally local-only: Rust compile checks plus the TypeScript protocol/backend/agent/Solana-planning regression suite.

The agent layer also supports a Solana planning path through the backend. In that mode the agents still make the task, pricing, delivery, and verification decisions, but the output is a set of Anchor-compatible instructions plus signer pubkeys rather than SQLite state mutation.

You can generate that plan directly from the CLI with `npm.cmd run agents:solana-plan`. Set `ACCURAL_OWNER_PUBKEY`, `ACCURAL_WORKER_PUBKEY`, `ACCURAL_VERIFIER_PUBKEY`, and `ACCURAL_MINT` when you want a plan for real wallets and a real mint. If token account env vars are omitted, Accural derives canonical associated token accounts and includes idempotent setup instructions for the payer, escrow PDA, and beneficiary.

To save only the executable transaction bundle from an agent plan:

```powershell
cd client
$env:ACCURAL_BUNDLE_PLAN_PATH=".\accural-bundle.json"
npm.cmd run agents:solana-plan
```

To execute a saved bundle against an RPC endpoint, provide Solana CLI keypair files for the required signers:

```powershell
cd client
$env:ACCURAL_RPC_URL="https://api.devnet.solana.com"
$env:ACCURAL_BUNDLE_PLAN_PATH=".\accural-bundle.json"
$env:ACCURAL_OWNER_KEYPAIR="C:\path\to\owner.json"
$env:ACCURAL_VERIFIER_KEYPAIR="C:\path\to\verifier.json"
npm.cmd run solana:execute-bundle
```

The executor validates the bundle, checks every phase has matching keypairs for required signer pubkeys, simulates each phase by default, submits each phase in order, and returns confirmed transaction signatures. Simulation can be disabled with `ACCURAL_SIMULATE_BEFORE_SEND=false`, but the default is intentionally safer because it surfaces Solana/Anchor logs before submission. It does not store keys or act as a custodial backend.

## Backend API

Run the backend:

```powershell
cd client
npm.cmd run backend:start
```

By default it listens on `http://127.0.0.1:8787`. Override with `ACCURAL_BACKEND_HOST` and `ACCURAL_BACKEND_PORT`.
The same server also serves the local operator console at `http://127.0.0.1:8787/`.

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
- `POST /agent-runs/solana-plan`
- `GET /settlement/status`
- `POST /solana/agents/initialize-plan`
- `POST /solana/policies/set-plan`
- `POST /solana/payment-intents/request-plan`
- `POST /solana/escrows/fund-plan`
- `POST /solana/escrows/release-plan`

`npm.cmd test` exercises the backend over real HTTP: create agent, set policy, request payment, fund escrow, release escrow, read reconciliation, run the deterministic local agent endpoint, and generate Solana transaction plans. This backend is the local service boundary; Solana settlement remains in the Anchor program and devnet/local-validator e2e path.

`GET /health` reports `settlementMode: "local-sqlite-control-plane"` by default so consumers do not confuse the HTTP demo backend with on-chain settlement. Set `ACCURAL_SETTLEMENT_MODE=solana` to make the backend expose Solana RPC/program readiness via `GET /settlement/status` and Solana instruction planning routes.

The `/solana/*-plan` routes do not hold private keys or submit transactions. They return signer pubkeys, derived PDA addresses, token account addresses, setup instructions where applicable, and Anchor-compatible instruction data/accounts so an external wallet, delegated signer, or agent runtime can sign and submit safely.

`POST /agent-runs/solana-plan` is the same idea at the agent level: it runs the deterministic or LLM agents, then returns the full setup-token-account, initialize-agent, set-policy, request-payment, fund-escrow, and release-escrow instruction sequence. It also includes a `transactionBundle` with ordered phases and required signers so a wallet, delegated signer, or execution service can submit the flow without guessing dependencies. This is not autonomous custody yet; it is the honest transaction-planning bridge between AI-agent decisions and Solana settlement.

Check Solana readiness before running e2e or bundle execution:

```powershell
cd client
$env:ACCURAL_RPC_URL="https://api.devnet.solana.com"
npm.cmd run solana:status
```

This verifies RPC reachability and whether the configured Accural program id is deployed and executable. The e2e scripts use the same readiness check so failures happen before minting tokens or submitting bundle phases.

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
npm.cmd run agent-solana:e2e
```

The TypeScript e2e script now uses `client/src/solana/accural-client.ts` instead of carrying one-off transaction construction inside the script. This is the beginning of the real Solana client layer that backend routes and agents can share.

`npm.cmd run agent-solana:e2e` is the preferred MVP proof path. It creates real owner, worker, and verifier keypairs, creates a test mint, funds the owner token account, lets the deterministic agents generate the transaction bundle, simulates and executes that bundle phase-by-phase, and verifies the resulting Anchor accounts, SPL token balances, paid payment intent, released escrow, and reconciliation hash.

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

The client mirrors the Anchor string and spend-policy limits before building instructions: agent IDs and task IDs must be at most 32 UTF-8 bytes, payment purposes at most 160 bytes, proof URIs at most 200 bytes, amounts must be positive, proposals must fit within `maxPerTransaction` and session budget, and above-threshold proposals require explicit `humanApproved`. This prevents LLM-generated plans from reaching a wallet when the on-chain program would reject them anyway.
