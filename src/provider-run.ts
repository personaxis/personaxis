import { readFileSync } from "fs";
import { resolve } from "path";
import chalk from "chalk";
import type { Provider, ProviderRunResult } from "./providers/types.js";
import { ProviderRequiresAgentError } from "./providers/types.js";

/**
 * Runs `prompt` through `provider`, handling the `agent` provider's
 * "write the prompt, let the active coding agent answer it" handshake.
 *
 * If `fromFile` is given, its contents are used directly as the result
 * (useful for piping in a hand-written or agent-produced response without
 * relying on the `agent` provider's hash-based temp files).
 */
export async function runProviderOrExit(
  provider: Provider,
  prompt: string,
  fromFile?: string,
): Promise<ProviderRunResult> {
  if (fromFile) {
    const text = readFileSync(resolve(fromFile), "utf-8");
    return { text, model: "manual", source: provider.source };
  }

  try {
    return await provider.run(prompt);
  } catch (err) {
    if (err instanceof ProviderRequiresAgentError) {
      console.log(err.message);
      console.log("");
      console.log(chalk.dim("Re-run this command once that file exists to apply the result."));
      process.exit(0);
    }
    throw err;
  }
}
