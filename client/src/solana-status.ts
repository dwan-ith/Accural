import { AccuralSolanaClient } from "./solana/accural-client.js";

const rpcUrl = process.env.ACCURAL_RPC_URL ?? "http://127.0.0.1:8899";
const client = new AccuralSolanaClient({ rpcUrl });

try {
  await client.waitForRpc();
  const deployment = await client.getProgramDeploymentStatus();
  console.log(
    JSON.stringify(
      {
        ok: deployment.deployed && deployment.executable,
        ...deployment,
      },
      null,
      2,
    ),
  );
  if (!deployment.deployed || !deployment.executable) {
    process.exitCode = 1;
  }
} catch (error) {
  console.error(
    JSON.stringify(
      {
        ok: false,
        rpcUrl,
        error: error instanceof Error ? error.message : String(error),
      },
      null,
      2,
    ),
  );
  process.exitCode = 1;
}
