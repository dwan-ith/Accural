import { createHash } from "node:crypto";
import {
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import type { AccuralSolanaClient, InstructionPlan, TransactionBundlePlan } from "./accural-client.js";

export type BundleValidationResult = {
  ok: boolean;
  errors: string[];
};

export type BundleExecutionResult = {
  bundleId: string;
  bundleHash: string;
  phases: Array<{
    phase: string;
    signature: string;
    signerPubkeys: string[];
    instructionCount: number;
    simulation?: BundlePhaseSimulation;
  }>;
};

export type BundlePhaseSimulation = {
  err: unknown;
  logs: string[];
  unitsConsumed?: number;
};

export class BundlePhaseExecutionError extends Error {
  constructor(
    message: string,
    readonly phase: string,
    readonly logs: string[],
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "BundlePhaseExecutionError";
  }
}

export function instructionFromPlan(plan: InstructionPlan) {
  return new TransactionInstruction({
    programId: new PublicKey(plan.programId),
    data: Buffer.from(plan.dataBase64, "base64"),
    keys: plan.keys.map((key) => ({
      pubkey: new PublicKey(key.pubkey),
      isSigner: key.isSigner,
      isWritable: key.isWritable,
    })),
  });
}

export function validateTransactionBundlePlan(bundle: TransactionBundlePlan): BundleValidationResult {
  const errors: string[] = [];
  if (!bundle.bundleId.trim()) {
    errors.push("bundleId must be non-empty.");
  }
  if (bundle.phases.length === 0) {
    errors.push("bundle must contain at least one phase.");
  }

  for (const [phaseIndex, phase] of bundle.phases.entries()) {
    if (!phase.phase.trim()) {
      errors.push(`phase[${phaseIndex}].phase must be non-empty.`);
    }
    const phaseSignerSet = new Set(phase.signerPubkeys);
    for (const signer of phase.signerPubkeys) {
      if (!isValidPubkey(signer)) {
        errors.push(`phase[${phaseIndex}] has invalid signer pubkey ${signer}.`);
      }
    }
    for (const [instructionIndex, instruction] of phase.instructions.entries()) {
      if (!isValidPubkey(instruction.programId)) {
        errors.push(`phase[${phaseIndex}].instructions[${instructionIndex}] has invalid programId.`);
      }
      if (!isValidBase64(instruction.dataBase64)) {
        errors.push(`phase[${phaseIndex}].instructions[${instructionIndex}] has invalid base64 data.`);
      }
      for (const [keyIndex, key] of instruction.keys.entries()) {
        if (!isValidPubkey(key.pubkey)) {
          errors.push(
            `phase[${phaseIndex}].instructions[${instructionIndex}].keys[${keyIndex}] has invalid pubkey.`,
          );
        }
        if (key.isSigner && !phaseSignerSet.has(key.pubkey)) {
          errors.push(
            `phase[${phaseIndex}] missing required signer ${key.pubkey} for instruction ${instructionIndex}.`,
          );
        }
      }
    }
  }

  return { ok: errors.length === 0, errors };
}

export function assertValidTransactionBundlePlan(bundle: TransactionBundlePlan) {
  const result = validateTransactionBundlePlan(bundle);
  if (!result.ok) {
    throw new Error(`Invalid transaction bundle: ${result.errors.join(" ")}`);
  }
}

export function bundlePlanHash(bundle: TransactionBundlePlan) {
  return createHash("sha256").update(canonicalJson(bundle)).digest("hex");
}

export async function executeTransactionBundle(input: {
  client: AccuralSolanaClient;
  bundle: TransactionBundlePlan;
  signers: Map<string, Keypair>;
  simulateBeforeSend?: boolean;
}): Promise<BundleExecutionResult> {
  assertValidTransactionBundlePlan(input.bundle);
  const phases: BundleExecutionResult["phases"] = [];

  for (const phase of input.bundle.phases) {
    const phaseSigners = phase.signerPubkeys.map((pubkey) => {
      const signer = input.signers.get(pubkey);
      if (!signer) {
        throw new Error(`Missing signer keypair for ${pubkey} in phase ${phase.phase}.`);
      }
      if (signer.publicKey.toBase58() !== pubkey) {
        throw new Error(`Signer keypair public key does not match ${pubkey}.`);
      }
      return signer;
    });
    const simulation = input.simulateBeforeSend
      ? await simulateTransactionBundlePhase({
          client: input.client,
          phase,
          signers: phaseSigners,
        })
      : undefined;
    if (simulation?.err) {
      throw new BundlePhaseExecutionError(
        `Simulation failed for phase ${phase.phase}: ${JSON.stringify(simulation.err)}`,
        phase.phase,
        simulation.logs,
        simulation.err,
      );
    }

    const transaction = transactionFromPhase(phase);
    const signature = await sendAndConfirmTransaction(
      input.client.connection,
      transaction,
      phaseSigners,
      { commitment: "confirmed" },
    ).catch((error: unknown) => {
      throw new BundlePhaseExecutionError(
        `Submission failed for phase ${phase.phase}: ${error instanceof Error ? error.message : String(error)}`,
        phase.phase,
        [],
        error,
      );
    });
    phases.push({
      phase: phase.phase,
      signature,
      signerPubkeys: phase.signerPubkeys,
      instructionCount: phase.instructions.length,
      ...(simulation ? { simulation } : {}),
    });
  }

  return {
    bundleId: input.bundle.bundleId,
    bundleHash: bundlePlanHash(input.bundle),
    phases,
  };
}

export async function simulateTransactionBundlePhase(input: {
  client: AccuralSolanaClient;
  phase: TransactionBundlePlan["phases"][number];
  signers: Keypair[];
}): Promise<BundlePhaseSimulation> {
  const transaction = transactionFromPhase(input.phase);
  const simulation = await input.client.connection.simulateTransaction(transaction, input.signers);
  return {
    err: simulation.value.err,
    logs: simulation.value.logs ?? [],
    ...(simulation.value.unitsConsumed === undefined
      ? {}
      : { unitsConsumed: simulation.value.unitsConsumed }),
  };
}

function transactionFromPhase(phase: TransactionBundlePlan["phases"][number]) {
  const transaction = new Transaction();
  transaction.add(...phase.instructions.map(instructionFromPlan));
  return transaction;
}

function isValidPubkey(value: string) {
  try {
    new PublicKey(value);
    return true;
  } catch {
    return false;
  }
}

function isValidBase64(value: string) {
  if (!value.trim()) {
    return false;
  }
  try {
    return Buffer.from(value, "base64").toString("base64") === value;
  } catch {
    return false;
  }
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
