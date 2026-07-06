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
import { resolve, join, dirname, relative } from "node:path";
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
  readMemoryTypes,
  prepareMemoryEntry,
  commitMemoryEntry,
  proposals,
  activeOverlay,
  applySelfEdit,
  rejectSelfEdit,
  readProcedural,
  readAutobiographical,
  readPreferences,
  readEvaluations,
  readSemanticMemory,
  newSessionId,
  ensureSession,
  appendTurn,
  loadConversation,
  listSessions,
  renameSession,
  findSession,
  fallbackName,
  nameSession,
  recordCompaction,
  readRecompilePending,
  verifyMemoryChain,
  overseerView,
  personaTheme,
  policyFromFrontmatter,
  readAgentBudget,
  readVerification,
  readObservability,
  Tracer,
  ContextMeter,
  compactMessages,
  makeRecompileHook,
} from "@personaxis/core";
import {
  animateLogo,
  awaken,
  sigilLines,
  envelopeBars,
  voiceWrap,
  farewell,
} from "@personaxis/tui/visual";
import { Screen, type SlashItem } from "@personaxis/tui/screen";
import { renderFrame } from "@personaxis/tui";
import { writeStarterPersona } from "../starter.js";
import { isSubagentPath, slugAddressFromPath } from "../load.js";
import { runMode, isMode, MODES } from "../commands/improve.js";
import { runCompile } from "../commands/compile.js";
import { setModelSetting } from "../config.js";
import { installHook, HOSTS } from "../commands/hooks.js";
import { validatePersona } from "../schema.js";
import { lint } from "../linter/index.js";
import { loadPersonaFile } from "../load.js";
import { discoverTree, colorForSlug, type SubPersonaRef } from "./roster.js";
import { buildAwarenessBlock } from "./awareness.js";
import { buildResourceManifest } from "../resource-manifest.js";
import type { Ctx, ReplOptions, CommandDef } from "./types.js";
import {
  CANDIDATES,
  POSTURES,
  resolvePersonaPath,
  notePostureChange,
  llmConfig,
  ctxModelArg,
  pickAppraiser,
  pickResponder,
  appraiserLabel,
  crossPersonaDenies,
  buildPolicy,
  readGoalText,
  makeMeter,
} from "./config.js";
import { phaseFor, renderEvent, shortName, personaGlyph, replyLine, fmtK, firstRunModelHint } from "./render.js";
import { stopDaemons, startStopDaemon, runCliPassthrough } from "./daemons.js";

// Re-exported for the REPL's public surface (tests + the CLI entry import these).
export { notePostureChange } from "./config.js";

// Session context, config/model helpers, and event rendering moved to
// ./types, ./config, ./render (F3.6 split).

