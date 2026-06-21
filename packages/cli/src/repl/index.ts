/**
 * `personaxis` (no subcommand) -> the living REPL.
 *
 * A persistent, interactive session where you talk to your persona in natural
 * language and drive it with /commands (Claude-Code style). The persona is not
 * static: natural-language turns feed the governed Living Loop, so it observes,
 * appraises, and evolves within its envelopes — every change clamped + audited.
 */

import * as readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { existsSync, writeFileSync, readFileSync, unlinkSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import chalk from "chalk";
import {
  LivingLoop,
  loadPersona,
  readState,
  ensureState,
  displayName,
  extractEnvelopes,
  readMode,
  sigilParams,
  HeuristicAppraiser,
  LlmAppraiser,
  makeRecompileHook,
  type Appraiser,
  type PersonaHandle,
} from "@personaxis/core";
import { banner, sigilBlock, moodGauge, formatEvent, envelopeBars } from "./render.js";

interface ReplOptions {
  persona?: string;
}

const CANDIDATES = [
  ".personaxis/personaxis.md",
  ".personaxis/PERSONA.md",
  "personaxis.md",
  "PERSONA.md",
];

function resolvePersonaPath(opt?: string): string | null {
  if (opt) return existsSync(resolve(opt)) ? resolve(opt) : null;
  for (const c of CANDIDATES) {
    const p = resolve(c);
    if (existsSync(p)) return p;
  }
  return null;
}

const HELP = `
${chalk.bold("Commands")}
  ${chalk.cyan("/help")}              show this help
  ${chalk.cyan("/persona")}           show the active persona (identity + sigil)
  ${chalk.cyan("/sigil")}             render the persona's living sigil
  ${chalk.cyan("/state")}             show current envelope values + recent mutations
  ${chalk.cyan("/evolve")} ${chalk.dim("<text>")}     run one governed Living-Loop cycle on <text>
  ${chalk.cyan("/audit")}             show the mutation log + memory-chain integrity
  ${chalk.cyan("/memory")}            list recent episodic memory entries
  ${chalk.cyan("/compile")}           (stub) recompile PERSONA.md from the spec
  ${chalk.cyan("/model")}             show the appraiser/model in use
  ${chalk.cyan("/goal")} ${chalk.dim("<text>")}       (stub) set a completion goal
  ${chalk.cyan("/loop")} ${chalk.dim("<n>")}          (stub) periodic self-audit every n ticks
  ${chalk.cyan("/exit")}              leave the session

Type anything without a leading ${chalk.cyan("/")} to speak to the persona — your turn
becomes an observation fed to the governed loop (mode shown in /state).
`;

export async function startRepl(opts: ReplOptions = {}): Promise<void> {
  const personaPath = resolvePersonaPath(opts.persona);
  stdout.write(banner());

  if (!personaPath) {
    stdout.write(
      chalk.yellow("No persona found.") +
        " Looked for: " +
        CANDIDATES.map((c) => chalk.dim(c)).join(", ") +
        "\nRun " +
        chalk.cyan("personaxis init") +
        " or pass " +
        chalk.cyan("--persona <path>") +
        ".\n",
    );
    return;
  }

  const handle = loadPersona(personaPath);
  const state = ensureState(handle);
  const mode = readMode(handle.frontmatter as Record<string, unknown>);
  const name = displayName(handle.frontmatter);

  // Live-sync: on evolution, update the LIVE-STATE block in the compiled host doc
  // (repo-root PERSONA.md, if present) and write a .live.json notify marker.
  const compiledCandidate = resolve(dirname(dirname(personaPath)), "PERSONA.md");
  const loop = new LivingLoop(personaPath, {
    appraiser: pickAppraiser(),
    recompile: makeRecompileHook(existsSync(compiledCandidate) ? compiledCandidate : undefined),
  });
  loop.bus.on((e) => {
    const line = formatEvent(e);
    if (line) stdout.write(line + "\n");
  });

  stdout.write("\n" + sigilBlock(handle.frontmatter, state.values) + "\n\n");
  stdout.write(
    chalk.bold(`  ${name}`) +
      chalk.dim(` is awake · improvement_policy=`) +
      modeColor(mode) +
      chalk.dim(` · ${Object.keys(state.values).length} envelopes\n`),
  );
  if (mode === "locked") {
    stdout.write(
      chalk.dim(
        "  (locked: the loop appraises + remembers, but envelope mutations are\n   human-directed only. Set improvement_policy.mode to evolve autonomously.)\n",
      ),
    );
  }
  stdout.write("\n");

  const makePrompt = (): string => {
    const cur = readState(handle.statePath);
    return `${moodGauge(cur.values)} ${chalk.magentaBright(name)} ${chalk.dim("›")} `;
  };

  // `for await (const line of rl)` queues input lines so none are dropped while a
  // turn is being processed (rl.question in a loop drops piped lines — see tests).
  const rl = readline.createInterface({ input: stdin, output: stdout, prompt: makePrompt() });
  rl.prompt();

  for await (const raw of rl) {
    const line = raw.trim();
    if (line) {
      if (line.startsWith("/")) {
        const cmd = line.slice(1).split(/\s+/)[0];
        const arg = line.slice(1 + cmd.length).trim();
        const done = await handleSlash(cmd, arg, { rl, handle, loop });
        if (done) break;
      } else {
        // Natural-language turn -> one governed loop cycle.
        await loop.tick({ observation: line, source: "user", actor: "actor-llm" });
      }
    }
    rl.setPrompt(makePrompt());
    rl.prompt();
  }

  rl.close();
  stdout.write(chalk.dim("\n  persona sleeping. state + memory persisted.\n"));
}

/**
 * Choose the appraiser: an OpenAI-compatible local/hosted model when configured
 * (constrained decoding), else the deterministic heuristic. Env:
 *   PERSONAXIS_ENDPOINT (e.g. http://localhost:11434/v1), PERSONAXIS_MODEL,
 *   PERSONAXIS_API_KEY (optional).
 */
function pickAppraiser(): Appraiser {
  const endpoint = process.env.PERSONAXIS_ENDPOINT;
  const model = process.env.PERSONAXIS_MODEL;
  if (endpoint && model) {
    return new LlmAppraiser({ endpoint, model, apiKey: process.env.PERSONAXIS_API_KEY });
  }
  return new HeuristicAppraiser();
}

function appraiserLabel(): string {
  const endpoint = process.env.PERSONAXIS_ENDPOINT;
  const model = process.env.PERSONAXIS_MODEL;
  return endpoint && model ? `LlmAppraiser (${model} @ ${endpoint})` : "HeuristicAppraiser (offline)";
}

function modeColor(mode: string): string {
  if (mode === "autonomous") return chalk.red(mode);
  if (mode === "suggesting") return chalk.yellow(mode);
  return chalk.green(mode);
}

interface SlashCtx {
  rl: readline.Interface;
  handle: PersonaHandle;
  loop: LivingLoop;
}

async function handleSlash(cmd: string, arg: string, ctx: SlashCtx): Promise<boolean> {
  const { handle, loop } = ctx;
  switch (cmd) {
    case "help":
      stdout.write(HELP + "\n");
      return false;
    case "exit":
    case "quit":
      return true;
    case "persona": {
      const id = handle.frontmatter.identity as Record<string, unknown> | undefined;
      stdout.write("\n" + chalk.bold(`  ${displayName(handle.frontmatter)}\n`));
      stdout.write(chalk.dim(`  ${handle.personaPath}\n`));
      if (id?.system_identity) {
        const si = id.system_identity as { purpose?: string };
        if (si.purpose) stdout.write(`  ${chalk.dim("purpose:")} ${si.purpose}\n`);
      }
      const st = readState(handle.statePath);
      stdout.write("\n" + sigilBlock(handle.frontmatter, st.values) + "\n\n");
      return false;
    }
    case "sigil": {
      const st = readState(handle.statePath);
      // a few breathing frames
      for (let f = 0; f < 4; f++) {
        stdout.write("\n" + sigilBlock(handle.frontmatter, st.values, f) + "\n");
      }
      stdout.write(chalk.dim(`  seed #${sigilParams(handle.frontmatter).seed.toString(16)}\n\n`));
      return false;
    }
    case "state": {
      const st = readState(handle.statePath);
      const env = extractEnvelopes(handle.frontmatter);
      stdout.write("\n" + chalk.bold("  Envelope values (position within range)\n"));
      stdout.write(envelopeBars(st.values, env.envelopes) + "\n");
      stdout.write(chalk.dim(`\n  mutation_log: ${st.mutation_log.length} entries\n\n`));
      return false;
    }
    case "audit": {
      const st = readState(handle.statePath);
      const { verifyMemoryChain } = await import("@personaxis/core");
      const chain = verifyMemoryChain(handle.personaPath);
      stdout.write("\n" + chalk.bold("  Mutation log (last 8)\n"));
      for (const e of st.mutation_log.slice(-8)) {
        stdout.write(
          `  ${chalk.dim(e.ts)} ${e.field}: ${e.from} → ${e.to}` +
            (e.clamped ? chalk.yellow(" clamped") : "") +
            (e.governance_blocked ? chalk.red(" blocked") : "") +
            chalk.dim(` — ${e.reason}\n`),
        );
      }
      stdout.write(
        "\n  memory chain: " +
          (chain.ok ? chalk.green("intact ✓") : chalk.red(`broken at #${chain.brokenAt}`)) +
          "\n\n",
      );
      return false;
    }
    case "memory": {
      const { readMemory } = await import("@personaxis/core");
      const mem = readMemory(handle.personaPath);
      stdout.write("\n" + chalk.bold(`  Episodic memory (${mem.length} entries, last 6)\n`));
      for (const m of mem.slice(-6)) {
        stdout.write(
          `  ${chalk.dim(m.ts)} ${chalk.cyan(`[${m.source}]`)} ${m.content.slice(0, 70)} ` +
            chalk.dim(`#${m.hash.slice(0, 8)}\n`),
        );
      }
      stdout.write("\n");
      return false;
    }
    case "evolve": {
      if (!arg) {
        stdout.write(chalk.yellow("  usage: /evolve <observation text>\n"));
        return false;
      }
      await loop.tick({ observation: arg, source: "user", actor: "actor-llm" });
      return false;
    }
    case "overseer": {
      const { overseerView } = await import("@personaxis/core");
      const v = overseerView();
      stdout.write(
        "\n" +
          chalk.bold.magentaBright("  overseer") +
          chalk.dim(` · machine ${v.machine}\n`) +
          `  personas ${v.personas} · projects ${v.projects} · collections ${v.collections}\n\n`,
      );
      return false;
    }
    case "compile":
      stdout.write(chalk.dim("  /compile: wired to the LLM compile pipeline in a later phase (F2/F5).\n"));
      return false;
    case "model":
      stdout.write(chalk.dim(`  appraiser: ${appraiserLabel()}\n`));
      stdout.write(
        chalk.dim("  set PERSONAXIS_ENDPOINT + PERSONAXIS_MODEL to use a local/hosted model.\n"),
      );
      return false;
    case "goal": {
      const goalPath = join(dirname(handle.personaPath), "goal.json");
      if (arg === "clear") {
        if (existsSync(goalPath)) unlinkSync(goalPath);
        stdout.write(chalk.dim("  goal cleared.\n"));
      } else if (arg) {
        writeFileSync(goalPath, JSON.stringify({ text: arg, createdTs: new Date().toISOString() }, null, 2));
        stdout.write(chalk.green("✓") + ` goal set: ${arg}\n`);
      } else if (existsSync(goalPath)) {
        const g = JSON.parse(readFileSync(goalPath, "utf-8")) as { text: string; createdTs: string };
        stdout.write(`  ${chalk.bold("goal:")} ${g.text} ${chalk.dim(`(since ${g.createdTs})`)}\n`);
      } else {
        stdout.write(chalk.dim("  no goal set. /goal <text> to set, /goal clear to remove.\n"));
      }
      return false;
    }
    case "loop": {
      const n = Math.max(1, Math.min(20, Number(arg) || 3));
      const { verifyMemoryChain, readMemory } = await import("@personaxis/core");
      stdout.write(chalk.dim(`  running ${n} self-audit pass(es)...\n`));
      for (let i = 1; i <= n; i++) {
        const st = readState(handle.statePath);
        const chain = verifyMemoryChain(handle.personaPath);
        const mem = readMemory(handle.personaPath);
        stdout.write(
          `  ${chalk.dim(`#${i}`)} mutations ${st.mutation_log.length} · memory ${mem.length} · chain ` +
            (chain.ok ? chalk.green("ok") : chalk.red("BROKEN")) +
            "\n",
        );
      }
      stdout.write(chalk.dim("  (interval scheduling is a harness TODO — plan/10-harness)\n"));
      return false;
    }
    default:
      stdout.write(chalk.yellow(`  unknown command /${cmd} — try /help\n`));
      return false;
  }
}
