export type Accural = any;

export const IDL: Accural = {
  address: "HTVTUMeyRkpbakNASCQ44MzgjxKjrV5oG8rBSavMiPCS",
  metadata: { name: "accural", version: "0.1.0", spec: "0.1.0", address: "HTVTUMeyRkpbakNASCQ44MzgjxKjrV5oG8rBSavMiPCS" },
  version: "0.1.0",
  name: "accural",
  instructions: [
    {
      name: "initializeAgent",
      accounts: [
        { name: "owner", isMut: true, isSigner: true },
        { name: "agentRegistry", isMut: true, isSigner: false },
        { name: "policyVault", isMut: true, isSigner: false },
        { name: "systemProgram", isMut: false, isSigner: false }
      ],
      args: [{ name: "agentId", type: "string" }]
    },
    {
      name: "setPolicy",
      accounts: [
        { name: "owner", isMut: true, isSigner: true },
        { name: "agentRegistry", isMut: false, isSigner: false },
        { name: "policyVault", isMut: true, isSigner: false }
      ],
      args: [
        { name: "maxPerTransaction", type: "u64" },
        { name: "sessionBudget", type: "u64" },
        { name: "approvalRequiredAbove", type: "u64" },
        { name: "allowedActions", type: "u16" }
      ]
    },
    {
      name: "requestPayment",
      accounts: [
        { name: "owner", isMut: true, isSigner: true },
        { name: "agentRegistry", isMut: false, isSigner: false },
        { name: "policyVault", isMut: false, isSigner: false },
        { name: "paymentIntent", isMut: true, isSigner: false },
        { name: "systemProgram", isMut: false, isSigner: false }
      ],
      args: [
        { name: "taskId", type: "string" },
        { name: "amount", type: "u64" },
        { name: "mint", type: "publicKey" },
        { name: "recipient", type: "publicKey" },
        { name: "purpose", type: "string" },
        { name: "expiresAt", type: "i64" }
      ]
    },
    {
      name: "fundEscrow",
      accounts: [
        { name: "owner", isMut: true, isSigner: true },
        { name: "agentRegistry", isMut: false, isSigner: false },
        { name: "policyVault", isMut: true, isSigner: false },
        { name: "paymentIntent", isMut: true, isSigner: false },
        { name: "escrowAccount", isMut: true, isSigner: false },
        { name: "escrowTokenAccount", isMut: true, isSigner: false },
        { name: "payerTokenAccount", isMut: true, isSigner: false },
        { name: "mint", isMut: false, isSigner: false },
        { name: "beneficiary", isMut: false, isSigner: false },
        { name: "verifier", isMut: false, isSigner: false },
        { name: "systemProgram", isMut: false, isSigner: false },
        { name: "tokenProgram", isMut: false, isSigner: false }
      ],
      args: [
        { name: "taskId", type: "string" },
        { name: "amount", type: "u64" },
        { name: "purpose", type: "string" },
        { name: "humanApproved", type: "bool" }
      ]
    },
    {
      name: "releaseEscrow",
      accounts: [
        { name: "verifier", isMut: true, isSigner: true },
        { name: "policyVault", isMut: false, isSigner: false },
        { name: "paymentIntent", isMut: true, isSigner: false },
        { name: "escrowAccount", isMut: true, isSigner: false },
        { name: "escrowTokenAccount", isMut: true, isSigner: false },
        { name: "beneficiaryTokenAccount", isMut: true, isSigner: false },
        { name: "reconciliationRecord", isMut: true, isSigner: false },
        { name: "systemProgram", isMut: false, isSigner: false },
        { name: "tokenProgram", isMut: false, isSigner: false }
      ],
      args: [
        { name: "reconciliationHash", type: { array: ["u8", 32] } },
        { name: "outcomeCode", type: "u16" },
        { name: "proofUri", type: "string" }
      ]
    }
  ],
  accounts: [
    {
      name: "agentRegistry",
      type: {
        kind: "struct",
        fields: [
          { name: "owner", type: "publicKey" },
          { name: "agentId", type: "string" },
          { name: "bump", type: "u8" }
        ]
      }
    },
    {
      name: "policyVault",
      type: {
        kind: "struct",
        fields: [
          { name: "agentRegistry", type: "publicKey" },
          { name: "maxPerTransaction", type: "u64" },
          { name: "sessionBudgetTotal", type: "u64" },
          { name: "sessionBudgetRemaining", type: "u64" },
          { name: "approvalRequiredAbove", type: "u64" },
          { name: "allowedActions", type: "u16" },
          { name: "version", type: "u64" },
          { name: "bump", type: "u8" }
        ]
      }
    },
    {
      name: "paymentIntent",
      type: {
        kind: "struct",
        fields: [
          { name: "agentRegistry", type: "publicKey" },
          { name: "taskId", type: "string" },
          { name: "amount", type: "u64" },
          { name: "mint", type: "publicKey" },
          { name: "recipient", type: "publicKey" },
          { name: "purpose", type: "string" },
          { name: "expiresAt", type: "i64" },
          {
            name: "status",
            type: {
              defined: "PaymentIntentStatus"
            }
          },
          { name: "bump", type: "u8" }
        ]
      }
    },
    {
      name: "escrowAccount",
      type: {
        kind: "struct",
        fields: [
          { name: "agentRegistry", type: "publicKey" },
          { name: "taskId", type: "string" },
          { name: "amount", type: "u64" },
          { name: "mint", type: "publicKey" },
          { name: "escrowTokenAccount", type: "publicKey" },
          { name: "paymentIntent", type: "publicKey" },
          { name: "beneficiary", type: "publicKey" },
          { name: "verifier", type: "publicKey" },
          { name: "policyVersion", type: "u64" },
          {
            name: "status",
            type: {
              defined: "EscrowStatus"
            }
          },
          { name: "bump", type: "u8" }
        ]
      }
    },
    {
      name: "reconciliationRecord",
      type: {
        kind: "struct",
        fields: [
          { name: "escrow", type: "publicKey" },
          { name: "agentRegistry", type: "publicKey" },
          { name: "taskId", type: "string" },
          { name: "amount", type: "u64" },
          { name: "mint", type: "publicKey" },
          { name: "beneficiary", type: "publicKey" },
          { name: "verifier", type: "publicKey" },
          { name: "policyVersion", type: "u64" },
          { name: "reconciliationHash", type: { array: ["u8", 32] } },
          { name: "outcomeCode", type: "u16" },
          { name: "proofUri", type: "string" },
          { name: "bump", type: "u8" }
        ]
      }
    }
  ],
  types: [
    {
      name: "PaymentIntentStatus",
      type: {
        kind: "enum",
        variants: [{ name: "Requested" }, { name: "Escrowed" }, { name: "Paid" }, { name: "Cancelled" }]
      }
    },
    {
      name: "EscrowStatus",
      type: {
        kind: "enum",
        variants: [{ name: "Funded" }, { name: "Released" }]
      }
    }
  ],
  events: [
    {
      name: "AgentInitialized",
      fields: [
        { name: "owner", type: "publicKey", index: false },
        { name: "agentRegistry", type: "publicKey", index: false }
      ]
    },
    {
      name: "PolicyUpdated",
      fields: [
        { name: "agentRegistry", type: "publicKey", index: false },
        { name: "policy", type: "publicKey", index: false },
        { name: "maxPerTransaction", type: "u64", index: false },
        { name: "sessionBudget", type: "u64", index: false },
        { name: "version", type: "u64", index: false }
      ]
    },
    {
      name: "EscrowFunded",
      fields: [
        { name: "agentRegistry", type: "publicKey", index: false },
        { name: "escrow", type: "publicKey", index: false },
        { name: "taskId", type: "string", index: false },
        { name: "amount", type: "u64", index: false },
        { name: "beneficiary", type: "publicKey", index: false },
        { name: "verifier", type: "publicKey", index: false },
        { name: "policyVersion", type: "u64", index: false }
      ]
    },
    {
      name: "PaymentRequested",
      fields: [
        { name: "agentRegistry", type: "publicKey", index: false },
        { name: "paymentIntent", type: "publicKey", index: false },
        { name: "taskId", type: "string", index: false },
        { name: "amount", type: "u64", index: false },
        { name: "mint", type: "publicKey", index: false },
        { name: "recipient", type: "publicKey", index: false },
        { name: "expiresAt", type: "i64", index: false }
      ]
    },
    {
      name: "EscrowReleased",
      fields: [
        { name: "agentRegistry", type: "publicKey", index: false },
        { name: "escrow", type: "publicKey", index: false },
        { name: "taskId", type: "string", index: false },
        { name: "amount", type: "u64", index: false },
        { name: "beneficiary", type: "publicKey", index: false },
        { name: "verifier", type: "publicKey", index: false },
        { name: "reconciliationHash", type: { array: ["u8", 32] }, index: false }
      ]
    }
  ],
  errors: [
    { code: 6000, name: "InvalidAgentId", msg: "Agent id must be 1-32 ASCII characters: letters, numbers, dot, underscore, or hyphen" },
    { code: 6001, name: "InvalidTaskId", msg: "Task id must be 1-32 ASCII characters: letters, numbers, dot, underscore, or hyphen" },
    { code: 6002, name: "PurposeTooLong", msg: "Purpose is empty or too long" },
    { code: 6003, name: "ProofUriTooLong", msg: "Proof URI is empty or too long" },
    { code: 6004, name: "ZeroAmount", msg: "Escrow amount must be greater than zero" },
    { code: 6005, name: "InvalidExpiry", msg: "Payment intent expiry must be in the future" },
    { code: 6006, name: "InvalidPolicy", msg: "Invalid spend policy" },
    { code: 6007, name: "InvalidPolicyVault", msg: "Policy vault does not belong to this agent" },
    { code: 6008, name: "ActionNotAllowed", msg: "Policy does not allow this action" },
    { code: 6009, name: "ApprovalRequired", msg: "Amount requires human approval under the current policy" },
    { code: 6010, name: "ExceedsTransactionLimit", msg: "Amount exceeds maximum allowed per transaction" },
    { code: 6011, name: "ExceedsSessionBudget", msg: "Amount exceeds remaining session budget" },
    { code: 6012, name: "EscrowNotFunded", msg: "Escrow is not in funded state" },
    { code: 6013, name: "MathOverflow", msg: "Arithmetic overflow" },
    { code: 6014, name: "InvalidTokenOwner", msg: "Token account owner is invalid" },
    { code: 6015, name: "InvalidMint", msg: "Token account mint is invalid" },
    { code: 6016, name: "InvalidBeneficiary", msg: "Beneficiary token account does not belong to escrow beneficiary" },
    { code: 6017, name: "InvalidPaymentIntent", msg: "Payment intent account is invalid" },
    { code: 6018, name: "PaymentIntentExpired", msg: "Payment intent is expired" },
    { code: 6019, name: "PaymentIntentNotRequested", msg: "Payment intent is not in requested state" },
    { code: 6020, name: "PaymentIntentMismatch", msg: "Payment intent does not match escrow details" }
  ]
};
