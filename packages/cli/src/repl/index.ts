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
  prepareMemoryEntry,
  commitMemoryEntry,
  readRecompilePending,
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
  envelopeBars,
  eventLine,
  voiceWrap,
  farewell,
} from "@personaxis/tui/visual";
import { Screen, type SlashItem, type LineRole } from "@personaxis/tui/screen";
import { writeStarterPersona } from "../starter.js";
import { isSubagentPath, slugChainFromPath, slugAddressFromPath } from "../load.js";
import { runMode, isMode, MODES } from "../commands/mode.js";
import { runCompile } from "../commands/compile.js";
import { discoverTree, colorForSlug, type SubPersonaRef } from "./roster.js";

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
  /** The LLM-facing system prompt = the COMPILED PERSONA.md (slot #1), not the
   * quantitative personaxis.md body. Resources/memory are injected by the agent. */
  personaDoc: string;
  /** Fixed reply color for a sub-persona (ansi256). Undefined => root (default fg). */
  replyColor?: number;
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

/**
 * Cross-persona isolation (read-only across the roster): a persona may READ any other
 * persona's files but never WRITE them. We add deny-list regexes that match writes into
 * the `.personaxis/personas/` tree outside the persona's OWN subtree:
 *   - root persona  -> deny ALL writes under .personaxis/personas/ (it owns none of them)
 *   - sub "<slug>"  -> deny writes under .personaxis/personas/ EXCEPT .../<slug>/
 * Reads are unaffected. Deny has highest precedence in the policy engine, so this holds
 * regardless of the sandbox posture.
 */
function crossPersonaDenies(personaPath: string): string[] {
  const tree = "\\.personaxis[\\\\/]+personas[\\\\/]+";
  const chain = slugChainFromPath(personaPath);
  if (chain.length === 0) return [tree]; // root: writes none of the personas tree
  // A nested persona may write ONLY its own subtree:
  //   .personaxis/personas/<c1>/personas/<c2>/…/personas/<cn>/…
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const own = chain.map(esc).join("[\\\\/]+personas[\\\\/]+") + "[\\\\/]";
  return [`${tree}(?!${own})`];
}

