import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { IDL } from "../idl.js";
import { ACCURAL_PROGRAM_ID } from "./accural-client.js";

const repoRoot = resolve(process.cwd(), "..");

test("keeps Accural program id consistent across Rust, Anchor, IDL, scripts, and client", () => {
  const rustProgramId = matchOne(
    readFileSync(resolve(repoRoot, "programs", "accural", "src", "lib.rs"), "utf8"),
    /declare_id!\("([^"]+)"\)/,
    "Rust declare_id",
  );
  const anchorProgramId = matchOne(
    readFileSync(resolve(repoRoot, "Anchor.toml"), "utf8"),
    /accural\s*=\s*"([^"]+)"/,
    "Anchor.toml program id",
  );
  const validatorProgramId = matchOne(
    readFileSync(resolve(repoRoot, "scripts", "run-local-validator-e2e.ps1"), "utf8"),
    /\$programId\s*=\s*"([^"]+)"/,
    "local validator script program id",
  );

  const ids = [
    ["Rust declare_id", rustProgramId],
    ["Anchor.toml", anchorProgramId],
    ["local validator script", validatorProgramId],
    ["TypeScript client", ACCURAL_PROGRAM_ID.toBase58()],
    ["IDL address", String(IDL.address)],
    ["IDL metadata address", String(IDL.metadata?.address)],
  ];
  const expected = ACCURAL_PROGRAM_ID.toBase58();
  for (const [name, id] of ids) {
    assert.equal(id, expected, `${name} must match ${expected}`);
  }
});

test("keeps checked-in IDL instruction names aligned with the TypeScript client", () => {
  const instructionNames = new Set((IDL.instructions as Array<{ name: string }>).map((item) => item.name));
  assert.deepEqual(
    Array.from(instructionNames).sort(),
    [
      "cancelPaymentIntent",
      "deactivateService",
      "directPayment",
      "fundEscrow",
      "initializeAgent",
      "refundEscrow",
      "registerService",
      "releaseEscrow",
      "requestPayment",
      "setPolicy",
    ],
  );
});

function matchOne(source: string, pattern: RegExp, label: string) {
  const match = source.match(pattern);
  assert.ok(match?.[1], `${label} was not found`);
  return match[1];
}
