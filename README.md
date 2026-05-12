# Accural

Accural is a Solana-native coordination layer for AI agents that need to move money with policy, task context, escrow, and reconciliation attached.

It is not a bank, wallet UI, or custodial backend. The core product is the Anchor program plus the TypeScript settlement client that turns agent decisions into auditable Solana transactions.

## Status

Current MVP coverage:

- Agent registry PDAs
- On-chain spend policies
- On-chain payment intents
- On-chain task escrow backed by SPL tokens
- Verifier-controlled escrow release
- On-chain reconciliation hash records
- Agent reputation counters
- Service listing and direct-payment instruction planning
- Deterministic and LLM-driven agent orchestration
- Backend routes for Solana transaction planning
- Bundle execution against Solana RPC with configured signer keypair files

What is not production-complete yet:

- No audited program release
- No production key-management or delegated-authority system
- No hosted reconciliation indexer
- No compliance or risk engine
- No dispute arbitration beyond the configured verifier account

The default backend mode is Solana planning. SQLite remains available for deterministic local tests and demos only.

## Repository Layout

- `programs/accural`: Anchor program for registry, policy, payment intents, escrow, direct payments, service listings, reputation, and reconciliation records.
- `client/src/solana`: TypeScript Solana client for PDA derivation, Anchor-compatible instruction encoding, account decoding, bundle planning, simulation, and execution.
- `client/src/agents`: Deterministic and LLM-backed agents that produce Accural payment/escrow flows.
- `client/src/backend`: HTTP API for apps and agents. In Solana mode it returns wallet-ready instructions and can execute signed bundles using configured local signer files.
- `client/src/protocol.ts` and `client/src/db.ts`: local SQLite control plane used by tests and offline demos.
- `scripts`: verification and validator helpers.

## Install

```powershell
cd client
npm.cmd install
```

The Rust/Anchor program builds from the repository root:

```powershell
cargo check
```

## Verify

