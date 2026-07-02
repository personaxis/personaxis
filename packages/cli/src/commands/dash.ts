/**
 * `personaxis dash` — the living ASCII dashboard.
 *
 * A single entry point to the `@personaxis/tui` dashboard (also shipped as the
 * `personaxis-dash` bin). It reads state.json each frame, so it reflects evolution
 * happening in another process (a REPL session, an MCP host, `serve`, `watch`) in
 * real time. Run it in a second terminal while a session drives the persona.
 */

import { Command } from "commander";
import { resolve } from "node:path";
import { runDashboard } from "@personaxis/tui";

export const dashCommand = new Command("dash")
  .description("Live ASCII dashboard: sigil + envelopes + memory-chain, refreshed from state.json each frame.")
  .option("-p, --persona <path>", "Path to personaxis.md (default: .personaxis/personaxis.md)", ".personaxis/personaxis.md")
  .option("--once", "Print a snapshot (N frames) and exit — for CI / piping, no screen takeover")
  .option("--frames <n>", "How many frames to print with --once (default 30)", (v) => Number(v), 30)
  .option("--interval <ms>", "Refresh interval in interactive mode (default 500ms)", (v) => Number(v), 500)
  .action(async (opts: { persona: string; once?: boolean; frames: number; interval: number }) => {
    await runDashboard({
      persona: resolve(opts.persona),
      once: Boolean(opts.once),
      frames: opts.frames,
      interval: opts.interval,
    });
  });