function buildPolicy(ctx: Ctx): Policy {
  const base = policyFromFrontmatter(ctx.handle.frontmatter as Record<string, unknown>, process.cwd());
  return {
    ...base,
    sandbox: POSTURES[ctx.postureIndex],
    deny: [...base.deny, ...crossPersonaDenies(ctx.handle.personaPath)],
  };
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
    // Internal agent reasoning is NOT shown — the reply is printed once by the
    // caller. Only real ACTIONS (tool calls) and errors surface as activity.
    case "abstain":
    case "agent-step":
    case "agent-think":
    case "agent-finish":
      return null;
    case "tool-propose":
      return chalk.cyan(`  → ${e.tool} ${chalk.dim(JSON.stringify(e.args).slice(0, 80))}`);
    case "tool-verdict": {
      const c = e.decision === "deny" ? chalk.red : e.decision === "ask" ? chalk.yellow : chalk.green;
      return `    ${c(e.decision)} ${chalk.dim(e.reason)}`;
    }
    case "tool-result":
      return chalk.dim(`    ${e.ok ? "✓" : "✗"} ${e.output.split("\n")[0].slice(0, 90)}`);
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
    name: "improve",
    desc: "view/set self-improvement mode: locked | suggesting | autonomous",
    run: (arg, ctx) => {
      const wanted = arg.trim().toLowerCase();
      if (!wanted) {
        ctx.out(chalk.dim(`  improvement mode = ${chalk.bold(ctx.mode)}  ·  usage: /improve <${MODES.join("|")}>`));
        return;
      }
      if (!isMode(wanted)) {
        ctx.out(chalk.yellow(`  mode must be one of ${MODES.join(" | ")}`));
        return;
      }
      try {
        const r = runMode(ctx.handle.personaPath, wanted);
        ctx.mode = r.current;
        ctx.out(chalk.green(`  ✓ improvement mode → ${chalk.bold(ctx.mode)}`) + (r.changed ? "" : chalk.dim(" (unchanged)")));
      } catch (e) {
        ctx.out(chalk.red(`  could not set mode: ${(e as Error).message}`));
      }
    },
  },
  {
    name: "evolve",
    desc: "run one Living-Loop cycle on <text> (shows the governed steps)",
    run: async (arg, ctx) => {
      if (!arg) return void ctx.out(chalk.yellow("  usage: /evolve <observation text>"));
      const off = ctx.loop.bus.on((e) => {
        const l = eventLine(ctx.theme, e);
        if (l) ctx.out(l, "activity");
      });
      try {
        await ctx.loop.tick({ observation: arg, source: "user", actor: "actor-llm" });
      } catch (e) {
        ctx.out(chalk.dim(`  loop skipped: ${(e as Error).message}`));
      } finally {
        off();
      }
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

/**
 * The name shown in chat. Per the spec model this is the persona's chosen
 * identity.display_name (v0.10 short_name overrides it as an explicit chat handle);
 * it NEVER falls back to metadata.name. Falls back to canonical_id only if both are
 * absent, and truncates an over-long handle rather than dropping to the package id.
 */
function shortName(ctx: Ctx): string {
  const id = ctx.handle.frontmatter.identity as { short_name?: string; display_name?: string; canonical_id?: string } | undefined;
  const pick = id?.short_name?.trim() || id?.display_name?.trim() || id?.canonical_id?.trim() || "persona";
  return pick.length <= 32 ? pick : pick.slice(0, 31) + "…";
}

/**
 * Format a persona's reply line. The ROOT persona speaks in the terminal's default
 * foreground (white on dark, black on light) so it reads as "the" voice; a sub-persona
 * (ctx.replyColor set) gets its own FIXED, auto-assigned color so you can tell who spoke.
 * The name is always bold; only the body is tinted.
 */
function replyLine(ctx: Ctx, text: string): string {
  const name = ctx.replyColor !== undefined ? chalk.ansi256(ctx.replyColor).bold(shortName(ctx)) : chalk.bold(shortName(ctx));
  const body = ctx.replyColor !== undefined ? chalk.ansi256(ctx.replyColor)(text) : text;
  return `${name}: ${body}`;
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
      .respond({ message: line, personaBody: `You are ${shortName(ctx)}. Stay in character.\n\n${ctx.personaDoc}`, memory: readMemory(ctx.handle.personaPath).slice(-6).map((m) => m.content), state: cur.values, name: shortName(ctx) })
      .catch((e) => `(responder error: ${(e as Error).message})`);
    ctx.out(replyLine(ctx, reply), "persona");
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
    personaBody: `You are ${shortName(ctx)}. Stay in character.\n\n${ctx.personaDoc}`,
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
  ctx.out(replyLine(ctx, result.summary || "…"), "persona");
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
  // Identity evolution runs without the observe/appraise/govern noise — but we DO
  // surface a concise, meaningful summary of what actually happened this turn:
  // which envelope changed, whether memory was written, whether PERSONA.md recompiled.
  const changed: string[] = [];
  let memWrites = 0;
  let recompiled = false;
  const off = ctx.loop.bus.on((e) => {
    if (e.type === "mutate" && e.result && !e.result.blocked) {
      changed.push(`${e.result.entry.field} ${e.result.from.toFixed(2)}→${e.result.to.toFixed(2)}${e.result.clamped ? " clamped" : ""}`);
    } else if (e.type === "memory") {
      memWrites++;
    } else if (e.type === "recompile") {
      recompiled = true;
      ctx.phase?.("recompiling PERSONA.md");
    }
  });
  await ctx.loop.tick({ observation: line, source: "user", actor: "actor-llm" }).catch(() => {});
  off();
  const parts: string[] = [];
  if (changed.length) parts.push("evolved " + changed.join(", "));
  if (memWrites) parts.push(`memory +${memWrites}`);
  if (recompiled) parts.push("PERSONA.md recompiled");
  if (parts.length) ctx.out(chalk.dim("  · " + parts.join("  ·  ")));

  // If a governed self-edit marked the compiled doc stale, refresh it (H1).
  await maybeRecompile(ctx);
}

/**
 * Recompile PERSONA.md when a self-edit marked it stale (`.recompile-pending.json`). Uses the
 * authenticated `local` provider (PERSONAXIS_* env) when configured; otherwise just notifies.
 * Best-effort: a failed recompile never breaks the turn.
 */
async function maybeRecompile(ctx: Ctx): Promise<void> {
  if (!readRecompilePending(ctx.handle.personaPath).pending) return;
  if (!llmConfig()) {
    ctx.out(chalk.dim("  · PERSONA.md is stale — run `personaxis compile` to refresh it"));
    return;
  }
  try {
    ctx.phase?.("recompiling PERSONA.md");
    const address = slugAddressFromPath(ctx.handle.personaPath);
    await runCompile(address ? { slug: address, provider: "local" } : { root: true, provider: "local" });
    ctx.out(chalk.dim("  · PERSONA.md recompiled (self-edit applied)"));
  } catch (e) {
    ctx.out(chalk.dim(`  · recompile deferred: ${(e as Error).message}`));
  }
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

  const meter = makeMeter();
  const ctx = makeCtx(personaPath, meter);

  if (stdin.isTTY) {
    await runScreenMode(ctx);
  } else {
    await runLineMode(ctx);
  }
}

/** A fresh context-window meter for the session (background-resolves the real window). */
function makeMeter(): ContextMeter {
  const llm0 = llmConfig();
  const meter = new ContextMeter(llm0 ? cachedContextWindow(llm0.model) : 0);
  if (llm0) void resolveContextWindow(llm0).then((w) => (meter.limit = w)).catch(() => {});
  return meter;
}

/**
 * Build a REPL context for ANY persona (root or a sub-persona), sharing the session
 * meter. The compiled system prompt is resolved per the artifact model: a sub-persona's
 * lives INSIDE its folder (./persona.md), the root's at the repo root (../PERSONA.md).
 * `out`/`approve`/`phase` default here; the active mode runner rebinds them to the screen.
 */
function makeCtx(personaPath: string, meter: ContextMeter, replyColor?: number): Ctx {
  const handle = loadPersona(personaPath);
  ensureState(handle);
  const isSub = isSubagentPath(personaPath);
  const compiled = isSub
    ? join(dirname(personaPath), "PERSONA.md")
    : resolve(dirname(dirname(personaPath)), "PERSONA.md");
  const personaDoc = existsSync(compiled) ? readFileSync(compiled, "utf-8") : handle.body;
  const loop = new LivingLoop(personaPath, {
    appraiser: pickAppraiser(),
    recompile: makeRecompileHook(existsSync(compiled) ? compiled : undefined),
  });
  let postureIndex = POSTURES.indexOf(policyFromFrontmatter(handle.frontmatter as Record<string, unknown>).sandbox);
  if (postureIndex < 0) postureIndex = 1;
  return {
    handle,
    loop,
    responder: pickResponder(),
    theme: personaTheme(handle.frontmatter),
    name: displayName(handle.frontmatter),
    mode: readMode(handle.frontmatter as Record<string, unknown>),
    out: (t) => stdout.write(t + "\n"),
    postureIndex,
    approve: async () => "deny",
    personaDoc,
    conversation: [],
    meter,
    replyColor,
  };
}

// ── Non-TTY: simple line reader (pipes/CI) ───────────────────────────────────
async function runLineMode(ctx: Ctx): Promise<void> {
  stdout.write("\n");
  await awaken(ctx.handle.frontmatter, readState(ctx.handle.statePath));
  stdout.write(voiceWrap(ctx.theme, `  ${ctx.name} is awake`) + chalk.dim(` · mode=${ctx.mode} · posture=${POSTURES[ctx.postureIndex]}\n\n`));

  const roster = buildRoster(ctx);
  if (roster.subs.length) {
    stdout.write(chalk.dim(`  sub-personas: `) + roster.subs.map((s) => chalk.ansi256(roster.color(s.address) ?? 39).bold(`@${s.address}`)).join("  ") + chalk.dim(`  ·  @address · @all\n\n`));
  }

  const rl = readline.createInterface({ input: stdin, output: stdout });
  for await (const raw of rl) {
    const line = raw.trim();
    if (line) {
      if (line.startsWith("/")) {
        if (await runCommand(line, ctx)) break;
      } else {
        await dispatchTurn(line, ctx, roster);
      }
    }
  }
  rl.close();
  await farewell(ctx.handle.frontmatter);
}


function fmtK(n: number): string {
  return n >= 1000 ? (n / 1000).toFixed(1) + "K" : String(n);
}

/**
 * Parse leading @mentions for multi-persona routing, by hierarchical address:
 *   `@all`         → every sub-persona in the tree
 *   `@cmo`         → the sub-persona "cmo"
 *   `@cmo/legal`   → the nested sub-persona "cmo/legal"
 *   `@cmo/all`     → every persona in cmo's subtree
 * One or more mentions may lead the line. Unknown @tokens are left in the message (so an
 * email/handle isn't mis-routed). No mention => the ROOT persona.
 */
export function parseMentions(line: string, subs: SubPersonaRef[]): { targets: string[]; rest: string } {
  const byAddr = new Set(subs.map((s) => s.address));
  let rest = line.trim();
  const targets: string[] = [];
  for (;;) {
    const m = rest.match(/^@([A-Za-z0-9_/-]+)\s*/);
    if (!m) break;
    const tok = m[1].replace(/\/$/, "");
    if (tok === "all") {
      for (const s of subs) targets.push(s.address);
    } else if (tok.endsWith("/all")) {
      const pre = tok.slice(0, -3); // keep trailing "/"
      for (const s of subs) if (s.address.startsWith(pre)) targets.push(s.address);
    } else if (byAddr.has(tok)) {
      targets.push(tok);
    } else {
      break; // unknown — leave it in the message
    }
    rest = rest.slice(m[0].length);
  }
  return { targets: [...new Set(targets)], rest: rest.trim() };
}

interface Roster {
  subs: SubPersonaRef[];
  color: (address: string) => number | undefined;
  getSub: (address: string) => Ctx | undefined;
}

/**
 * Build the multi-persona roster for a root context: discover the whole sub-persona tree,
 * assign each a fixed color (by full address), lazily materialize a Ctx per sub (sharing the
 * root's screen + meter), and make the root aware of the tree it can delegate to.
 */
function buildRoster(rootCtx: Ctx): Roster {
  const subs = discoverTree(rootCtx.handle.personaPath);
  const subColor = new Map<string, number>();
  const taken = new Set<number>();
  for (const s of subs) subColor.set(s.address, colorForSlug(s.address, taken));
  const cache = new Map<string, Ctx>();
  const getSub = (address: string): Ctx | undefined => {
    const ref = subs.find((s) => s.address === address);
    if (!ref) return undefined;
    let c = cache.get(address);
    if (!c) {
      c = makeCtx(ref.path, rootCtx.meter, subColor.get(address));
      c.out = rootCtx.out;
      c.approve = rootCtx.approve;
      c.phase = rootCtx.phase;
      cache.set(address, c);
    }
    return c;
  };
  if (subs.length) {
    rootCtx.personaDoc +=
      `\n\n## Sub-personas you can delegate to\nAddress with @address (also @all, or @parent/all). You may READ their files but never edit them.\n` +
      subs.map((s) => `${"  ".repeat(s.depth - 1)}- @${s.address}`).join("\n");
  }
  return { subs, color: (a) => subColor.get(a), getSub };
}

/**
 * Route one user line to the ROOT or to addressed sub-personas (@address/@all). Replies come
 * from each target; every delegation is recorded in the root's hash-chained memory.
 */
async function dispatchTurn(line: string, rootCtx: Ctx, roster: Roster, setPhase?: (s: string) => void): Promise<void> {
  const { targets, rest } = parseMentions(line, roster.subs);
  const msg = rest || line;
  if (targets.length === 0) {
    await handleTurn(msg, rootCtx);
    return;
  }
  for (const addr of targets) {
    const sub = roster.getSub(addr);
    if (!sub) {
      rootCtx.out(chalk.yellow(`  no sub-persona @${addr}`));
      continue;
    }
    setPhase?.(`@${addr} thinking`);
    await handleTurn(msg, sub);
    try {
      commitMemoryEntry(
        rootCtx.handle.personaPath,
        prepareMemoryEntry(rootCtx.handle.personaPath, {
          content: `Delegated to @${addr}: "${msg.slice(0, 120)}"`,
          source: "synthesis",
          tags: ["delegation", addr],
        }),
      );
    } catch {
      /* memory write is best-effort */
    }
  }
}

// ── TTY: minimalist interactive REPL in the NORMAL buffer ────────────────────
async function runScreenMode(ctx: Ctx): Promise<void> {
  const commands: SlashItem[] = COMMANDS.filter((c) => c.name !== "quit").map((c) => ({ name: c.name, desc: c.desc }));
  let screen: Screen;
  let lastMs = 0;

  const roster = buildRoster(ctx);

  // Status line shown BELOW the input. Labels are explicit so "locked" etc. are
  // unambiguous. Width-aware: drops low-priority segments on narrow terminals.
  const status = (): string => {
    const m = ctx.meter;
    const cols = stdout.columns ?? 80;
    const seg: string[] = [];
    seg.push(m.limit ? `ctx ${fmtK(m.used)}/${fmtK(m.limit)} ${Math.round(m.pct * 100)}%` : "offline");
    if (lastMs) seg.push(`reply ${(lastMs / 1000).toFixed(1)}s`);
    seg.push(`improve:${ctx.mode}`);
    if (cols >= 64) seg.push(`sandbox:${POSTURES[ctx.postureIndex]}`);
    if (cols >= 86) seg.push("shift+tab");
    return chalk.dim("  " + seg.join("  ·  "));
  };

  screen = new Screen({
    prompt: () => chalk.bold("› "),
    status,
    commands,
    onCycleMode: () => {
      ctx.postureIndex = (ctx.postureIndex + 1) % POSTURES.length;
    },
    onExit: () => screen.stop(),
    onSubmit: async (line) => {
      if (line.startsWith("/")) {
        screen.print(chalk.dim(`  ${line}`));
        const done = await runCommand(line, ctx);
        if (done) {
          screen.stop();
          await farewell(ctx.handle.frontmatter);
          process.exit(0);
        }
        return;
      }
      // Chat/agent turn — route to the ROOT or to sub-personas via @mentions.
      screen.print("");
      screen.print(chalk.bgAnsi256(238).whiteBright(`  › ${line}  `), "user");
      screen.setBusy(true, "thinking");
      const t0 = Date.now();
      try {
        await dispatchTurn(line, ctx, roster, (p) => screen.setPhase(p));
      } finally {
        screen.setBusy(false);
      }
      lastMs = Date.now() - t0;
    },
  });

  ctx.out = (t, role) => screen.print(t, role ?? "system");
  ctx.phase = (label) => screen.setPhase(label);
  ctx.approve = async (call) => {
    const ans = (await screen.ask(`  approve ${chalk.cyan(call.name)}?  [y]es · [a]lways · [N]o`)).trim().toLowerCase();
    return ans === "y" || ans === "yes" ? "approve" : ans === "a" || ans === "always" ? "always" : "deny";
  };

  screen.start();
  screen.print(replyLine(ctx, "awake — talk naturally (it can use tools), /help for commands, ctrl+c to exit."), "persona");
  if (roster.subs.length) {
    const tags = roster.subs.map((s) => chalk.ansi256(roster.color(s.address) ?? 39).bold(`@${s.address}`)).join("  ");
    screen.print(chalk.dim(`  sub-personas: `) + tags + chalk.dim("  ·  @address · @all · @parent/all"));
  }
}
