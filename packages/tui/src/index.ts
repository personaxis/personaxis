#!/usr/bin/env node
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
import { pathToFileURL } from "node:url";
import chalk from "chalk";
import {
  loadPersona,
  ensureState,
  readState,
  extractEnvelopes,
  verifyMemoryChain,
  readMemory,
  sigilParams,
  renderSigil,
  liveIntensity,
  barIndex,
  displayName,
} from "@personaxis/core";

interface Opts {
  persona: string;
  once: boolean;
  frames: number;
  interval: number;
}

function parseArgs(argv: string[]): Opts {
  const o: Opts = { persona: ".personaxis/personaxis.md", once: false, frames: 30, interval: 500 };
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
  const params = sigilParams(handle.frontmatter);
  const paint = chalk.ansi256(params.color);
  const sigil = renderSigil(params, liveIntensity(state.values, frame));
  const chain = verifyMemoryChain(handle.personaPath);
  const mem = readMemory(handle.personaPath);

  const lines: string[] = [];
  lines.push("");
  lines.push("  " + chalk.bold.magentaBright(displayName(handle.frontmatter)) + chalk.dim(`  ·  sigil #${params.seed.toString(16)}`));
  lines.push("");
  for (const row of sigil.grid) lines.push("     " + paint(row));
  lines.push("");
  for (const [k, v] of Object.entries(state.values)) {
    const e = env.envelopes[k];
    if (!e) continue;
    const w = 18;
    const pos = barIndex(v, e, w);
    let bar = "";
    for (let i = 0; i < w; i++) bar += i === pos ? chalk.cyan("●") : chalk.dim("─");
    lines.push(`  ${k.padEnd(28)} ${bar} ${chalk.dim(v.toFixed(2))}`);
  }
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

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  const personaPath = resolve(opts.persona);
  if (!existsSync(personaPath)) {
    console.error(chalk.red("Error:"), `persona not found at ${personaPath}`);
    process.exit(1);
  }
  ensureState(loadPersona(personaPath));

  const clear = "\x1b[2J\x1b[H";
  let frame = 0;

  if (opts.once) {
    for (let i = 0; i < opts.frames; i++) process.stdout.write(renderFrame(personaPath, i) + "\n");
    return;
  }

  process.on("SIGINT", () => {
    process.stdout.write("\x1b[?25h" + clear); // restore cursor
    console.log(chalk.dim("  dashboard closed.\n"));
    process.exit(0);
  });
  process.stdout.write("\x1b[?25l"); // hide cursor

  const tick = () => {
    process.stdout.write(clear + renderFrame(personaPath, frame++));
    if (frame >= opts.frames && opts.frames > 0) {
      process.stdout.write("\x1b[?25h\n" + chalk.dim("  (max frames reached)\n"));
      process.exit(0);
    }
  };
  tick();
  setInterval(tick, opts.interval);
}

const entry = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === entry) {
  main().catch((err) => {
    console.error("personaxis-dash fatal:", err);
    process.exit(1);
  });
}
