import assert from "node:assert/strict";
import test from "node:test";
import { Keypair, SystemProgram, TransactionInstruction } from "@solana/web3.js";
import { AccuralSolanaClient } from "./accural-client.js";
import {
  bundlePlanHash,
  instructionFromPlan,
  simulateTransactionBundlePhase,
  validateTransactionBundlePlan,
} from "./execute-bundle.js";

test("validates bundle phases include all required instruction signers", () => {
  const client = new AccuralSolanaClient();
  const signer = Keypair.generate().publicKey;
  const instruction = new TransactionInstruction({
    programId: SystemProgram.programId,
    data: Buffer.from([1, 2, 3]),
    keys: [{ pubkey: signer, isSigner: true, isWritable: true }],
  });
  const plan = client.transactionBundlePlan({
    bundleId: "bundle-with-missing-signer",
    phases: [
      {
        phase: "bad-phase",
        description: "Missing signer coverage.",
        signerPubkeys: [],
        instructions: [instruction],
      },
    ],
  });

  const result = validateTransactionBundlePlan(plan);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.includes(`missing required signer ${signer.toBase58()}`)));
});

test("round-trips an instruction plan into a web3 TransactionInstruction", () => {
  const client = new AccuralSolanaClient();
  const signer = Keypair.generate().publicKey;
  const readonly = Keypair.generate().publicKey;
  const instruction = new TransactionInstruction({
    programId: SystemProgram.programId,
    data: Buffer.from([9, 8, 7]),
    keys: [
      { pubkey: signer, isSigner: true, isWritable: true },
      { pubkey: readonly, isSigner: false, isWritable: false },
    ],
  });

  const roundTripped = instructionFromPlan(client.instructionPlan(instruction));

  assert.equal(roundTripped.programId.toBase58(), SystemProgram.programId.toBase58());
  assert.deepEqual(Array.from(roundTripped.data), [9, 8, 7]);
  assert.equal(roundTripped.keys[0]?.pubkey.toBase58(), signer.toBase58());
  assert.equal(roundTripped.keys[0]?.isSigner, true);
  assert.equal(roundTripped.keys[1]?.pubkey.toBase58(), readonly.toBase58());
});

test("hashes equivalent bundle plans deterministically", () => {
  const client = new AccuralSolanaClient();
  const signer = Keypair.generate().publicKey;
  const instruction = new TransactionInstruction({
    programId: SystemProgram.programId,
    data: Buffer.from([4, 5, 6]),
    keys: [{ pubkey: signer, isSigner: true, isWritable: true }],
  });
  const bundle = client.transactionBundlePlan({
    bundleId: "stable-bundle",
    phases: [
      {
        phase: "submit",
        description: "Stable hash test.",
        signerPubkeys: [signer.toBase58()],
        instructions: [instruction],
      },
    ],
  });

  assert.equal(bundlePlanHash(bundle), bundlePlanHash(JSON.parse(JSON.stringify(bundle))));
  assert.match(bundlePlanHash(bundle), /^[0-9a-f]{64}$/);
  assert.equal(validateTransactionBundlePlan(bundle).ok, true);
});

test("simulates a transaction bundle phase and returns logs", async () => {
  const client = new AccuralSolanaClient();
  const signer = Keypair.generate();
  const instruction = new TransactionInstruction({
    programId: SystemProgram.programId,
    data: Buffer.from([1]),
    keys: [{ pubkey: signer.publicKey, isSigner: true, isWritable: true }],
  });
  const bundle = client.transactionBundlePlan({
    bundleId: "simulation-bundle",
    phases: [
      {
        phase: "simulate",
        description: "Simulation test.",
        signerPubkeys: [signer.publicKey.toBase58()],
        instructions: [instruction],
      },
    ],
  });
  client.connection.simulateTransaction = (async () => ({
    context: { slot: 1 },
    value: {
      accounts: null,
      err: { InstructionError: [0, "Custom"] },
      logs: ["Program failed"],
      unitsConsumed: 123,
    },
  })) as typeof client.connection.simulateTransaction;

  const simulation = await simulateTransactionBundlePhase({
    client,
    phase: bundle.phases[0]!,
    signers: [signer],
  });

  assert.deepEqual(simulation.err, { InstructionError: [0, "Custom"] });
  assert.deepEqual(simulation.logs, ["Program failed"]);
  assert.equal(simulation.unitsConsumed, 123);
});
