/**
 * F6.5 — the error-fed repair loop (the pattern Genesis, decompile, and every
 * future LLM→validated-artifact pipeline share).
 *
 * Before this, `decompile` was one-shot: a single validation error threw the
 * whole provider round away. The loop closes the lazo the Clio way: the exact
 * failing fields/rules go BACK to the model as a targeted instruction, for a
 * bounded number of rounds — never silent degradation, never an invalid write.
 * On exhaustion the caller gets every critique for an honest failure report.
 */

import type { Provider, ProviderRunResult } from "./providers/types.js";
import { runProviderOrExit } from "./provider-run.js";

export interface RepairResult extends ProviderRunResult {
  /** Rounds actually used (1 = accepted first try). */
  rounds: number;
  /** The critique produced by each FAILED round, oldest first. */
  critiques: string[];
}

export interface RepairOptions {
  provider: Provider;
  prompt: string;
  /**
   * Judge a candidate: return null to ACCEPT, or the exact, actionable error
   * text (failing field + rule, Clio-style) to feed back to the model.
   */
  critique: (text: string) => string | null;
  /** Total rounds including the first (default 3). */
  maxRounds?: number;
  /** `--from-file` passthrough: the file is round 1's candidate (agent flow). */
  fromFile?: string;
  /** Progress hook (round number, critique of the previous round). */
  onRetry?: (round: number, critique: string) => void;
}

function repairPrompt(original: string, candidate: string, critiqueText: string): string {
  return [
    original,
    "",
    "---",
    "Your previous attempt FAILED validation. Do not apologize or explain — return the",
    "corrected, complete document only. Fix EXACTLY these errors and change nothing else:",
    "",
    critiqueText,
    "",
    "Your previous attempt (for reference):",
    "```",
    candidate,
    "```",
  ].join("\n");
}

export async function runWithRepair(opts: RepairOptions): Promise<RepairResult | { failed: true; critiques: string[]; last: ProviderRunResult }> {
  const maxRounds = opts.maxRounds ?? 3;
  const critiques: string[] = [];
  let prompt = opts.prompt;
  let last: ProviderRunResult | undefined;

  for (let round = 1; round <= maxRounds; round++) {
    // --from-file supplies round 1 only; repairs always go to the provider.
    last = await runProviderOrExit(opts.provider, prompt, round === 1 ? opts.fromFile : undefined);
    const verdict = opts.critique(last.text);
    if (verdict === null) return { ...last, rounds: round, critiques };
    critiques.push(verdict);
    if (round < maxRounds) {
      opts.onRetry?.(round + 1, verdict);
      prompt = repairPrompt(opts.prompt, last.text, verdict);
    }
  }
  return { failed: true, critiques, last: last as ProviderRunResult };
}