Run the full local verification suite:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\verify-mvp.ps1
```

That runs:

- `cargo check`
- TypeScript type-check/build
- protocol tests
- agent tests
- backend tests
- Solana client and bundle tests

To also check the configured Solana RPC/program deployment:

```powershell
$env:ACCURAL_RPC_URL="https://api.devnet.solana.com"
powershell -ExecutionPolicy Bypass -File .\scripts\verify-mvp.ps1 -IncludeSolanaStatus
```

## Settlement Modes

Accural supports two explicit runtime modes.

`solana-rpc-control-plane` is the default. The backend derives PDAs, builds Anchor-compatible instructions, returns transaction bundles, and can submit bundles when signer keypair files are configured.

`local-sqlite-control-plane` is a deterministic local runtime for tests and offline demos. It exercises the same policy/intent/escrow/reconciliation semantics but does not settle on-chain.

Set the mode with:

```powershell
$env:ACCURAL_SETTLEMENT_MODE="solana" # default
$env:ACCURAL_SETTLEMENT_MODE="local"  # local SQLite demo mode
```

Set the RPC endpoint with:

```powershell
$env:ACCURAL_RPC_URL="https://api.devnet.solana.com"
```

## Backend

Start the backend:

```powershell
cd client
npm.cmd run backend:start
```

Health and readiness:

- `GET /health`
- `GET /settlement/status`

Local SQLite routes:

- `POST /agents`
- `GET /agents/:agentId/balance`
- `GET /agents/:agentId/reputation`
- `POST /policies`
- `POST /payment-intents`
- `POST /escrows`
- `POST /escrows/:taskId/release`
- `POST /direct-payments`
- `GET /reconciliation?taskId=:taskId`
- `POST /services`

Solana planning routes:

- `POST /solana/agents/initialize-plan`
- `POST /solana/policies/set-plan`
- `POST /solana/payment-intents/request-plan`
- `POST /solana/escrows/fund-plan`
- `POST /solana/escrows/release-plan`
- `POST /solana/services/register-plan`
- `POST /solana/services/deactivate-plan`
- `POST /solana/direct-payments/plan`
- `POST /agent-runs`
- `POST /agent-runs/solana-plan`

In Solana mode, `POST /agent-runs` returns an agent-generated transaction bundle instead of mutating SQLite state.

## Bundle Execution

Accural transaction bundles are ordered phases with explicit signer pubkeys. They can be executed from the CLI:

```powershell
cd client
$env:ACCURAL_RPC_URL="https://api.devnet.solana.com"
$env:ACCURAL_BUNDLE_PLAN_PATH=".\accural-bundle.json"
$env:ACCURAL_OWNER_KEYPAIR="C:\path\to\owner.json"
$env:ACCURAL_VERIFIER_KEYPAIR="C:\path\to\verifier.json"
npm.cmd run solana:execute-bundle
```

The backend can also execute a submitted bundle through `POST /solana/bundles/execute`. It does not accept private keys in the request. It only uses signer keypair files configured in environment variables:

```powershell
$env:ACCURAL_OWNER_KEYPAIR="C:\path\to\owner.json"
$env:ACCURAL_VERIFIER_KEYPAIR="C:\path\to\verifier.json"
$env:ACCURAL_EXTRA_SIGNER_KEYPAIRS="C:\path\to\other.json;C:\path\to\another.json"
```

Execution validates the bundle, checks signer coverage, simulates each phase by default, submits transactions in order, and returns confirmed signatures. Disable simulation only when you understand the failure mode:

```powershell
$env:ACCURAL_SIMULATE_BEFORE_SEND="false"
```

## Agent Flow

Generate a deterministic agent Solana plan:

```powershell
cd client
npm.cmd run agents:solana-plan
```

Provide real wallet and mint addresses:

```powershell
$env:ACCURAL_OWNER_PUBKEY="..."
$env:ACCURAL_WORKER_PUBKEY="..."
$env:ACCURAL_VERIFIER_PUBKEY="..."
$env:ACCURAL_MINT="..."
npm.cmd run agents:solana-plan
```

Run LLM mode:

```powershell
$env:OPENAI_API_KEY="..."
npm.cmd run agents:solana-plan:llm
```

Deterministic mode is recommended for tests and demos. LLM mode uses the same policy and Anchor instruction constraints, so invalid spend plans are rejected before wallet submission.

## Devnet Deployment

Build and deploy the program:

```powershell
solana config set --url devnet
cargo-build-sbf --manifest-path programs\accural\Cargo.toml --sbf-out-dir target\deploy
solana program deploy target\deploy\accural.so
```

Run on-chain e2e checks:

```powershell
cd client
$env:ACCURAL_RPC_URL="https://api.devnet.solana.com"
npm.cmd run solana:e2e
npm.cmd run agent-solana:e2e
```

`agent-solana:e2e` creates test participants, creates a test mint, lets the deterministic agents produce the transaction bundle, executes it phase by phase, and verifies the resulting Anchor accounts and SPL token balances.

## Local Validator

The local validator helper is available, but devnet is the preferred proof path on Windows because native validator ledger creation can fail depending on filesystem permissions.

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\run-local-validator-e2e.ps1
```

The script builds the SBF program, starts `solana-test-validator` with the Accural program loaded, waits for RPC readiness, runs `npm.cmd run solana:e2e`, and tears the validator down.

## Design Boundaries

Accural does not custody production funds by default. The safe production direction is delegated SPL authority, multisig policy control, or an external wallet/agent runtime that signs bundles after inspecting them.

The on-chain source of truth is:

1. `AgentRegistry`: agent identity controlled by the owner signer.
2. `PolicyVault`: session budget, per-transaction limit, approval threshold, and allowed action bitmask.
3. `PaymentIntent`: agent-readable request for a specific task, amount, mint, recipient, purpose, and expiry.
4. `EscrowAccount`: SPL-token escrow tied to a matching payment intent.
5. `ReconciliationRecord`: on-chain hash of semantic payment memory.
6. `AgentReputation`: completed task count and volume.

The off-chain layer may store richer reconciliation text, task metadata, proofs, and agent transcripts. Only the hash belongs on-chain.