// ── Commands (single source for /help and the live `/` menu) ─────────────────
const COMMANDS: CommandDef[] = [
  { name: "help", desc: "show commands", run: (_a, ctx) => void ctx.out(helpText()) },
  {
    name: "persona",
    desc: "identity, role, sub-personas, resources + sigil",
    run: (_a, ctx) => {
      const p = ctx.handle.personaPath;
      const id = ctx.handle.frontmatter.identity as { display_name?: string; system_identity?: { purpose?: string } } | undefined;
      const address = slugAddressFromPath(p);
      const role = isSubagentPath(p) && address ? `sub-persona @${address}` : "root persona";
      ctx.out(chalk.bold(`  ${ctx.name}`) + chalk.dim(`  · ${role}`));
      if (id?.system_identity?.purpose) ctx.out(`  ${chalk.dim("purpose:")} ${id.system_identity.purpose}`);
      ctx.out(chalk.dim(`  improve: ${ctx.mode} · sandbox: ${POSTURES[ctx.postureIndex]}`));
      // sub-personas this persona can delegate to
      const subs = discoverTree(p);
      if (subs.length) {
        ctx.out(chalk.bold("  Sub-personas"));
        for (const s of subs) ctx.out(`  ${"  ".repeat(s.depth - 1)}${chalk.cyan(`@${s.address}`)}`);
      }
      // resource inventory beside the spec
      const manifest = buildResourceManifest(dirname(p));
      if (manifest.trim()) {
        ctx.out(chalk.bold("  Resources"));
        for (const line of manifest.split("\n")) ctx.out(`  ${chalk.dim(line.replace(/^- /, ""))}`);
      }
      // the living sigil (sober microdetail)
      ctx.out(sigilLines(ctx.theme, readState(ctx.handle.statePath).values).join("\n"));
      ctx.out(chalk.dim(`  seed #${ctx.theme.seed.toString(16)} · voice ${ctx.theme.voice.density}`));
    },
  },
  {
    name: "dash",
    desc: "snapshot of the living dashboard (sigil + envelopes + memory chain)",
    run: (_a, ctx) => {
      // A single inline frame — the REPL owns the TTY, so we don't take over the screen.
      // For the animated live view, run `personaxis dash` in a second terminal.
      for (const line of renderFrame(ctx.handle.personaPath, 0).split("\n")) ctx.out(line);
      ctx.out(chalk.dim(`  live view: `) + chalk.cyan(`personaxis dash -p ${relative(process.cwd(), ctx.handle.personaPath) || ctx.handle.personaPath}`) + chalk.dim(" (second terminal — animates as this session evolves)"));
    },
  },
  {
    name: "state",
    desc: "live mutable surface: envelopes + applied self-edits + pending proposals",
    run: (_a, ctx) => {
      const p = ctx.handle.personaPath;
      const st = readState(ctx.handle.statePath);
      const env = extractEnvelopes(ctx.handle.frontmatter);
      // (1) quantitative — the numeric envelope state.
      ctx.out(chalk.bold("  Envelope values") + chalk.dim("  (quantitative)"));
      ctx.out(envelopeBars(ctx.theme, st.values, env.envelopes));
      ctx.out(chalk.dim(`  mutation_log: ${st.mutation_log.length} entries`));
      // (2) qualitative — self-edits already APPLIED to the spec (the overlay). This is the rest of
      // the mutable surface beyond the 9 numbers: any non-protected section may live here now.
      const overlay = activeOverlay(p);
      const keys = Object.keys(overlay);
      ctx.out(chalk.bold("  Applied self-edits") + chalk.dim("  (qualitative overlay)"));
      if (!keys.length) ctx.out(chalk.dim("  (none) — no spec section has self-evolved yet"));
      else for (const k of keys) ctx.out(`  ${chalk.cyan(k)} ${chalk.dim("→ " + JSON.stringify(overlay[k]).slice(0, 72))}`);
      // (3) governance queue — proposals awaiting /review.
      const pending = proposals(p).filter((x) => x.status === "pending");
      if (pending.length) ctx.out(chalk.yellow(`  ${pending.length} pending proposal(s)`) + chalk.dim(" — /review"));
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
    name: "review",
    desc: "review queued self-edits: /review [approve|reject] <id|all>",
    run: async (arg, ctx) => {
      const p = ctx.handle.personaPath;
      const pending = proposals(p).filter((x) => x.status === "pending");
      const [verb, which] = arg.trim().split(/\s+/).filter(Boolean);
      if (!verb) {
        if (!pending.length) return void ctx.out(chalk.dim("  no pending self-edit proposals."));
        ctx.out(chalk.bold(`  Pending self-edits (${pending.length})`));
        for (const x of pending) {
          ctx.out(`  ${chalk.cyan(x.id)} ${chalk.dim(x.targetPath)}`);
          ctx.out(`     → ${chalk.dim(JSON.stringify(x.toValue).slice(0, 100))}`);
          ctx.out(`     ${chalk.dim(x.rationale)}`);
        }
        ctx.out(chalk.dim("  /review approve <id|all>  ·  /review reject <id|all>"));
        return;
      }
      if (verb !== "approve" && verb !== "reject") return void ctx.out(chalk.yellow("  usage: /review [approve|reject] <id|all>"));
      if (!which) return void ctx.out(chalk.yellow(`  usage: /review ${verb} <id|all>`));
      const targets = which === "all" ? pending : pending.filter((x) => x.id === which);
      if (!targets.length) return void ctx.out(chalk.yellow(`  no pending proposal "${which}" — see /review`));
      let approved = 0;
      for (const x of targets) {
        try {
          if (verb === "approve") {
            const r = applySelfEdit(p, x.id, "user");
            approved++;
            ctx.out(chalk.green(`  ✓ applied ${x.id}`) + chalk.dim(` ${x.targetPath} → v${r.version}`));
          } else {
            rejectSelfEdit(p, x.id, "user");
            ctx.out(chalk.dim(`  ✗ rejected ${x.id} ${x.targetPath}`));
          }
        } catch (e) {
          ctx.out(chalk.red(`  ${x.id}: ${(e as Error).message}`));
        }
      }
      if (approved > 0) await maybeRecompile(ctx);
    },
  },
  {
    name: "compile",
    desc: "recompile PERSONA.md from the (evolved) spec — explicit, may take a moment",
    run: async (_a, ctx) => {
      if (!readRecompilePending(ctx.handle.personaPath).pending) {
        return void ctx.out(chalk.dim("  PERSONA.md is already up to date."));
      }
      if (!llmConfig(ctxModelArg(ctx))) return void ctx.out(chalk.dim("  needs a model — configure with /model or `personaxis config set --global local.endpoint/model`."));
      ctx.out(chalk.dim("  recompiling PERSONA.md from the evolved spec…"));
      await maybeRecompile(ctx);
    },
  },
  {
    name: "audit",
    desc: "mutation log + memory-chain integrity + self-edit ledger + recent evaluations",
    run: (_a, ctx) => {
      const p = ctx.handle.personaPath;
      const st = readState(ctx.handle.statePath);
      const chain = verifyMemoryChain(p);
      ctx.out(chalk.bold("  Mutation log (last 8)"));
      for (const m of st.mutation_log.slice(-8)) ctx.out(`  ${chalk.dim(m.ts)} ${m.field}: ${m.from} → ${m.to}${m.clamped ? chalk.yellow(" clamped") : ""}`);
      ctx.out("  memory chain: " + (chain.ok ? chalk.green("intact ✓") : chalk.red(`broken at #${chain.brokenAt}`)));
      // self-edit ledger — what the persona changed about ITSELF, and the governance verdict.
      const all = proposals(p);
      if (all.length) {
        ctx.out(chalk.bold("  Self-edit ledger (last 6)"));
        for (const x of all.slice(-6)) {
          const c = x.status === "applied" ? chalk.green : x.status === "pending" ? chalk.yellow : chalk.red;
          ctx.out(`  ${chalk.dim(x.id)} ${c(x.status)} ${chalk.dim(x.targetPath)}`);
        }
      }
      // evaluations — quality/utility scores, with the target + dimension + score that "+N eval(s)" hid.
      const evals = readEvaluations(p);
      if (evals.length) {
        ctx.out(chalk.bold(`  Evaluations (${evals.length}, last 6)`));
        for (const ev of evals.slice(-6)) {
          const c = ev.score >= 0.66 ? chalk.green : ev.score >= 0.33 ? chalk.yellow : chalk.red;
          ctx.out(`  ${chalk.dim(ev.target)} ${ev.dimension} ${c(ev.score.toFixed(2))} ${chalk.dim(ev.rationale)}`);
        }
      }
    },
  },
  {
    name: "memory",
    desc: "all declared memory kinds: episodic, semantic, procedural, autobiographical, preferences, evaluations",
    run: (_a, ctx) => {
      const p = ctx.handle.personaPath;
      const types = readMemoryTypes(ctx.handle.frontmatter as Record<string, unknown>);
      // A small helper: a header + recent rows, or a one-line "(off)" / "(empty)" note per kind.
      const section = (label: string, enabled: boolean, rows: string[]): void => {
        if (!enabled) return void ctx.out(chalk.bold(`  ${label}`) + chalk.dim("  (off in memory.types)"));
        ctx.out(chalk.bold(`  ${label}`) + chalk.dim(`  (${rows.length})`));
        if (!rows.length) return void ctx.out(chalk.dim("  (empty)"));
        for (const r of rows.slice(-4)) ctx.out(`  ${r}`);
      };
      const epi = readMemory(p);
      section("Episodic", types.episodic, epi.map((m) => `${chalk.dim(m.ts.slice(0, 19))} ${chalk.cyan(`[${m.source}]`)} ${m.content.slice(0, 64)}`));
      // semantic lives in memory.md (consolidated); show the first few non-empty lines.
      const sem = readSemanticMemory(p).split("\n").map((l) => l.trim()).filter(Boolean).map((l) => chalk.dim(l.slice(0, 70)));
      section("Semantic (memory.md)", types.semantic, sem);
      section("Procedural", types.procedural, readProcedural(p).map((x) => `${chalk.dim(x.ts.slice(0, 19))} ${x.task.slice(0, 40)} → ${chalk.dim(x.procedure.slice(0, 40))}`));
      section("Autobiographical", types.autobiographical, readAutobiographical(p).map((x) => `${chalk.dim(x.ts.slice(0, 19))} ${x.event}${x.detail ? chalk.dim(`: ${x.detail.slice(0, 40)}`) : ""}`));
      const prefs = Object.entries(readPreferences(p));
      section("User preferences", types.user_preferences, prefs.map(([k, v]) => `${chalk.cyan(k)} = ${v.value.slice(0, 50)}`));
      section("Evaluations", types.evaluations, readEvaluations(p).map((ev) => `${chalk.dim(ev.target)} ${ev.dimension} ${ev.score.toFixed(2)} ${chalk.dim(ev.rationale.slice(0, 40))}`));
    },
  },
  {
    name: "overseer",
    desc: "cross-machine/project registry view (optional infra)",
    run: (_a, ctx) => {
      const v = overseerView();
      ctx.out(chalk.bold.magentaBright("  overseer") + chalk.dim(` · machine ${v.machine}`));
      ctx.out(`  personas ${v.personas} · projects ${v.projects} · collections ${v.collections}`);
      if (v.personas === 0 && v.projects === 0 && v.collections === 0) {
        ctx.out(chalk.dim("  (empty) the overseer is OPTIONAL infra for reusing a persona across machines/projects,"));
        ctx.out(chalk.dim("  complementing git — not replacing it. Populate with: personaxis personas import <path> · personaxis overseer register <slug>"));
      }
    },
  },
  {
    name: "model",
    desc: "show the model, or set it: /model set <endpoint|model|key-env> <value> [global]",
    run: (arg, ctx) => {
      const parts = arg.trim().split(/\s+/).filter(Boolean);
      if (parts[0] !== "set") {
        ctx.out(chalk.dim(`  model: ${appraiserLabel(ctxModelArg(ctx))}`));
        ctx.out(chalk.dim(`  set (stored in ~/.personaxis, reused everywhere):`));
        ctx.out(chalk.dim(`    /model set endpoint <url> · /model set model <name> · /model set key <API_KEY> · /model set key-env <ENV_VAR>`));
        ctx.out(chalk.dim(`    (append 'project' to write the project config instead of global; per-persona lives in the spec's runtime block)`));
        return;
      }
      const [, key, value, scope] = parts;
      if (!key || !value) return void ctx.out(chalk.yellow("  usage: /model set <endpoint|model|key|key-env> <value> [project]"));
      // Config is GLOBAL by default (reused across projects); pass 'project' to scope it locally.
      const global = scope !== "project";
      const isSecret = key === "key";
      try {
        setModelSetting(key, value, global);
        const shown = isSecret ? value.slice(0, 3) + "…" + value.slice(-2) : value;
        ctx.out(chalk.green(`  ✓ ${key} = ${shown}`) + chalk.dim(` (${global ? "global ~/.personaxis" : "project .personaxis"}/config.json)`));
        if (isSecret) ctx.out(chalk.dim("  key stored user-only (0600), reused across all projects — no env var needed."));
        ctx.out(chalk.dim(`  now: ${appraiserLabel(ctxModelArg(ctx))}`));
      } catch (e) {
        ctx.out(chalk.red(`  ${(e as Error).message}`));
      }
    },
  },
  {
    name: "config",
    desc: "show the resolved model config + where it lives (set with /model set)",
    run: (_a, ctx) => {
      ctx.out(chalk.bold("  Model config") + chalk.dim("  (env > project > global; per-persona via the spec's runtime block)"));
      ctx.out(`  ${chalk.cyan("resolved")}  ${appraiserLabel(ctxModelArg(ctx))}`);
      ctx.out(chalk.dim(`  global   ~/.personaxis/config.json   ·   project   .personaxis/config.json`));
      ctx.out(chalk.dim(`  set from here: /model set <endpoint|model|key|key-env> <value> [project]`));
    },
  },
  {
    name: "hooks",
    desc: "install the end-of-turn learning hook for a host: /hooks <claude-code|codex|openclaw|hermes> [global]",
    run: (arg, ctx) => {
      const [host, scope] = arg.trim().split(/\s+/).filter(Boolean);
      if (!host || !(HOSTS as readonly string[]).includes(host)) {
        return void ctx.out(chalk.yellow(`  usage: /hooks <${HOSTS.join("|")}> [global]`));
      }
      try {
        const r = installHook(host as (typeof HOSTS)[number], scope === "global");
        ctx.out((r.already ? chalk.dim("  · already installed at ") : chalk.green("  ✓ installed at ")) + chalk.cyan(r.path));
        ctx.out(chalk.dim(`  each turn now feeds a governed tick on your model (no host tokens).${r.extra}`));
      } catch (e) {
        ctx.out(chalk.red(`  ${(e as Error).message}`));
      }
    },
  },
  {
    name: "validate",
    desc: "validate this persona's spec against the schema + universals",
    run: (_a, ctx) => {
      const r = validatePersona(loadPersonaFile(ctx.handle.personaPath).data);
      const color = r.status === "PASS" ? chalk.green : r.status.startsWith("PASS") ? chalk.yellow : chalk.red;
      ctx.out(`  ${color(r.status)}` + chalk.dim(` · ${r.errors.length} error(s), ${r.warnings.length} warning(s)`));
      for (const e of [...r.errors, ...r.warnings].slice(0, 8)) ctx.out(chalk.dim(`    · ${e.field}: ${e.message}`));
    },
  },
  {
    name: "lint",
    desc: "lint this persona's spec (tier-aware findings)",
    run: (_a, ctx) => {
      const report = lint(readFileSync(ctx.handle.personaPath, "utf-8"));
      if (report.findings.length === 0) return void ctx.out(chalk.green("  ✓ no lint findings"));
      ctx.out(chalk.bold(`  ${report.summary.errors} error(s) · ${report.summary.warnings} warning(s) · ${report.summary.infos} info`));
      for (const f of report.findings.slice(0, 12)) {
        const c = f.severity === "error" ? chalk.red : f.severity === "warning" ? chalk.yellow : chalk.dim;
        ctx.out(`  ${c(f.severity)} ${chalk.dim(f.rule)} — ${f.message}`);
      }
    },
  },
  {
    name: "init",
    desc: "scaffold a NEW sub-persona under this project: /init <name>",
    run: (arg, ctx) => {
      const name = arg.trim();
      if (!name) return void ctx.out(chalk.yellow("  usage: /init <name>   (creates a sub-persona; the root already exists in this session)"));
      try {
        const path = writeStarterPersona(process.cwd(), name, name);
        const slug = path.split(/[\\/]+/).slice(-2)[0];
        ctx.out(chalk.green("  ✓ created sub-persona ") + chalk.cyan(`@${slug}`) + chalk.dim(` → ${relative(process.cwd(), path).replace(/\\/g, "/")}`));
        ctx.out(chalk.dim(`  next: fill it in, then /compile ${slug} (or address it with @${slug} …)`));
      } catch (e) {
        ctx.out(chalk.red(`  ${(e as Error).message}`));
      }
    },
  },
  {
    name: "serve",
    desc: "start/stop the HTTP server in the background: /serve [port] · /serve stop",
    run: (arg, ctx) => startStopDaemon("serve", arg, ctx, (port) => ["serve", "--persona", ctx.handle.personaPath, "--port", port || "7637"], (port) => `http://localhost:${port || "7637"} (curl /agents.md)`),
  },
  {
    name: "watch",
    desc: "start/stop the freshness daemon in the background: /watch · /watch stop",
    run: (arg, ctx) => startStopDaemon("watch", arg, ctx, () => ["watch", "--persona", ctx.handle.personaPath], () => "recompiling PERSONA.md on spec edits + drift"),
  },
  {
    name: "compact",
    desc: "summarize older turns to free context",
    run: async (_a, ctx) => {
      const llm = llmConfig(ctxModelArg(ctx));
      if (!llm) return void ctx.out(chalk.dim("  /compact needs a model — configure with /model."));
      const r = await compactMessages([{ role: "system", content: "" }, ...ctx.conversation], ctx.meter, { llm, threshold: 0 });
      if (r.compacted) {
        ctx.conversation = r.messages.filter((m) => m.role !== "system");
        // PERSIST the checkpoint so leaving and /resume returns the COMPACTED conversation, not the
        // raw bloat — the user shouldn't have to /compact again after re-entering the same session.
        if (r.summary) {
          ensureCtxSession(ctx, ctx.conversation[0]?.content ?? "session");
          recordCompaction(ctx.handle.personaPath, ctx.sessionId, r.summary);
        }
        ctx.out(chalk.dim(`  compacted ${r.removed} message(s) → ${ctx.conversation.length} kept · persisted (survives /resume)`));
      } else {
        ctx.out(chalk.dim("  nothing to compact yet."));
      }
    },
  },
  {
    name: "sessions",
    desc: "list saved conversations (/resume to continue one)",
    run: (_a, ctx) => {
      const list = listSessions(ctx.handle.personaPath);
      if (!list.length) return void ctx.out(chalk.dim("  no saved sessions yet."));
      ctx.out(chalk.bold(`  Sessions (${list.length})`));
      for (const s of list.slice(0, 12)) {
        const when = s.updated.slice(0, 16).replace("T", " ");
        const live = s.id === ctx.sessionId ? chalk.green(" ● live") : "";
        ctx.out(`  ${chalk.cyan(s.name)}${live} ${chalk.dim(`· ${s.turns} turn(s) · ${when} · ${s.id}`)}`);
      }
    },
  },
  {
    name: "resume",
    desc: "resume a saved conversation: /resume <id|name>",
    run: async (arg, ctx) => {
      const q = arg.trim();
      if (!q) return void ctx.out(chalk.dim("  usage: /resume <id|name> — see /sessions"));
      const s = findSession(ctx.handle.personaPath, q);
      if (!s) return void ctx.out(chalk.yellow(`  no session matching "${q}" — see /sessions`));
      const conv = loadConversation(ctx.handle.personaPath, s.id);
      ctx.conversation = conv;
      ctx.sessionId = s.id;
      ctx.sessionStarted = true;
      ctx.sessionNamed = true;
      ctx.meter.estimate([{ role: "system", content: "" }, ...conv]);
      ctx.out(chalk.green(`  ✓ resumed "${s.name}"`) + chalk.dim(` · ${conv.length} message(s) restored`));
    },
  },
  {
    name: "mode",
    desc: "show/cycle the sandbox posture (shift+tab)",
    run: (_a, ctx) => {
      ctx.postureIndex = (ctx.postureIndex + 1) % POSTURES.length;
      notePostureChange(ctx);
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
  { name: "exit", desc: "leave the session", run: (_a, ctx) => { stopDaemons(ctx); return true; } },
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
  lines.push("", chalk.dim("Type without a leading / to talk — natural language both converses AND uses tools (one governed agent loop)."));
  return lines.join("\n");
}

/** CLI subcommands handled specially in the REPL (native or background), so the passthrough skips them. */
const REPL_UNAVAILABLE: Record<string, string> = {
  observe: "the living loop already runs a governed tick every turn — feed a one-off with `personaxis observe --observation \"…\"`",
};

async function runCommand(line: string, ctx: Ctx): Promise<boolean> {
  const name = line.slice(1).split(/\s+/)[0];
  const arg = line.slice(1 + name.length).trim();
  const cmd = COMMANDS.find((c) => c.name === name);
  if (cmd) return (await cmd.run(arg, ctx)) === true;

  // Not a native `/command` — fall through to the CLI so EVERY subcommand is reachable from the app
  // (export, decompile, diff, spec, orchestrate, team, skills, scan, personas, migrate, push/pull, …).
  if (REPL_UNAVAILABLE[name]) {
    ctx.out(chalk.dim(`  /${name}: ${REPL_UNAVAILABLE[name]}.`));
    return false;
  }
  runCliPassthrough(name, arg, ctx);
  return false;
}

/**
 * A turn: the persona CONVERSES and (when needed) USES TOOLS — one governed agent
 * loop, with persistent conversation + the session context meter. This unifies chat
 * and `/do`: natural language can now call tools. Offline (no model) → the honest
 * reflective responder. Identity evolution (the Living Loop) still runs each turn.
 */
async function runAgentTurn(line: string, ctx: Ctx): Promise<void> {
  const llm = llmConfig(ctxModelArg(ctx));
  if (!llm) {
    const cur = readState(ctx.handle.statePath);
    const reply = await ctx.responder
      .respond({ message: line, personaBody: `You are ${shortName(ctx)}. Stay in character.\n\n${ctx.personaDoc}`, memory: readMemory(ctx.handle.personaPath).slice(-6).map((m) => m.content), state: cur.values, name: shortName(ctx) })
      .catch((e) => `(responder error: ${(e as Error).message})`);
    ctx.out(replyLine(ctx, reply), "persona");
    await recordTurn(ctx, line, reply);
    await ctx.loop.tick({ observation: line, source: "user", actor: "actor-llm" }).catch((e) => ctx.out(chalk.dim(`loop skipped: ${(e as Error).message}`)));
    return;
  }

  const fm = ctx.handle.frontmatter as Record<string, unknown>;
  const bus = new EventBus();
  // Which memories were RECALLED to answer this turn (emitted by the agent's resumeContext
  // before the loop listener below exists) — collected here for the concise per-turn summary.
  const recalls: string[] = [];
  bus.on((e) => {
    ctx.phase?.(phaseFor(e));
    if (e.type === "memory-recall") recalls.push(`${e.kind}×${e.count}${e.detail ? ` (${e.detail})` : ""}`);
    const l = renderEvent(ctx.theme, e);
    if (l) ctx.out(l, "activity");
  });
  const obs = readObservability(fm);
  const tracer = obs.trace !== "off" ? new Tracer(bus, obs) : null;
  const agent = new PersonaAgent({
    llm,
    policy: buildPolicy(ctx),
    personaBody: `You are ${shortName(ctx)}. Stay in character.\n\n${ctx.personaDoc}`,
    awareness: buildAwarenessBlock(ctx.handle.personaPath),
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
  // If the sandbox posture just changed, prepend a one-shot environment note so the model
  // RE-EVALUATES (and retries) a request it may have declined under the old posture, instead of
  // parroting its previous refusal from the conversation history. The note is NOT persisted to the
  // session (recordTurn stores the real user line).
  const taskLine = ctx.pendingEnvNote ? `${ctx.pendingEnvNote}\n\n${line}` : line;
  ctx.pendingEnvNote = undefined;
  const result = await agent.run(taskLine);
  ctx.conversation = (agent.lastMessages ?? []).filter((m) => m.role !== "system");
  ctx.out(replyLine(ctx, result.summary || "…"), "persona");
  await recordTurn(ctx, line, result.summary || "…");
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
  const memWriteKinds: string[] = []; // snippets of episodic memory CREATED this turn
  const memKinds: string[] = [];
  const evals: string[] = []; // individual quality scores (target · dimension · score)
  const selfEdits: string[] = [];
  const off = ctx.loop.bus.on((e) => {
    if (e.type === "mutate" && e.result && !e.result.blocked && e.result.from !== e.result.to) {
      changed.push(`${e.result.entry.field} ${e.result.from.toFixed(2)}→${e.result.to.toFixed(2)}${e.result.clamped ? " clamped" : ""}`);
    } else if (e.type === "memory") {
      memWrites++;
      memWriteKinds.push(`[${e.entry.source}] ${e.entry.content.slice(0, 48)}`);
    } else if (e.type === "evaluation") {
      // Real detail, not "+N eval(s)": e.g. "#a1b2c3d4 usefulness 0.74".
      evals.push(`${e.target} ${e.dimension} ${e.score.toFixed(2)}`);
    } else if (e.type === "memory-kind") {
      if (e.kind !== "evaluations") memKinds.push(`${e.kind} ${e.detail}`); // evaluations shown in detail below
    } else if (e.type === "self-edit") {
      if (e.op === "queued") selfEdits.push(`proposed ${e.targetPath} (/review)`);
      else if (e.op === "applied") selfEdits.push(`self-edit applied: ${e.targetPath}`);
    }
    // NB: the loop's "recompile" event is just the .live.json state marker (fast, internal) —
    // not an LLM recompile of PERSONA.md, so we no longer surface it as noise every turn.
  });
  await ctx.loop.tick({ observation: line, source: "user", actor: "actor-llm" }).catch(() => {});
  off();
  // Per-turn telemetry as a distinct, labeled BLOCK (one line per fact) so it never blends into
  // the persona's reply above. Rendered dim, with a gutter (┊) and an aligned label; only the
  // rows that actually happened appear.
  const rows: Array<[string, string]> = [];
  if (recalls.length) rows.push(["recalled", recalls.join(", ")]);
  if (changed.length) rows.push(["evolved", changed.join(", ")]);
  if (selfEdits.length) rows.push(["self-edit", selfEdits.join(" · ")]);
  if (memWrites) rows.push(["memory", `+${memWrites} episodic` + (memWriteKinds.length ? ` (${memWriteKinds[memWriteKinds.length - 1]})` : "")]);
  for (const k of memKinds) rows.push(["memory", k]);
  if (evals.length) rows.push(["evaluated", evals.slice(0, 4).join(" · ") + (evals.length > 4 ? ` +${evals.length - 4} more` : "")]);
  if (rows.length) {
    ctx.out("", "activity"); // blank line separates the telemetry block from the reply
    for (const [label, value] of rows) {
      ctx.out(chalk.dim(`  ┊ ${chalk.cyan(label.padEnd(9))} ${value}`), "activity");
    }
  }

  // A governed self-edit may have marked the compiled doc stale. Do NOT recompile inline —
  // a full LLM compile would block every single turn (the "stuck thinking" hang). Just
  // surface it; recompile happens on /compile, on /review approve, or on exit.
  if (readRecompilePending(ctx.handle.personaPath).pending) {
    ctx.out(chalk.dim("  · PERSONA.md stale (self-edits applied) — /compile to refresh"));
  }
}

/**
 * Recompile PERSONA.md when a self-edit marked it stale (`.recompile-pending.json`). Uses the
 * authenticated `local` provider (PERSONAXIS_* env) when configured; otherwise just notifies.
 * Best-effort: a failed recompile never breaks the turn.
 */
async function maybeRecompile(ctx: Ctx): Promise<void> {
  if (!readRecompilePending(ctx.handle.personaPath).pending) return;
  if (!llmConfig(ctxModelArg(ctx))) {
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
  const modelArg = { personaPath, frontmatter: handle.frontmatter as Record<string, unknown> };
  const loop = new LivingLoop(personaPath, {
    appraiser: pickAppraiser(modelArg),
    recompile: makeRecompileHook(existsSync(compiled) ? compiled : undefined),
  });
  let postureIndex = POSTURES.indexOf(policyFromFrontmatter(handle.frontmatter as Record<string, unknown>).sandbox);
  if (postureIndex < 0) postureIndex = 1;
  return {
    handle,
    loop,
    responder: pickResponder(modelArg),
    theme: personaTheme(handle.frontmatter),
    name: displayName(handle.frontmatter),
    mode: readMode(handle.frontmatter as Record<string, unknown>, handle.personaPath),
    out: (t) => stdout.write(t + "\n"),
    postureIndex,
    approve: async () => "deny",
    personaDoc,
    conversation: [],
    sessionId: newSessionId(),
    sessionStarted: false,
    sessionNamed: false,
    meter,
    replyColor,
  };
}

/** Lazily create the on-disk session (header) for a ctx, seeded by the first message. */
function ensureCtxSession(ctx: Ctx, seedMsg: string): void {
  if (ctx.sessionStarted) return;
  const isSub = isSubagentPath(ctx.handle.personaPath);
  const address = slugAddressFromPath(ctx.handle.personaPath);
  ensureSession(ctx.handle.personaPath, {
    id: ctx.sessionId,
    kind: isSub ? "sub" : "root",
    participants: [address || "(root)"],
    name: fallbackName(seedMsg),
    created: new Date().toISOString(),
    persona: address,
  });
  ctx.sessionStarted = true;
}

/** Append a completed user/assistant exchange to the persona's session; auto-name once. */
async function recordTurn(ctx: Ctx, userMsg: string, assistantMsg: string): Promise<void> {
  try {
    ensureCtxSession(ctx, userMsg);
    const from = slugAddressFromPath(ctx.handle.personaPath) || "(root)";
    appendTurn(ctx.handle.personaPath, ctx.sessionId, { role: "user", content: userMsg });
    appendTurn(ctx.handle.personaPath, ctx.sessionId, { role: "assistant", content: assistantMsg, from });
    if (!ctx.sessionNamed) {
      ctx.sessionNamed = true;
      const llm = llmConfig(ctxModelArg(ctx));
      if (llm) {
        try {
          renameSession(ctx.handle.personaPath, ctx.sessionId, await nameSession(llm, userMsg));
        } catch {
          /* keep the deterministic fallback name */
        }
      }
    }
  } catch {
    /* session logging is best-effort and must never break a turn */
  }
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
  if (!llmConfig(ctxModelArg(ctx))) firstRunModelHint((s) => stdout.write(s + "\n"));

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
  // The sub-persona tree is surfaced to the LLM via the runtime awareness block
  // (buildAwarenessBlock), which covers root AND every sub — so we no longer bake it
  // into personaDoc here.
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
    // Record the delegation for provenance: a note in the ROOT's session (the sub logged
    // its own turn in its own session), and an episodic memory ONLY if the root's spec
    // enables episodic memory (honors memory.types.episodic — fixes the prior leak).
    try {
      ensureCtxSession(rootCtx, msg);
      appendTurn(rootCtx.handle.personaPath, rootCtx.sessionId, {
        role: "note",
        content: `Delegated to @${addr}: "${msg.slice(0, 120)}"`,
        from: "(root)",
      });
      if (readMemoryTypes(rootCtx.handle.frontmatter as Record<string, unknown>).episodic) {
        commitMemoryEntry(
          rootCtx.handle.personaPath,
          prepareMemoryEntry(rootCtx.handle.personaPath, {
            content: `Delegated to @${addr}: "${msg.slice(0, 120)}"`,
            source: "synthesis",
            tags: ["delegation", addr],
          }),
        );
      }
    } catch {
      /* delegation logging is best-effort */
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
      notePostureChange(ctx);
    },
    onExit: () => screen.stop(),
    onSubmit: async (line) => {
      if (line.startsWith("/")) {
        // Separate a command + its output from the previous content so it doesn't blend in.
        screen.print("");
        screen.print(chalk.dim(`  ${chalk.cyan(line)}`), "user");
        const done = await runCommand(line, ctx);
        if (done) {
          screen.stop();
          await farewell(ctx.handle.frontmatter);
          process.exit(0);
        }
        screen.print(""); // trailing gap before the next prompt
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
  if (!llmConfig(ctxModelArg(ctx))) firstRunModelHint((s) => screen.print(s, "activity"));
}

/** Guide a first-time user to configure a model instead of silently falling back to heuristic mode. */
