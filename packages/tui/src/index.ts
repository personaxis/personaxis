/**
 * @personaxis/tui — the living dashboard (`personaxis-dash`).
 *
 * A breathing, per-persona ASCII view: the persona's own sigil (seeded from its
 * personaxis.md identity) animating with its live state, envelope bars, mutation
 * count, and memory-chain integrity. It reads state.json each frame, so it reflects
 * evolution happening in another process (REPL, MCP host, HTTP) in real time.
 *
 *   personaxis-dash --persona <path> [--once] [--frames N] [--interval ms]
 */

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import chalk from "chalk";
import {
  loadPersona,
  ensureState,
  readState,
  extractEnvelopes,
  verifyMemoryChain,
  readMemory,
  personaTheme,
  displayName,
} from "@personaxis/core";
import { sigilLines, auraBar, envelopeBars } from "./visual.js";

export interface DashOpts {
  persona: string;
  once: boolean;
  frames: number;
  interval: number;
}

function parseArgs(argv: string[]): DashOpts {
  const o: DashOpts = { persona: ".personaxis/personaxis.md", once: false, frames: 30, interval: 500 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--persona" || a === "-p") o.persona = argv[++i];
    else if (a === "--once") o.once = true;
    else if (a === "--frames") o.frames = Number(argv[++i]) || o.frames;
    else if (a === "--interval") o.interval = Number(argv[++i]) || o.interval;
  }
  return o;
}

export function renderFrame(personaPath: string, frame: number): string {
  const handle = loadPersona(personaPath);
  const state = readState(handle.statePath);
  const env = extractEnvelopes(handle.frontmatter);
  const theme = personaTheme(handle.frontmatter);
  const chain = verifyMemoryChain(handle.personaPath);
  const mem = readMemory(handle.personaPath);

  const lines: string[] = [];
  lines.push("");
  lines.push(
    "  " + chalk.bold.ansi256(theme.palette.accent)(displayName(handle.frontmatter)) +
      chalk.dim(`  ·  sigil #${theme.seed.toString(16)}  ·  ${auraBar(theme, state.values, frame)}`),
  );
  lines.push("");
  lines.push(...sigilLines(theme, state.values, frame));
  lines.push("");
  lines.push(envelopeBars(theme, state.values, env.envelopes));
  lines.push("");
  lines.push(
    chalk.dim(
      `  mutations ${state.mutation_log.length}  ·  memory ${mem.length}  ·  chain ` +
        (chain.ok ? chalk.green("intact") : chalk.red("BROKEN")) +
        `  ·  frame ${frame}`,
    ),
  );
  lines.push("");
  return lines.join("\n");
}

/**
 * Run the live dashboard for a persona. Shared by the `personaxis-dash` bin and the
 * `personaxis dash` CLI subcommand, so both entry points behave identically.
 * Returns when finished (once/non-TTY); in interactive mode it runs until SIGINT.
 */
export async function runDashboard(opts: DashOpts): Promise<void> {
  const personaPath = resolve(opts.persona);
  if (!existsSync(personaPath)) {
    console.error(chalk.red("Error:"), `persona not found at ${personaPath}`);
    process.exitCode = 1;
    return;
  }
  ensureState(loadPersona(personaPath));

  // Non-interactive (pipe/CI/--once): print static frames, no screen takeover.
  if (opts.once || !process.stdout.isTTY) {
    const n = opts.once ? opts.frames : 1;
    for (let i = 0; i < n; i++) process.stdout.write(renderFrame(personaPath, i) + "\n");
    return;
  }

  // Interactive: Ink 7 render (FR.3). Ink owns the diffing/redraw; the
  // Dashboard component re-reads state.json each frame — same live contract
  // as the pre-Ink loop, same visuals (components wrap visual.ts verbatim).
  const [{ render }, React, { Dashboard }] = await Promise.all([
    import("ink"),
    import("react"),
    import("./components.js"),
  ]);
  const app = render(
    React.createElement(Dashboard, { personaPath, intervalMs: opts.interval }),
    { exitOnCtrlC: true },
  );
  await app.waitUntilExit();
  console.log(chalk.dim("  dashboard closed.\n"));
}

/**
 * `personaxis-dash` standalone entry — used by bin.ts ONLY. The old
 * `import.meta.url === argv[1]` main-module guard lived here and evaluated
 * TRUE for every module inside a bun-compiled binary (all modules share the
 * virtual root), spuriously launching the dashboard on EVERY CLI invocation.
 * Bun-compile rule: a bin gets a dedicated entry file, never a barrel guard.
 */
export async function dashMain(): Promise<void> {
  await runDashboard(parseArgs(process.argv.slice(2)));
}
