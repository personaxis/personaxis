export type ProviderName = "local" | "byok" | "agent" | "remote";
export type ProviderSource = "cli-local" | "cli-byok" | "cli-agent" | "cli-remote";

export interface ProviderRunResult {
  text: string;
  model: string;
  source: ProviderSource;
}

export interface Provider {
  name: ProviderName;
  source: ProviderSource;
  run(prompt: string): Promise<ProviderRunResult>;
}

/**
 * Thrown by the `agent` provider. `compile`/`decompile` cannot make a network
 * call on this provider's behalf - the active coding agent (Claude Code,
 * Codex, ...) must run the prompt itself and feed the result back.
 */
export class ProviderRequiresAgentError extends Error {
  constructor(
    public readonly prompt: string,
    public readonly promptFile: string,
    public readonly resultFile: string,
  ) {
    super(
      `The "agent" provider needs the active coding agent to run this prompt.\n\n` +
        `The prompt has been written to:\n  ${promptFile}\n\n` +
        `Read that file, follow its instructions, write the resulting document to:\n  ${resultFile}\n\n` +
        `Then re-run this command with --from-file ${resultFile} to apply the result.`,
    );
  }
}
