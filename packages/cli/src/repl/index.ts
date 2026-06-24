/**
 * `personaxis` (no subcommand) -> the living REPL.
 *
 * A persistent, interactive session where you talk to your persona in natural
 * language, drive it with /commands, and hand it real tasks with /do (the governed
 * Agent Loop). On a TTY it runs as a full alternate-screen app (Screen): no frame
 * pile-up, a live `/` menu, and shift+tab to cycle the sandbox posture. When stdin
 * isn't a TTY (pipes/CI) it falls back to a simple line reader.
 */

import * as readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { existsSync, writeFileSync, readFileSync, unlinkSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import chalk from "chalk";
import {
  LivingLoop,
  PersonaAgent,
  EventBus,
  loadPersona,
  readState,
  ensureState,
  displayName,
  extractEnvelopes,
  readMode,
  readMemory,
  verifyMemoryChain,
  overseerView,
  personaTheme,
  policyFromFrontmatter,
  resolveEffectivePersona,
  readAgentBudget,
  readVerification,
  readObservability,
  Tracer,
  ContextMeter,
  cachedContextWindow,
  resolveContextWindow,
  compactMessages,
  type ChatMessage,
  HeuristicAppraiser,
  LlmAppraiser,
  LlmResponder,
  ReflectiveResponder,
  makeRecompileHook,
  type Appraiser,
  type Responder,
  type Policy,
  type SandboxMode,
  type PersonaHandle,
  type PersonaTheme,
  type LoopEvent,
  type ToolCall,
  type CommandVerdict,
  type ApprovalDecision,
} from "@personaxis/core";
import {
  animateLogo,
  awaken,
  sigilLines,
  auraBar,
  envelopeBars,
  eventLine,
  voiceWrap,
  farewell,
} from "@personaxis/tui/visual";
import { Screen, type SlashItem, type LineRole } from "@personaxis/tui/screen";
import { writeStarterPersona } from "../starter.js";

interface ReplOptions {
  persona?: string;
}

const CANDIDATES = [".personaxis/personaxis.md", ".personaxis/PERSONA.md", "personaxis.md", "PERSONA.md"];
const POSTURES: SandboxMode[] = ["read-only", "workspace-write", "danger-full-access"];

function resolvePersonaPath(opt?: string): string | null {
  if (opt) {
    if (existsSync(resolve(opt))) return resolve(opt);
    // Not a path → treat as a global/overlay persona slug (G5 reuse).
    if (!opt.includes("/") && !opt.includes("\\")) {
      const eff = resolveEffectivePersona(process.cwd(), opt);
      if (eff.scope !== "none" && existsSync(eff.path)) return eff.path;
    }
    return null;
  }
  for (const c of CANDIDATES) {
    const p = resolve(c);
    if (existsSync(p)) return p;
  }
  return null;
}

// ── Session context shared by both UIs ──────────────────────────────────────
interface Ctx {
  handle: PersonaHandle;
  loop: LivingLoop;
  responder: Responder;
  theme: PersonaTheme;
  name: string;
  mode: string;
  out: (text: string, role?: LineRole) => void;
  postureIndex: number;
  approve: (call: ToolCall, v: CommandVerdict) => Promise<ApprovalDecision>;
  /** Persistent conversation (no system message) for chat continuity. */
  conversation: ChatMessage[];
  /** Session-level context-window meter (persists across turns). */
  meter: ContextMeter;
  /** Update the spinner phase label (Screen mode only). */
  phase?: (label: string) => void;
}

function phaseFor(e: LoopEvent): string {
  switch (e.type) {
    case "agent-step": return "thinking";
    case "tool-propose": return `running ${e.tool}`;
    case "tool-result": return "reading result";
    case "verify-start":
    case "verify-result": return "verifying";
    case "appraise": return "appraising";
    case "context-compacted": return "compacting context";
    default: return "working";
  }
}

function llmConfig(): { endpoint: string; model: string; apiKey?: string } | undefined {
  const endpoint = process.env.PERSONAXIS_ENDPOINT;
  const model = process.env.PERSONAXIS_MODEL;
  return endpoint && model ? { endpoint, model, apiKey: process.env.PERSONAXIS_API_KEY } : undefined;
}

function pickAppraiser(): Appraiser {
  const llm = llmConfig();
  return llm ? new LlmAppraiser(llm) : new HeuristicAppraiser();
}
function pickResponder(): Responder {
  const llm = llmConfig();
  return llm ? new LlmResponder(llm) : new ReflectiveResponder();
}
function appraiserLabel(): string {
  const llm = llmConfig();
  return llm ? `${llm.model} @ ${llm.endpoint}` : "heuristic (offline — set PERSONAXIS_ENDPOINT + PERSONAXIS_MODEL)";
}

function buildPolicy(ctx: Ctx): Policy {
  const base = policyFromFrontmatter(ctx.handle.frontmatter as Record<string, unknown>, process.cwd());
  return { ...base, sandbox: POSTURES[ctx.postureIndex] };
}

function readGoalText(handle: PersonaHandle): string | undefined {
  const goalPath = join(dirname(handle.personaPath), "goal.json");
  if (!existsSync(goalPath)) return undefined;
  try {
    return (JSON.parse(readFileSync(goalPath, "utf-8")) as { text?: string }).text;
  } catch {
    return undefined;
  }
}

/** Render any loop OR agent event into a single display line (or null to skip). */
function renderEvent(theme: PersonaTheme, e: LoopEvent): string | null {
  switch (e.type) {
    case "abstain":
      return chalk.dim(`  · abstained: ${e.reason}`);
    case "agent-step":
      return chalk.dim(`  ┌─ step ${e.step}`);
    case "agent-think":
      return e.text ? chalk.dim(`  │ ${e.text.slice(0, 100)}`) : null;
    case "tool-propose":
      return chalk.cyan(`  │ → ${e.tool} ${chalk.dim(JSON.stringify(e.args).slice(0, 80))}`);
    case "tool-verdict": {
      const c = e.decision === "deny" ? chalk.red : e.decision === "ask" ? chalk.yellow : chalk.green;
      return `  │   ${c(e.decision)} ${chalk.dim(e.reason)}`;
    }
    case "tool-result":
      return chalk.dim(`  │   ${e.ok ? "✓" : "✗"} ${e.output.split("\n")[0].slice(0, 90)}`);
    case "agent-finish":
      return chalk.green(`  └─ ${e.summary}`);
    case "agent-error":
      return chalk.red(`  └─ agent error: ${e.message}`);
    case "agent-stop-condition":
      return chalk.yellow(`  ■ stop: ${e.reason} (step ${e.step})`);
    case "verify-start":
      return chalk.dim(`  verify · ${e.gates} gate${e.gates === 1 ? "" : "s"}…`);
    case "verify-result":
      return `  verify   ${e.pass ? chalk.green("pass") : chalk.red("fail")} ${chalk.dim(`${e.verifier}: ${e.reason}`)}`;
    case "verify-complete":
      return e.passed ? chalk.green(`  verify · ok (${e.passes}/${e.quorum})`) : chalk.red(`  verify · FAILED (${e.passes}/${e.quorum})`);
    case "agent-budget":
    case "context-meter":
      return null; // shown in the status bar, not inline
    case "context-compacted":
      return chalk.dim(`  · context compacted (${e.removed} msgs freed)`);
    default:
      return eventLine(theme, e);
  }
}

// ── Commands (single source for /help and the live `/` menu) ─────────────────
interface CommandDef {
  name: string;
  desc: string;
  run(arg: string, ctx: Ctx): Promise<boolean | void> | boolean | void;
}

const COMMANDS: CommandDef[] = [
  { name: "help", desc: "show commands", run: (_a, ctx) => void ctx.out(helpText()) },
  {
    name: "persona",
    desc: "show identity + sigil",
    run: (_a, ctx) => {
      const id = ctx.handle.frontmatter.identity as { display_name?: string; system_identity?: { purpose?: string } } | undefined;
      ctx.out(chalk.bold(`  ${ctx.name}`));
      if (id?.system_identity?.purpose) ctx.out(`  ${chalk.dim("purpose:")} ${id.system_identity.purpose}`);
      ctx.out(sigilLines(ctx.theme, readState(ctx.handle.statePath).values).join("\n"));
    },
  },
  {
    name: "sigil",
    desc: "render the living sigil",
    run: (_a, ctx) => {
      const st = readState(ctx.handle.statePath);
      ctx.out(sigilLines(ctx.theme, st.values, 0).join("\n"));
      ctx.out(chalk.dim(`  seed #${ctx.theme.seed.toString(16)} · voice ${ctx.theme.voice.density}`));
    },
  },
  {
    name: "state",
    desc: "envelope values + mutations",
    run: (_a, ctx) => {
      const st = readState(ctx.handle.statePath);
      const env = extractEnvelopes(ctx.handle.frontmatter);
      ctx.out(chalk.bold("  Envelope values"));
      ctx.out(envelopeBars(ctx.theme, st.values, env.envelopes));
      ctx.out(chalk.dim(`  mutation_log: ${st.mutation_log.length} entries`));
    },
  },
  {
    name: "evolve",
    desc: "run one Living-Loop cycle on <text>",
    run: async (arg, ctx) => {
      if (!arg) return void ctx.out(chalk.yellow("  usage: /evolve <observation text>"));
      await ctx.loop.tick({ observation: arg, source: "user", actor: "actor-llm" }).catch((e) => ctx.out(chalk.dim(`  loop skipped: ${(e as Error).message}`)));
    },
  },
  {
    name: "do",
    desc: "hand the persona a TASK to execute (governed agent)",
    run: (arg, ctx) => runAgent(arg, ctx),
  },
  {
    name: "audit",
    desc: "mutation log + memory-chain integrity",
    run: (_a, ctx) => {
      const st = readState(ctx.handle.statePath);
      const chain = verifyMemoryChain(ctx.handle.personaPath);
      ctx.out(chalk.bold("  Mutation log (last 8)"));
      for (const m of st.mutation_log.slice(-8)) ctx.out(`  ${chalk.dim(m.ts)} ${m.field}: ${m.from} → ${m.to}${m.clamped ? chalk.yellow(" clamped") : ""}`);
      ctx.out("  memory chain: " + (chain.ok ? chalk.green("intact ✓") : chalk.red(`broken at #${chain.brokenAt}`)));
    },
  },
  {
    name: "memory",
    desc: "list recent episodic memory",
    run: (_a, ctx) => {
      const mem = readMemory(ctx.handle.personaPath);
      ctx.out(chalk.bold(`  Episodic memory (${mem.length} entries, last 6)`));
      for (const m of mem.slice(-6)) ctx.out(`  ${chalk.dim(m.ts)} ${chalk.cyan(`[${m.source}]`)} ${m.content.slice(0, 70)}`);
    },
  },
  {
    name: "overseer",
    desc: "environment view",
    run: (_a, ctx) => {
      const v = overseerView();
      ctx.out(chalk.bold.magentaBright("  overseer") + chalk.dim(` · machine ${v.machine}`));
      ctx.out(`  personas ${v.personas} · projects ${v.projects} · collections ${v.collections}`);
    },
  },
  { name: "model", desc: "show the model in use", run: (_a, ctx) => void ctx.out(chalk.dim(`  model: ${appraiserLabel()}`)) },
  {
    name: "compact",
    desc: "summarize older turns to free context",
    run: async (_a, ctx) => {
      const llm = llmConfig();
      if (!llm) return void ctx.out(chalk.dim("  /compact needs a model."));
      const r = await compactMessages([{ role: "system", content: "" }, ...ctx.conversation], ctx.meter, { llm, threshold: 0 });
      if (r.compacted) {
        ctx.conversation = r.messages.filter((m) => m.role !== "system");
        ctx.out(chalk.dim(`  compacted ${r.removed} message(s) → ${ctx.conversation.length} kept`));
      } else {
        ctx.out(chalk.dim("  nothing to compact yet."));
      }
    },
  },
  {
    name: "mode",
    desc: "show/cycle the sandbox posture (shift+tab)",
    run: (_a, ctx) => {
      ctx.postureIndex = (ctx.postureIndex + 1) % POSTURES.length;
      ctx.out(chalk.dim(`  sandbox posture → ${chalk.bold(POSTURES[ctx.postureIndex])}`));
    },
  },
  {
    name: "goal",
    desc: "set / show / clear a standing goal",
    run: (arg, ctx) => {
      const goalPath = join(dirname(ctx.handle.personaPath), "goal.json");
      if (arg === "clear") {
        if (existsSync(goalPath)) unlinkSync(goalPath);
        return void ctx.out(chalk.dim("  goal cleared."));
      }
      if (arg) {
        writeFileSync(goalPath, JSON.stringify({ text: arg, createdTs: new Date().toISOString() }, null, 2));
        return void ctx.out(chalk.green("  ✓") + ` goal set: ${arg} ${chalk.dim("(used by /do and the loop)")}`);
      }
      const g = readGoalText(ctx.handle);
      ctx.out(g ? `  ${chalk.bold("goal:")} ${g}` : chalk.dim("  no goal set. /goal <text> to set."));
    },
  },
  {
    name: "loop",
    desc: "run n governed Living-Loop ticks",
    run: async (arg, ctx) => {
      const n = Math.max(1, Math.min(20, Number(arg) || 3));
      const goal = readGoalText(ctx.handle) ?? "self-reflection";
      ctx.out(chalk.dim(`  running ${n} governed tick(s) on: ${goal}`));
      for (let i = 1; i <= n; i++) {
        await ctx.loop.tick({ observation: goal, source: "internal", actor: "runtime-context" }).catch((e) => ctx.out(chalk.dim(`  tick ${i} skipped: ${(e as Error).message}`)));
      }
    },
  },
  { name: "exit", desc: "leave the session", run: () => true },
  { name: "quit", desc: "leave the session", run: () => true },
];

/** The slash-command registry (names + descriptions) — single source of truth. */
export function listCommands(): SlashItem[] {
  return COMMANDS.filter((c) => c.name !== "quit").map((c) => ({ name: c.name, desc: c.desc }));
}

function helpText(): string {
  const lines = [chalk.bold("Commands")];
  for (const c of COMMANDS) {
    if (c.name === "quit") continue;
    lines.push(`  ${chalk.cyan(`/${c.name}`).padEnd(22)} ${chalk.dim(c.desc)}`);
  }
  lines.push("", chalk.dim("Type without a leading / to talk. /do <task> runs the governed agent."));
  return lines.join("\n");
}

async function runCommand(line: string, ctx: Ctx): Promise<boolean> {
  const name = line.slice(1).split(/\s+/)[0];
  const arg = line.slice(1 + name.length).trim();
  const cmd = COMMANDS.find((c) => c.name === name);
  if (!cmd) {
    ctx.out(chalk.yellow(`  unknown command /${name} — try /help`));
    return false;
  }
  return (await cmd.run(arg, ctx)) === true;
}

function shortName(ctx: Ctx): string {
  return ctx.name.length > 20 ? ctx.name.split(/\s+/)[0].replace(/^@/, "").slice(0, 20) : ctx.name;
}

/**
 * A turn: the persona CONVERSES and (when needed) USES TOOLS — one governed agent
 * loop, with persistent conversation + the session context meter. This unifies chat
 * and `/do`: natural language can now call tools. Offline (no model) → the honest
 * reflective responder. Identity evolution (the Living Loop) still runs each turn.
 */
async function runAgentTurn(line: string, ctx: Ctx): Promise<void> {
  const llm = llmConfig();
  if (!llm) {
    const cur = readState(ctx.handle.statePath);
    const reply = await ctx.responder
      .respond({ message: line, personaBody: ctx.handle.body, memory: readMemory(ctx.handle.personaPath).slice(-6).map((m) => m.content), state: cur.values, name: ctx.name })
      .catch((e) => `(responder error: ${(e as Error).message})`);
    ctx.out(voiceWrap(ctx.theme, `${shortName(ctx)}: ${reply}`), "persona");
    await ctx.loop.tick({ observation: line, source: "user", actor: "actor-llm" }).catch((e) => ctx.out(chalk.dim(`loop skipped: ${(e as Error).message}`)));
    return;
  }

  const fm = ctx.handle.frontmatter as Record<string, unknown>;
  const bus = new EventBus();
  bus.on((e) => {
    ctx.phase?.(phaseFor(e));
    const l = renderEvent(ctx.theme, e);
    if (l) ctx.out(l, "activity");
  });
  const obs = readObservability(fm);
  const tracer = obs.trace !== "off" ? new Tracer(bus, obs) : null;
  const agent = new PersonaAgent({
    llm,
    policy: buildPolicy(ctx),
    personaBody: ctx.handle.body,
    goal: readGoalText(ctx.handle),
    onApproval: ctx.approve,
    budget: readAgentBudget(fm),
    verification: readVerification(fm),
    judge: { endpoint: llm.endpoint, model: llm.model, apiKey: llm.apiKey },
    personaPath: ctx.handle.personaPath,
    meter: ctx.meter,
    priorMessages: ctx.conversation,
    bus,
  });
  const result = await agent.run(line);
  ctx.conversation = (agent.lastMessages ?? []).filter((m) => m.role !== "system");
  ctx.out(voiceWrap(ctx.theme, `${shortName(ctx)}: ${result.summary || "…"}`), "persona");
  // Only surface the budget line when something noteworthy happened (a multi-step
  // task or an early stop) — not on every one-shot chat reply.
  if (result.budget.steps > 1 || (result.budget.stoppedBy && result.budget.stoppedBy !== "goal_met")) {
    ctx.out(chalk.dim(`  budget: ${result.budget.steps} steps · ${result.budget.tokens} tok · $${result.budget.costUsd}` + (result.budget.stoppedBy && result.budget.stoppedBy !== "goal_met" ? ` · stopped: ${result.budget.stoppedBy}` : "")));
  }
  if (tracer) {
    const { paths } = tracer.write(ctx.handle.personaPath);
    tracer.stop();
    for (const p of paths) ctx.out(chalk.dim(`  trace → ${p}`));
  }
  await ctx.loop.tick({ observation: line, source: "user", actor: "actor-llm" }).catch((e) => ctx.out(chalk.dim(`  loop skipped: ${(e as Error).message}`)));
}

const handleTurn = runAgentTurn;
async function runAgent(task: string, ctx: Ctx): Promise<void> {
  if (!task) return void ctx.out(chalk.yellow("  usage: /do <task to accomplish>"));
  return runAgentTurn(task, ctx);
}

export async function startRepl(opts: ReplOptions = {}): Promise<void> {
  let personaPath = resolvePersonaPath(opts.persona);
  await animateLogo();

  if (!personaPath) {
    stdout.write(chalk.yellow("  No persona here yet.") + chalk.dim(" Let's create one so you can start playing.\n\n"));
    let name = "Aria";
    if (stdin.isTTY) {
      const onboard = readline.createInterface({ input: stdin, output: stdout });
      try {
        const yn = ((await onboard.question(`  Create a starter persona in ${chalk.cyan(".personaxis/")}? ${chalk.dim("[Y/n]")} `)) || "y").trim().toLowerCase();
        if (yn && yn !== "y" && yn !== "yes") {
          stdout.write(chalk.dim("  No problem. Run ") + chalk.cyan("personaxis init") + chalk.dim(" anytime, or pass ") + chalk.cyan("--persona <path>") + chalk.dim(".\n"));
          return;
        }
        name = ((await onboard.question(`  Name your persona ${chalk.dim("[Aria]")} `)) || "Aria").trim() || "Aria";
      } finally {
        onboard.close();
      }
    }
    personaPath = writeStarterPersona(process.cwd(), name);
    stdout.write(chalk.green("  ✓ ") + `created ${chalk.cyan(personaPath)} — ${chalk.bold(name)} is ready.\n`);
  }

  const handle = loadPersona(personaPath);
  ensureState(handle);
  const mode = readMode(handle.frontmatter as Record<string, unknown>);
  const name = displayName(handle.frontmatter);
  const theme = personaTheme(handle.frontmatter);
  const compiledCandidate = resolve(dirname(dirname(personaPath)), "PERSONA.md");
  const loop = new LivingLoop(personaPath, {
    appraiser: pickAppraiser(),
    recompile: makeRecompileHook(existsSync(compiledCandidate) ? compiledCandidate : undefined),
  });

  const llm0 = llmConfig();
  const meter = new ContextMeter(llm0 ? cachedContextWindow(llm0.model) : 0);
  if (llm0) void resolveContextWindow(llm0).then((w) => (meter.limit = w)).catch(() => {});

  const ctx: Ctx = {
    handle,
    loop,
    responder: pickResponder(),
    theme,
    name,
    mode,
    out: (t) => stdout.write(t + "\n"),
    postureIndex: POSTURES.indexOf(policyFromFrontmatter(handle.frontmatter as Record<string, unknown>).sandbox),
    approve: async () => "deny",
    conversation: [],
    meter,
  };
  if (ctx.postureIndex < 0) ctx.postureIndex = 1;

  if (stdin.isTTY) {
    await runScreenMode(ctx);
  } else {
    await runLineMode(ctx);
  }
}

// ── Non-TTY: simple line reader (pipes/CI) ───────────────────────────────────
async function runLineMode(ctx: Ctx): Promise<void> {
  ctx.loop.bus.on((e) => {
    const l = renderEvent(ctx.theme, e);
    if (l) stdout.write(l + "\n");
  });
  stdout.write("\n");
  await awaken(ctx.handle.frontmatter, readState(ctx.handle.statePath));
  stdout.write(voiceWrap(ctx.theme, `  ${ctx.name} is awake`) + chalk.dim(` · mode=${ctx.mode} · posture=${POSTURES[ctx.postureIndex]}\n\n`));

  const rl = readline.createInterface({ input: stdin, output: stdout });
  for await (const raw of rl) {
    const line = raw.trim();
    if (line) {
      if (line.startsWith("/")) {
        if (await runCommand(line, ctx)) break;
      } else {
        await handleTurn(line, ctx);
      }
    }
  }
  rl.close();
  await farewell(ctx.handle.frontmatter);
}

function fmtK(n: number): string {
  return n >= 1000 ? (n / 1000).toFixed(1) + "K" : String(n);
}

/** The Hermes-style context bar: model | used/limit | [bar] pct% | elapsed. */
function contextBar(ctx: Ctx): string {
  const m = ctx.meter;
  if (!m.limit) return chalk.dim("  offline — set PERSONAXIS_ENDPOINT + PERSONAXIS_MODEL");
  const pct = Math.round(m.pct * 100);
  const barW = 12;
  const filled = Math.min(barW, Math.round(m.pct * barW));
  const bar = "█".repeat(filled) + "░".repeat(barW - filled);
  const color = pct >= 80 ? chalk.red : pct >= 60 ? chalk.yellow : chalk.green;
  const el = Math.floor(m.elapsedSeconds);
  const elapsed = el >= 60 ? `${Math.floor(el / 60)}m${el % 60}s` : `${el}s`;
  const model = process.env.PERSONAXIS_MODEL ?? "model";
  return (
    chalk.dim(`  ${model} `) + chalk.dim("│ ") + color(`${fmtK(m.used)}/${fmtK(m.limit)}`) +
    chalk.dim(" │ ") + color(bar) + " " + color(`${pct}%`) + chalk.dim(` │ ${elapsed} · /help`)
  );
}

// ── TTY: full alternate-screen app ───────────────────────────────────────────
async function runScreenMode(ctx: Ctx): Promise<void> {
  const commands: SlashItem[] = COMMANDS.filter((c) => c.name !== "quit").map((c) => ({ name: c.name, desc: c.desc }));
  let screen: Screen;

  const header = (cols: number): string[] => {
    const st = readState(ctx.handle.statePath);
    return [
      "  " + chalk.bold.ansi256(ctx.theme.palette.accent)(shortName(ctx)) +
        chalk.dim(`  ·  ${auraBar(ctx.theme, st.values)}  ·  mode ${ctx.mode}  ·  posture `) + chalk.bold(POSTURES[ctx.postureIndex]),
      chalk.dim("  " + "─".repeat(Math.max(0, Math.min(cols, 80) - 2))),
    ];
  };

  screen = new Screen({
    renderHeader: header,
    renderStatus: () => contextBar(ctx),
    commands,
    onCycleMode: () => {
      ctx.postureIndex = (ctx.postureIndex + 1) % POSTURES.length;
    },
    onExit: () => screen.stop(),
    onSubmit: async (line) => {
      screen.setBusy(true, line.startsWith("/") ? "running command" : "thinking");
      try {
        if (line.startsWith("/")) {
          screen.print(chalk.dim(line), "user");
          const done = await runCommand(line, ctx);
          if (done) {
            screen.stop();
            process.exit(0);
          }
        } else {
          screen.divider();
          screen.print(chalk.cyan(line), "user");
          await handleTurn(line, ctx);
        }
      } finally {
        screen.setBusy(false);
      }
    },
  });

  ctx.out = (t, role) => screen.print(t, role ?? "system");
  ctx.phase = (label) => screen.setPhase(label);
  ctx.approve = async (call) => {
    const ans = (await screen.ask(chalk.yellow(`approve ${chalk.cyan(call.name)}?  [y]es · [a]lways · [N]o`))).trim().toLowerCase();
    return ans === "y" || ans === "yes" ? "approve" : ans === "a" || ans === "always" ? "always" : "deny";
  };
  ctx.loop.bus.on((e) => {
    const l = renderEvent(ctx.theme, e);
    if (l) screen.print(l, "activity");
  });

  screen.start();
  screen.print(voiceWrap(ctx.theme, `${shortName(ctx)} is awake`) + chalk.dim(" — talk in natural language (it can use tools), or /help."), "persona");
}
