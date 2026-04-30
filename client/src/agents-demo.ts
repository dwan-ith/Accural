import { runAgentDemo } from "./agents/run.js";
import type { AgentMode } from "./agents/types.js";

const mode = parseMode(process.argv[2] ?? process.env.ACCURAL_AGENT_MODE ?? "deterministic");

const result = await runAgentDemo({
  mode,
  resetState: true,
});

console.log(JSON.stringify(result, null, 2));

function parseMode(value: string): AgentMode {
  if (value === "deterministic" || value === "llm") {
    return value;
  }
  throw new Error("Usage: npm run agents:demo -- deterministic|llm");
}
