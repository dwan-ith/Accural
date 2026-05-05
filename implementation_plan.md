# Accural: Crypto Stripe Link for AI Agents

## Part 1: The Full Stripe → Accural Mapping

Stripe is not one product. It's a suite. You said you want the crypto version of **all of this**. Here's the honest mapping:

| Stripe Product | What It Does | Accural Equivalent | Status |
|---|---|---|---|
| **Link** | Persistent payment identity across merchants | **Agent Registry** — persistent financial identity across protocols | ✅ Exists (PDA + SQLite) |
| **Link Wallet for Agents** | OAuth-delegated spending, one-time virtual cards, scoped permissions | **PolicyVault + Escrow-as-token** — policy-scoped delegation, each escrow is a one-time purpose-bound payment | ✅ Exists |
| **Issuing for Agents** | Programmatic card creation, spending controls, transaction monitoring | **PolicyVault + Reconciliation** — programmatic spend rules, full semantic audit trail | ✅ Exists |
| **Checkout / Payment Links** | One-click payment acceptance | **Payment Intents** — structured agent-readable payment requests | ✅ Exists |
| **Connect** | Multi-party payments, revenue splits, marketplace payouts | **Revenue Splitter** — automatic split on escrow release | ❌ Missing |
| **Radar** | Fraud detection via network data | **Reputation Engine** — trust scoring from reconciliation history | ❌ Missing |
| **Elements** | Embeddable UI components | **MCP Tools** — embeddable financial primitives for any AI model | ✅ Exists |
| **Terminal** | In-person payments | **Direct Payments** — policy-checked instant transfers (no escrow overhead) | ❌ Missing |
| **Billing / Subscriptions** | Recurring charges | **Streaming Payments** — recurring budget allocations for ongoing agent services | ❌ Missing |
| **Treasury** | Business financial accounts | **Agent Budget Vaults** — segregated USDC pools per agent/task | ⚠️ Partial (escrow exists, no general vault) |
| **Identity** | KYC / document verification | **Agent Discovery + Reputation** — on-chain verifiable identity + task history | ❌ Missing |
| **Financial Connections** | Linked bank account data | **x402 Facilitator** — bridge to HTTP 402 agent payment standard | ❌ Missing |
| **Sigma / Data Pipeline** | Custom reporting, data sync | **Reconciliation Query API** — semantic financial memory queries | ✅ Exists |

### The Three Missing Pieces That Make Link "Link"

**1. Network Effect (Discovery)** — Stripe Link works because any merchant using Stripe automatically has Link. Accural needs: any agent registering a service is automatically discoverable by buyer agents.

**2. Trust Accumulation (Reputation)** — Stripe Radar gets better with every transaction across the network. Accural needs: every completed task builds verifiable reputation that other agents can query.

**3. Low-Friction Payments (Direct Pay)** — Not everything is an escrow. Stripe Link's one-click buy needs an equivalent: policy-checked instant transfer for micropayments.

---

## Part 2: Code Audit — Real Bugs and Slop

I read every file. Here's what I found.

### 🔴 Actual Bugs

