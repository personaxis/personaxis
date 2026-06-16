import { createHash } from "crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join, resolve } from "path";
import type { Provider, ProviderRunResult } from "./types.js";
import { ProviderRequiresAgentError } from "./types.js";

const TMP_DIR = resolve(process.cwd(), ".personaxis", ".tmp");

/**
 * The default provider. Does not make a network call: the CLI exposes
 * compile/decompile as a prompt the ACTIVE coding agent (Claude Code, Codex,
 * ...) runs with its own model.
 *
 * First run writes the prompt to `.personaxis/.tmp/<hash>.prompt.md` and
 * throws `ProviderRequiresAgentError`. The agent reads that file, follows its
 * instructions, and writes its response to `.personaxis/.tmp/<hash>.out.md`.
 * Re-running the same command with `--from-file <hash>.out.md` (or simply
 * re-running once the `.out.md` file exists) applies the result.
 */
export function createAgentProvider(): Provider {
  return {
    name: "agent",
    source: "cli-agent",
    async run(prompt: string): Promise<ProviderRunResult> {
      const hash = createHash("sha256").update(prompt).digest("hex").slice(0, 16);
      const promptFile = join(TMP_DIR, `${hash}.prompt.md`);
      const resultFile = join(TMP_DIR, `${hash}.out.md`);

      if (existsSync(resultFile)) {
        const text = readFileSync(resultFile, "utf-8");
        return { text, model: "active-agent", source: "cli-agent" };
      }

      mkdirSync(TMP_DIR, { recursive: true });
      writeFileSync(promptFile, prompt, "utf-8");

      throw new ProviderRequiresAgentError(prompt, promptFile, resultFile);
    },
  };
}