| File | Issue |
|---|---|
| [solana-e2e.ts:388-405](file:///home/apps/Documents/Accural/client/src/solana-e2e.ts#L388-L405) | `fetchPolicy` decoder reads fields via side-effect closures and **hardcodes `version: 0n`** instead of reading the actual on-chain value. The closure reads `approval_required_above` and discards it. If you ever assert on version or approval threshold in e2e tests, they'll silently pass with wrong data. |
| [solana-e2e.ts:429-448](file:///home/apps/Documents/Accural/client/src/solana-e2e.ts#L429-L448) | `fetchEscrow` decoder skips 4 pubkeys in a closure to reach `beneficiary`, but the skip count is wrong — it skips `mint`, `escrowTokenAccount`, `paymentIntent`, and reads `beneficiary` as the 4th. That's actually `beneficiary` since the struct has those 3 fields before it. But `verifier` is then read as the next pubkey. Then `policyVersion` is read as u64 and discarded, and `status` is read. **The skip-and-discard pattern means any struct change silently corrupts all decoded values.** |
| [solana-e2e.ts:407-427](file:///home/apps/Documents/Accural/client/src/solana-e2e.ts#L407-L427) | `fetchPaymentIntent` same fragile closure pattern. `recipient` is read by skipping `mint` first, which is correct for the struct layout, but the pattern is unmaintainable. |
| [idl.ts:1](file:///home/apps/Documents/Accural/client/src/idl.ts#L1) | `export type Accural = any;` — the IDL type is `any`, defeating all TypeScript safety. The entire IDL is a hand-written object literal, not generated from Anchor. If the program changes, the IDL silently diverges. |
| [agents/types.ts:43-53](file:///home/apps/Documents/Accural/client/src/agents/types.ts#L43-L53) | `AgentRunResult.accural` types every field as `unknown`. All test assertions require `as` casts like `(result.accural.reconciliation as unknown[]).length`. This hides real type errors. |

### 🟡 Design Slop

| File | Issue |
|---|---|
| [package.json:2](file:///home/apps/Documents/Accural/client/package.json#L2) | Package name is `"mcp"` not `"accural"`. |
| [index.ts:7](file:///home/apps/Documents/Accural/client/src/index.ts#L7) | Top-level `await runtime.initialize()` runs DB init at module load time. Any import triggers SQLite creation. |
| [db.ts:193-221](file:///home/apps/Documents/Accural/client/src/db.ts#L193-L221) | `migrateLegacyTables` renames old tables to `${name}_legacy_${Date.now()}`. Multiple runs create unbounded legacy tables. No cleanup. |
| [protocol.ts:70](file:///home/apps/Documents/Accural/client/src/protocol.ts#L70) | `AccuralRuntime` generates a new `sessionOwner` keypair on every instantiation. No persistence. The "owner" identity is ephemeral — every server restart creates a new owner. |
| [agents/agents.ts:48](file:///home/apps/Documents/Accural/client/src/agents/agents.ts#L48) | `SpecialistWorkerAgent.propose` accepts `recipientPubkey` but never uses it in deterministic mode. |
| [agents/run.ts:121-153](file:///home/apps/Documents/Accural/client/src/agents/run.ts#L121-L153) | `normalizePlan` and `normalizeProposal` cast LLM output with `as` and silently fall back to hardcoded values. If the LLM returns garbage, you get a "successful" run with default data and no error. |
| [llm.ts:23](file:///home/apps/Documents/Accural/client/src/agents/llm.ts#L23) | Default model is `"gpt-5.2"` — may not exist for all users. Should be configurable with a real default. |
| [backend/server.ts](file:///home/apps/Documents/Accural/client/src/backend/server.ts) | No request body size limit. No rate limiting. No authentication. Fine for demo, but the code doesn't document these as intentional omissions. |
| [money.ts:6-15](file:///home/apps/Documents/Accural/client/src/money.ts#L6-L15) | `parseUsdcAmount` silently rejects negative amounts via regex but the error message says "non-negative" — misleading since it also rejects empty strings, leading spaces, etc. |
| [lib.rs](file:///home/apps/Documents/Accural/programs/accural/src/lib.rs) | No `cancel_escrow` / `refund_escrow` instruction. Once funded, escrow can only be released. If the verifier disappears, funds are locked forever. |
| [lib.rs](file:///home/apps/Documents/Accural/programs/accural/src/lib.rs) | No `cancel_payment_intent` instruction. Expired intents stay on-chain consuming rent forever. |
| dotenv | Listed as a dependency but never imported anywhere. Dead weight. |

### 🟢 What's Actually Solid

| Component | Assessment |
|---|---|
| [lib.rs](file:///home/apps/Documents/Accural/programs/accural/src/lib.rs) Anchor program | Core instructions are correctly implemented. PDA derivation is sound. Policy enforcement is on-chain. SPL token transfers are properly CPI'd. PaymentIntent → Escrow binding is tight. |
| [protocol.ts](file:///home/apps/Documents/Accural/client/src/protocol.ts) policy enforcement | Correctly mirrors on-chain logic. Dual enforcement (app + chain) is the right architecture. |
| Reconciliation memory | Semantic hash, policy snapshot, purpose, outcome, proof URI — genuinely novel. No competitor has this. |
| Test coverage | 4 protocol tests + 2 agent tests + 2 backend tests. Not deep but covers the happy path and key rejection cases. |
| [money.ts](file:///home/apps/Documents/Accural/client/src/money.ts) | `parseUsdcAmount`/`formatUsdcAmount` correctly handle USDC's 6 decimal places without floating point. `canonicalJson` for deterministic hashing is correct. |

---

## Part 3: Build Plan

### Phase 0: Fix the Existing Code (Quality Pass)

> [!IMPORTANT]
> This must happen before adding features. The existing code has real bugs that will compound.

#### 0a. Fix the Solana E2E Decoders
Replace the fragile closure-based decoders in `solana-e2e.ts` with a proper named-field decoder that reads the struct sequentially and returns all fields. No more skip-and-discard.

#### 0b. Fix Types
- Replace `type Accural = any` in `idl.ts` with a proper typed IDL (or generate it from Anchor)
- Replace all `unknown` fields in `AgentRunResult.accural` with actual types
- Remove all `as` casts in tests — if the types are correct, casts aren't needed

#### 0c. Fix Package Identity
- Rename package from `"mcp"` to `"accural"`
- Remove unused `dotenv` dependency
- Fix LLM default model to something that exists

#### 0d. Add Missing Anchor Instructions
- `cancel_payment_intent` — owner can cancel unexpired intents, reclaim rent
- `refund_escrow` — owner can refund if escrow is funded but task is abandoned (with timelock or dispute mechanism)

#### 0e. Fix Runtime Lifecycle
- Don't run `initDb()` at module import time — make it explicit
- Make session owner configurable (load from env/file, not random on every start)

---

### Phase 1: Agent Discovery (The Network Layer)

This is the single most important addition. Without it there's no flywheel.

**On-chain (lib.rs):**
```
ServiceListing PDA = ["service", agent_registry, service_type]
  - agent_registry: Pubkey
  - service_type: String (max 32)
  - description: String (max 160)  
  - price_minor: u64
  - mint: Pubkey
  - active: bool
  - bump: u8
```

Instructions: `register_service`, `deactivate_service`

**Off-chain (protocol.ts + db.ts):**
- `services` table mirroring the on-chain data
- `registerService()` / `listServices(serviceType?)` / `getServiceAgent(agentId)` methods
- MCP tools: `register_service`, `list_services`, `get_service_agent`

**Backend routes:**
- `POST /services` — register
- `GET /services?type=research` — discover

---

### Phase 2: Direct Payments (Low-Friction Path)

Not every payment needs intent → escrow → verify → release. API calls, tips, reimbursements need a fast path.

**On-chain (lib.rs):**
```
direct_payment instruction:
  - Checks PolicyVault (budget, per-tx limit, allowed actions)
  - Transfers SPL tokens directly from payer to recipient  
  - Writes ReconciliationRecord with the payment hash
  - No escrow, no verifier
```

New action flag: `ACTION_DIRECT_PAYMENT = 1 << 3`

**Off-chain:** `directPayment()` method + MCP tool + backend route

---

### Phase 3: Reputation System (Trust Accumulation)

**On-chain (lib.rs):**
```
AgentReputation PDA = ["reputation", agent_registry]
  - agent_registry: Pubkey
  - tasks_completed: u32
  - tasks_disputed: u32  
  - total_volume_minor: u64
  - last_updated: i64
  - bump: u8
```

Updated on every `release_escrow` and `refund_escrow`. The `release_escrow` instruction increments `tasks_completed` and adds to `total_volume_minor`.

**Off-chain:** `getReputation(agentId)` method + MCP tool + backend route. Aggregates from reconciliation records for the local runtime.

---

### Phase 4: Revenue Splits (Connect Equivalent)

**On-chain (lib.rs):**
```
RevenueSplit PDA = ["split", escrow_account]
  - escrow: Pubkey
  - splits: Vec<SplitEntry> (max 8)
    - recipient: Pubkey  
    - basis_points: u16
  - executed: bool
  - bump: u8
```

On `release_escrow`, if a split exists, funds distribute proportionally instead of going to a single beneficiary.

**Off-chain:** `createRevenueSplit()` / `executeRevenueSplit()` methods + MCP tools

---

### Phase 5: x402 Compatibility (Bridge to Agent Payment Standard)

An HTTP middleware that:
1. Receives `402 Payment Required` challenges from external services
2. Parses the `PAYMENT-REQUIRED` header
3. Routes through Accural's PolicyVault for approval
4. Executes the payment via direct_payment
5. Returns the `PAYMENT-SIGNATURE` header

This makes Accural agents compatible with the emerging x402 ecosystem without changing their code.

---

## Open Questions

> [!IMPORTANT]
> ### 1. Scope for immediate work?
> Do you want me to execute Phase 0 (quality fixes) + Phase 1 (discovery) + Phase 2 (direct payments) now? Or do you want all 5 phases planned in detail first?

> [!IMPORTANT]
> ### 2. Escrow refund mechanism?
> Two options: (a) time-locked — escrow auto-refundable after N hours if not released, (b) owner-triggered — owner can call `refund_escrow` at any time. Which fits the agent coordination story better?

> [!IMPORTANT]
> ### 3. Discovery: on-chain or off-chain first?
> On-chain ServiceListing PDAs cost ~0.002 SOL rent each. For hackathon, we could start with off-chain SQLite discovery + on-chain identity verification, then migrate to fully on-chain later. Preference?

## Verification Plan

### Automated
- Fix all existing tests to pass without `as` casts
- Add tests for: cancel intent, refund escrow, direct payment, service discovery, reputation query
- Full agent demo loop with discovery: agent discovers service → negotiates → escrows → verifies → releases → reputation updates

### Manual  
- Deploy updated Anchor program to devnet
- Run the full demo end-to-end showing the Stripe Link parallel
