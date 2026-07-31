/**
 * REPL slash-command registry + dispatch (F3.6 split).
 *
 * The single source of truth for the `/` menu and `/help`: every command's name,
 * description, and handler. `runCommand` dispatches a `/line` to its handler, or
 * falls through to a `personaxis <name>` subprocess so every CLI subcommand is
 * reachable from inside the app.
 */

import chalk from "chalk";
import { relative, dirname, join } from "node:path";
import { existsSync, writeFileSync, readFileSync, unlinkSync, readdirSync } from "node:fs";
import {
  readState,
  writeState,
  extractEnvelopes,
  driftReport,
  readDriftThresholds,
  readMaxStepDelta,
  rebuildStateValues,
  resolveField,
  readArbitrationValues,
  arbitrate,
  rankValues,
  activeOverlay,
  proposals,
  readMemory,
  readMemoryTypes,
  readMemoryKnobs,
  readSemanticMemory,
  readProcedural,
  readAutobiographical,
  readPreferences,
  readEvaluations,
  consolidateSemantic,
  pruneMemory,
  searchMemory,
  applySelfEdit,
  rejectSelfEdit,
  verifyMemoryChain,
  overseerView,
  liveProjects,
  readRecompilePending,
  displayName,
  readMode,
  compactMessages,
  recordCompaction,
  loadConversation,
  listSessions,
  findSession,
  renameSession,
} from "@personaxis/core";
import { envelopeBars, auraLines } from "@personaxis/tui/visual";
import { sigilParams, liveIntensity } from "@personaxis/core";
import { renderFrame } from "@personaxis/tui";
import type { SlashItem } from "@personaxis/tui/screen";
import { isSubagentPath, slugAddressFromPath, loadPersonaFile, compiledPathFor } from "../load.js";
import { runMode, isMode, MODES } from "../commands/improve.js";
import { runCompile } from "../commands/compile.js";
import { setModelSetting } from "../config.js";
import { installHook, HOSTS } from "../commands/hooks.js";
import { validatePersona } from "../schema.js";
import { lint } from "../linter/index.js";
import { writeStarterPersona } from "../starter.js";
import { buildResourceManifest } from "../resource-manifest.js";
import { discoverTree } from "./roster.js";
import { buildAwarenessBlock } from "./awareness.js";
import type { Ctx, CommandDef } from "./types.js";
import { POSTURES, llmConfig, ctxModelArg, appraiserLabel, notePostureChange, readGoalText } from "./config.js";
import { fmtK, panel, meterBar, userLine } from "./render.js";
import { version } from "../generated/assets.js";
import { stopDaemons, startStopDaemon, runCliPassthrough, runCliInteractive } from "./daemons.js";
import { ensureCtxSession, resumeSessionInto, replayTranscript } from "./session.js";
import { maybeRecompile, handleTurn } from "./turn.js";
import { loadCustomCommands, findCustomCommand, expandCommand } from "./custom-commands.js";
import { resolveDeclaredSkills } from "../targets/skills.js";
import type { PersonaData } from "../load.js";
import { rewindState } from "../rewind.js";
import { startTask, listTasks, readTaskDetail, markTaskSurfaced } from "./tasks.js";
import { statusLines, configLines, usageLines } from "./views/settings-data.js";
import { driftTextLines } from "./views/drift-view.js";
import { runDoctorChecks } from "./doctor-checks.js";
import { lineText } from "./views/tabbed.js";
import { AUDIT_TABS, auditLines } from "./views/audit-data.js";

/**
 * V6.2: the Command Center opens IN-PROCESS inside suspend(). The old path
 * spawned a second full CLI on the same console, so two processes read one
 * stdin (keystrokes split between them: the "press Enter twice" bug) and every
 * open paid a whole Node boot. Dynamic import keeps the REPL start lean.
 */
async function openCenterInProcess(ctx: Ctx, section: "home" | "model"): Promise<void> {
  const { runCommandCenter } = await import("../command-center.js");
  const dir = join(process.cwd(), ".personaxis", "personas");
  let personas: string[] = [];
  try {
    personas = existsSync(dir)
      ? readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)
      : [];
  } catch {
    personas = [];
  }
  await runCommandCenter({ personaPath: ctx.handle.personaPath, personas, cwd: process.cwd(), section });
}

/** V9/G.4c: open the scope-tree navigator in-process (the default Command Center). */
async function openNavigatorInProcess(): Promise<void> {
  const { runScopeNavigator } = await import("../center/run.js");
  await runScopeNavigator();
}

// ── Commands (single source for /help and the live `/` menu) ─────────────────
export const COMMANDS: CommandDef[] = [
  {
    name: "help",
    desc: "show commands by category; /help <query> to filter",
    external: "session-only",
    why: "lists the slash commands of a running session; outside, `personaxis --help` is the equivalent",
    run: (arg, ctx) => {
      ctx.out(helpText(arg));
      const custom = loadCustomCommands(ctx.handle.personaPath);
      const q = arg.trim().toLowerCase();
      const shown = q ? custom.filter((c) => c.name.includes(q) || c.description.toLowerCase().includes(q)) : custom;
      if (shown.length) {
        ctx.out("\n" + chalk.bold.dim("  Custom commands") + chalk.dim("  (.personaxis/commands/)"));
        for (const c of shown) ctx.out(`  ${chalk.cyan(`/${c.name}`).padEnd(22)} ${chalk.dim(c.description)}${c.argumentHint ? chalk.dim(`  ${c.argumentHint}`) : ""}`);
      }
    },
  },
  {
    name: "skill",
    desc: "the reusable procedures this persona can run: add, update, apply",
    external: "skills",
    run: async (arg, ctx) => {
      // V5.P1.10: no args in the TUI opens the skills miniapp (per-persona, apply, status).
      if (!arg.trim() && ctx.openView) return void ctx.openView("skills");
      const baseDir = dirname(ctx.handle.personaPath);
      const skills = resolveDeclaredSkills(ctx.handle.frontmatter as unknown as PersonaData, baseDir);
      const parts = arg.trim().split(/\s+/).filter(Boolean);
      const nameArg = parts[0] ?? "";
      if (!nameArg) {
        if (!skills.length) return void ctx.out(chalk.dim("  no skills declared (extensions.skills in personaxis.md)."));
        ctx.out(chalk.bold("  Skills:"));
        for (const s of skills) {
          const status =
            s.kind === "local" ? (s.missing ? chalk.red("missing") : chalk.green("local")) : chalk.dim(s.kind);
          ctx.out(`  ${chalk.cyan(s.name)} ${chalk.dim("·")} ${status}${s.ref ? chalk.dim(" " + s.ref) : ""}`);
        }
        ctx.out(chalk.dim("  /skill <name> [args] to apply one."));
        return;
      }
      const skill = skills.find((s) => s.name === nameArg);
      if (!skill) return void ctx.out(chalk.yellow(`  no skill "${nameArg}". /skill to list.`));
      if (skill.kind !== "local" || skill.missing || !skill.sourceDir) {
        return void ctx.out(
          chalk.yellow(`  skill "${nameArg}" is ${skill.kind}${skill.missing ? " (SKILL.md missing)" : ""}, not runnable locally.`),
        );
      }
      const skillMd = join(skill.sourceDir, "SKILL.md");
      if (!existsSync(skillMd)) return void ctx.out(chalk.yellow(`  ${nameArg}: SKILL.md not found.`));
      const body = readFileSync(skillMd, "utf-8");
      const rest = parts.slice(1).join(" ");
      ctx.out(chalk.dim(`  /skill ${nameArg}: applying skill…`));
      await handleTurn(`Apply the "${nameArg}" skill:\n\n${body}${rest ? `\n\nInput: ${rest}` : ""}`, ctx);
    },
  },
  {
    name: "persona",
    desc: "who this persona is: identity, the ten layers, its resources, its sub-personas, how it evolves",
    external: "list",
    run: (_a, ctx) => {
      // V5.P3.3: in the TUI this is a miniapp; pipes keep the inline summary.
      if (ctx.openView) return void ctx.openView("persona");
      const p = ctx.handle.personaPath;
      const id = ctx.handle.frontmatter.identity as { display_name?: string; system_identity?: { purpose?: string } } | undefined;
      const address = slugAddressFromPath(p);
      const role = isSubagentPath(p) && address ? `sub-persona @${address}` : "main persona";
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
      // V5.P3.2: the AURA, the persona's living creature mark (unique per seed;
      // it breathes with the loop and flares when drift crosses thresholds).
      const st = readState(ctx.handle.statePath);
      ctx.out(
        auraLines(sigilParams(ctx.handle.frontmatter), 0, { intensity: liveIntensity(st.values, 0) })
          .split("\n")
          .map((l) => `     ${l}`)
          .join("\n"),
      );
      ctx.out(chalk.dim(`  aura #${ctx.theme.seed.toString(16)} (unique to this persona) · voice ${ctx.theme.voice.density}`));
    },
  },
  {
    name: "create",
    desc: "create or rewrite a persona: interview, a prompt, an import, a transcript",
    external: "create",
    run: async (arg, ctx) => {
      if (!ctx.suspend) {
        runCliPassthrough("create", arg, ctx);
        return;
      }
      await ctx.suspend(() => runCliInteractive("create", arg));
      ctx.out(chalk.dim("  create finished, its output is in the scrollback above."));
    },
  },
  {
    name: "drift",
    desc: "how far the persona has moved from what it declared, and in what",
    external: "state drift",
    run: (_a, ctx) => {
      // /drift is the DELTA ("how far have I moved"), three planes deep; /status is the
      // SNAPSHOT ("what am I now"). They used to print the same envelope block, which made
      // one of the two redundant.
      if (ctx.openView) {
        // Feed the live gauge in the status bar with the numeric plane, then open the app.
        try {
          const st = readState(ctx.handle.statePath);
          const fm = ctx.handle.frontmatter as Record<string, unknown>;
          const env = extractEnvelopes(ctx.handle.frontmatter);
          ctx.onDrift?.(
            driftReport({
              values: st.values,
              envelopes: env.envelopes,
              maxStepDelta: readMaxStepDelta(fm),
              thresholds: readDriftThresholds(fm),
              protectedFields: env.protectedFields,
            }),
          );
        } catch {
          /* a persona with no state still opens the view; the plane says so itself */
        }
        ctx.openView("drift-planes");
        return;
      }
      // Pipe / CI: the same three planes as text.
      for (const line of driftTextLines(ctx)) ctx.out(line);
    },
  },
  {
    name: "compile",
    desc: "rebuild the persona document your agents read, from the (evolved) spec",
    external: "compile",
    run: async (_a, ctx) => {
      const compiledPath = compiledPathFor(ctx.handle.personaPath);
      const firstCompile = !existsSync(compiledPath);
      if (!firstCompile && !readRecompilePending(ctx.handle.personaPath).pending) {
        return void ctx.out(chalk.dim(`  PERSONA.md is already up to date: ${compiledPath}`));
      }
      const llm = llmConfig(ctxModelArg(ctx));
      ctx.out(
        chalk.dim(
          firstCompile
            ? `  compiling PERSONA.md${llm ? "" : " (deterministic assembler, no model configured)"}…`
            : "  recompiling PERSONA.md from the evolved spec…",
        ),
      );
      const address = slugAddressFromPath(ctx.handle.personaPath);
      try {
        // Without a model, skip the polish stage: the stage-1 assembler still produces
        // the full, correct document (compile NEVER silently no-ops).
        await runCompile({
          ...(address ? { slug: address } : { root: true }),
          ...(llm ? { provider: "local" as const } : { noPolish: true }),
        });
      } catch (e) {
        return void ctx.out(chalk.red(`  ✗ compile failed: ${(e as Error).message}`));
      }
      // Never report success on faith: verify the artifact exists where it must.
      if (existsSync(compiledPath)) {
        ctx.out(chalk.green("  ✓ ") + `PERSONA.md written: ${compiledPath}`);
        ctx.personaDoc = readFileSync(compiledPath, "utf-8"); // the live identity follows the doc
      } else {
        ctx.out(chalk.red(`  ✗ compile finished but nothing exists at ${compiledPath}, this is a bug; run \`personaxis compile\` for details.`));
      }
    },
  },
  {
    name: "audit",
    desc: "the evidence: every mutation, the tamper-evident chain, self-edits, and the rewind",
    external: "audit",
    run: (arg, ctx) => {
      // V7.B: ONE Ledger miniapp (Timeline / Integrity / Self-edits / Evaluations); the
      // old /replay is the Integrity tab and /rewind is an action on Timeline.
      const tab = arg.trim();
      if (ctx.openView) return void ctx.openView("audit", tab ? { tab } : undefined);
      // Pipes get the same collectors as flat text (single source of truth).
      for (const t of AUDIT_TABS.keys()) {
        ctx.out(chalk.bold(`  ${AUDIT_TABS[t]}`));
        for (const l of auditLines(ctx, t)) ctx.out(lineText(l));
        ctx.out("");
      }
    },
  },
  {
    name: "memory",
    desc: "what it remembers, by kind, and what to do with it",
    external: "memory",
    run: async (arg, ctx) => {
      const p = ctx.handle.personaPath;
      const fm = ctx.handle.frontmatter as Record<string, unknown>;
      const types = readMemoryTypes(fm);
      const parts = arg.trim().split(/\s+/).filter(Boolean);
      // V5.P1.4: no args in the TUI opens the two-level memory browser.
      if (!parts.length && ctx.openView) return void ctx.openView("memory");
      if (parts[0] === "consolidate") {
        const c = consolidateSemantic(p);
        return void ctx.out(chalk.green("  ✓ ") + `memory.md consolidated (${c.count} entries kept by salience) → ${c.path}`);
      }
      if (parts[0] === "prune") {
        const days = readMemoryKnobs(fm).retentionDays;
        if (!days) return void ctx.out(chalk.dim("  no retention window declared (runtime.memory.retention_days_default); nothing to prune."));
        const r = pruneMemory(p, days);
        return void ctx.out(chalk.green("  ✓ ") + `${r.pruned} entr${r.pruned === 1 ? "y" : "ies"} beyond ${days}d tombstoned (anchors/facts/distillates spared).`);
      }
      if (parts[0] === "search") {
        const query = parts.slice(1).join(" ");
        if (!query) return void ctx.out(chalk.dim("  usage: /memory search <query>"));
        const r = await searchMemory(p, query, readMemoryKnobs(fm), { sessionId: ctx.sessionId });
        if (!r.results.length) return void ctx.out(chalk.dim(`  no memory matched "${query}"`));
        ctx.out(chalk.bold(`  ${r.results.length} match(es)`) + chalk.dim(` via ${r.via}`));
        for (const x of r.results) ctx.out(`  ${chalk.cyan(`[${x.doc.kind}]`)} ${chalk.dim(x.doc.id)} ${x.doc.text.replace(/\n+/g, " ").slice(0, 90)}`);
        return;
      }
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
    name: "model",
    desc: "which model answers, for this persona or any other",
    external: "model",
    run: async (arg, ctx) => {
      const parts = arg.trim().split(/\s+/).filter(Boolean);
      if (parts[0] !== "set") {
        // V5.P1.8: inside the app the MENU is the way to change models (no textual set).
        ctx.out(chalk.dim(`  model: ${appraiserLabel(ctxModelArg(ctx))}`));
        if (ctx.suspend) {
          await ctx.suspend(() => openCenterInProcess(ctx, "model"));
          ctx.out(chalk.dim(`  now: ${appraiserLabel(ctxModelArg(ctx))}`));
          return;
        }
        ctx.out(chalk.dim("  change it: personaxis model set <name> [--persona <slug|main>] [--project] (outside the app)"));
        return;
      }
      // Textual set stays available for pipes/agents; the same syntax as the external CLI.
      const [, key, value, scope] = parts;
      if (!key || !value) return void ctx.out(chalk.yellow("  usage (pipes): /model set <endpoint|model|key|key-env> <value> [project] · in the app just /model"));
      const global = scope !== "project";
      const isSecret = key === "key";
      try {
        setModelSetting(key, value, global);
        const shown = isSecret ? value.slice(0, 3) + "…" + value.slice(-2) : value;
        ctx.out(chalk.green(`  ✓ ${key} = ${shown}`) + chalk.dim(` (${global ? "global ~/.personaxis" : "project .personaxis"}/config.json)`));
        if (isSecret) ctx.out(chalk.dim("  key stored user-only (0600), reused across all projects, no env var needed."));
        ctx.out(chalk.dim(`  now: ${appraiserLabel(ctxModelArg(ctx))}`));
      } catch (e) {
        ctx.out(chalk.red(`  ${(e as Error).message}`));
      }
    },
  },
  {
    name: "menu",
    desc: "the Command Center: navigate machine → project → persona → layer → field, with live state",
    external: "menu",
    run: async (args, ctx) => {
      if (ctx.suspend) {
        // Alt-screen modal: the app suspends, the Center takes the raw TTY, and on exit the
        // transcript is restored with ZERO residue (the k9s/lazygit standard). V9/G.4c: the
        // scope-tree navigator is the default; `/menu classic` opens the legacy sectioned hub.
        if (args.trim() === "classic") await ctx.suspend(() => openCenterInProcess(ctx, "home"));
        else await ctx.suspend(() => openNavigatorInProcess());
        return;
      }
      ctx.out(chalk.dim("  the Command Center needs an interactive terminal; here, use /model /state /drift /audit /memory."));
    },
  },
  {
    name: "bg",
    desc: "run a prompt as a background task: /bg <prompt> (see /tasks)",
    external: "session-only",
    why: "starts a background task owned by the running session; outside, run the command directly",
    run: (arg, ctx) => {
      const prompt = arg.trim();
      if (!prompt) return void ctx.out(chalk.yellow("  usage: /bg <prompt>"));
      const rec = startTask(ctx.handle.personaPath, prompt);
      ctx.out(chalk.dim(`  · background task ${chalk.cyan(rec.id)} started (see /tasks ${rec.id})`));
    },
  },
  {
    name: "compact",
    desc: "summarize older turns to free context, keeping decisions and open threads",
    external: "session-only",
    why: "summarizes the CURRENT conversation history; there is no history outside a session",
    run: async (_a, ctx) => {
      const llm = llmConfig(ctxModelArg(ctx));
      if (!llm) return void ctx.out(chalk.dim("  /compact needs a model, configure with /model."));
      const before = ctx.meter.used;
      const r = await compactMessages([{ role: "system", content: "" }, ...ctx.conversation], ctx.meter, { llm, threshold: 0 });
      if (r.compacted) {
        ctx.conversation = r.messages.filter((m) => m.role !== "system");
        // PERSIST the checkpoint so leaving and /resume returns the COMPACTED conversation, not the
        // raw bloat, the user shouldn't have to /compact again after re-entering the same session.
        if (r.summary) {
          ensureCtxSession(ctx, ctx.conversation[0]?.content ?? "session");
          recordCompaction(ctx.handle.personaPath, ctx.sessionId, r.summary);
        }
        const after = ctx.meter.used;
        const freed = Math.max(0, before - after);
        ctx.out(chalk.dim(`  compacted ${r.removed} message(s) → ${ctx.conversation.length} kept · ${fmtK(before)} → ${fmtK(after)} tok${freed ? ` (freed ~${fmtK(freed)})` : ""} · persisted (survives /resume)`));
      } else {
        ctx.out(chalk.dim("  nothing to compact yet."));
      }
    },
  },
  {
    name: "resume",
    desc: "go back into a saved conversation; it is rebuilt exactly as you left it",
    external: "session-only",
    why: "loads a saved conversation into the running REPL; a one-shot command has no conversation to load it into",
    run: async (arg, ctx) => {
      const q = arg.trim();
      if (!q) {
        // V5.P1.3: no args opens the session picker in the TUI; in pipes, list them.
        if (ctx.openView) return void ctx.openView("resume");
        const list = listSessions(ctx.handle.personaPath);
        if (!list.length) return void ctx.out(chalk.dim("  no saved sessions yet."));
        for (const s of list.slice(0, 12)) ctx.out(`  ${chalk.cyan(s.name)} ${chalk.dim(`· ${s.turns} turn(s) · ${s.updated.slice(0, 16).replace("T", " ")} · ${s.id}`)}`);
        return void ctx.out(chalk.dim("  /resume <id|name> to continue one."));
      }
      const s = resumeSessionInto(ctx, q);
      if (!s) return void ctx.out(chalk.yellow(`  no session matching "${q}", /resume lists them`));
      // V7.A6: rebuild that conversation on screen instead of continuing it under the
      // current one (the picker does the same through its own resume handler).
      if (ctx.clearScreen) {
        ctx.clearScreen();
        ctx.out(chalk.dim(`  resumed "${s.name}"  ·  ${ctx.conversation.length} message(s)`), "activity");
        for (const line of replayTranscript(ctx)) ctx.out(line.text, line.role);
        ctx.out(chalk.dim(`  ── end of the restored history · type to carry on ──`), "activity");
        return;
      }
      ctx.out(chalk.green(`  ✓ resumed "${s.name}"`) + chalk.dim(` · ${ctx.conversation.length} message(s) restored`));
    },
  },
  {
    // Named /sandbox because that is the word the status bar has always shown for it;
    // /mode stays as a hidden alias.
    name: "sandbox",
    desc: "how much this session may touch your machine; cycles read-only → workspace-write → full access (shift+tab)",
    external: "session-only",
    why: "the sandbox posture belongs to a terminal; a one-shot run is governed by its own flags",
    run: (_a, ctx) => {
      ctx.postureIndex = (ctx.postureIndex + 1) % POSTURES.length;
      notePostureChange(ctx);
      const posture = POSTURES[ctx.postureIndex];
      const what =
        posture === "read-only"
          ? "it may read and run read-only commands; no writes, no network"
          : posture === "workspace-write"
            ? "it may also write inside this workspace; network still restricted"
            : "it may read, write, use the network and run destructive commands";
      ctx.out(chalk.dim(`  sandbox → ${chalk.bold(posture)}  ·  ${what}`));
      ctx.clearScreen ? undefined : undefined; // posture is session-wide, per V7 decision
    },
  },
  {
    name: "context",
    desc: "what is filling the model window right now, by category",
    external: "session-only",
    why: "reports the live context window of the running conversation",
    run: (arg, ctx) => {
      // V5.P0.3: estimated breakdown of WHAT fills the window, Claude Code-style.
      const est = (s: string): number => Math.ceil(s.length / 4);
      const fm = ctx.handle.frontmatter as Record<string, unknown>;
      const p = ctx.handle.personaPath;
      const sysPrompt = `You are ${ctx.name}. Stay in character.` + (readGoalText(ctx.handle) ?? "");
      const awareness = buildAwarenessBlock(p, { frontmatter: fm, posture: POSTURES[ctx.postureIndex], cwd: process.cwd() });
      const semantic = readSemanticMemory(p) ?? "";
      const knobs = readMemoryKnobs(fm);
      const episodic = readMemory(p).slice(-knobs.maxItems);
      const memTokens = est(semantic) + episodic.reduce((n, e) => n + est(e.content), 0);
      const skills = resolveDeclaredSkills(fm as unknown as PersonaData, dirname(p));
      const msgs = ctx.conversation.reduce((n, m) => n + est(typeof m.content === "string" ? m.content : JSON.stringify(m.content)), 0);
      const cats: Array<[string, number, string]> = [
        ["System prompt", est(sysPrompt), ""],
        ["Compiled persona", est(ctx.personaDoc), "PERSONA.md, read every turn"],
        ["Runtime context", est(awareness), "who/where/resources, generated each session"],
        ["Memory", memTokens, `memory.md + ${episodic.length} episodic (injected at session start)`],
        ["Skills", 0, `${skills.length} declared · loaded on demand`],
        ["Messages", msgs, `${ctx.conversation.length} message(s)`],
      ];
      const total = cats.reduce((n, [, t]) => n + t, 0);
      const m = ctx.meter;
      const limit = m.limit || 0;
      const free = limit ? Math.max(0, limit - Math.max(total, m.used)) : 0;
      const pctOf = (t: number): string => (limit ? `${((t / limit) * 100).toFixed(1)}%` : "");
      const lines: string[] = [];
      if (limit) {
        lines.push(`  ${bar(Math.max(total, m.used) / limit)}  ${fmtK(Math.max(total, m.used))}/${fmtK(limit)}  ${Math.round((Math.max(total, m.used) / limit) * 100)}%`);
      } else {
        lines.push(chalk.dim("  offline (no model configured): estimates only, no window limit"));
      }
      lines.push(chalk.dim("  estimated usage by category"));
      for (const [label, tokens, note] of cats) {
        lines.push(`  ${chalk.cyan("⛁")} ${label.padEnd(17)} ${fmtK(tokens).padStart(7)}${limit ? `  ${pctOf(tokens).padStart(6)}` : ""}${note ? chalk.dim(`  · ${note}`) : ""}`);
      }
      if (limit) lines.push(`  ${chalk.dim("⛶")} ${"Free space".padEnd(17)} ${fmtK(free).padStart(7)}  ${pctOf(free).padStart(6)}`);
      if (limit && m.pct >= 0.8) lines.push(chalk.yellow("  ⚠ near the limit, /compact summarizes older turns to free room"));
      if (arg?.trim() === "all") {
        lines.push("", chalk.bold("  Memory files"));
        lines.push(`  ${chalk.dim("├")} memory.md: ${fmtK(est(semantic))}`);
        lines.push(`  ${chalk.dim("└")} episodic window: ${episodic.length} entr${episodic.length === 1 ? "y" : "ies"} · ${fmtK(episodic.reduce((n, e) => n + est(e.content), 0))}`);
        lines.push("", chalk.bold("  Skills · loaded on demand"));
        if (skills.length) skills.forEach((s, i) => lines.push(`  ${chalk.dim(i === skills.length - 1 ? "└" : "├")} ${s.name}`));
        else lines.push(chalk.dim("  (none declared)"));
        const byRole = ctx.conversation.reduce<Record<string, number>>((acc, mm) => ((acc[mm.role] = (acc[mm.role] ?? 0) + 1), acc), {});
        lines.push("", chalk.bold("  Messages"));
        lines.push(`  ${chalk.dim("└")} ${Object.entries(byRole).map(([r, n]) => `${r}: ${n}`).join(" · ") || "(none yet)"}`);
      } else {
        lines.push(chalk.dim("  /context all to expand"));
      }
      ctx.out(panel("context usage", lines));
    },
  },
  {
    name: "status",
    desc: "this session at a glance: state, config, spend, stats, daemons and background tasks",
    external: "status",
    run: (_a, ctx) => {
      if (ctx.openView) return void ctx.openView("settings", { tab: "Status" });
      ctx.out(panel(`${ctx.name} · ${slugAddressFromPath(ctx.handle.personaPath) || "main"}`, statusLines(ctx)));
    },
  },
  {
    name: "doctor",
    desc: "is anything wrong? config, spec, lint, integrity, provider, with a fix for each finding",
    external: "doctor",
    run: async (arg, ctx) => {
      // The view when there is one AND the checks are the offline set: it gives the
      // persona selector for free. An explicit `@slug` or `net` keeps the text path,
      // since the first is already scoped by hand and the second must not run inside
      // a view that redraws on a timer.
      if (ctx.openView && !arg.trim()) return void ctx.openView("doctor", {});
      const report = await runDoctorChecks(ctx.handle.personaPath, arg);
      ctx.out(panel("personaxis doctor", report.lines));
    },
  },
  {
    name: "exit",
    desc: "leave the session",
    external: "session-only",
    why: "ends a running conversation; a one-shot command ends on its own",
    run: (_a, ctx) => {
      stopDaemons(ctx);
      return true;
    },
  },
  {
    name: "quit",
    desc: "leave the session",
    external: "session-only",
    why: "hidden alias of /exit; it ends a running conversation and nothing else",
    run: () => true,
  },
];

/** The slash-command registry (names + descriptions), single source of truth. */
/**
 * What the `/` palette offers (V7.B). The FOURTEEN grouped commands plus `sandbox`, `bg`,
 * `help` and `exit`, in the order of the help groups; absorbed verbs are hidden but still
 * complete and run when typed, so muscle memory keeps working without turning the palette
 * into a wall of 40 entries.
 *
 * The count is fourteen, not "about twelve". The plan set ~12 as a target and the
 * implementation landed on 14; reports kept quoting the target instead of counting the
 * code, which is how a headline number ended up disagreeing with the product.
 */
export function listCommands(): SlashItem[] {
  const visible = COMMANDS.filter((c) => c.name !== "quit" && !HELP_HIDDEN.has(c.name));
  const order = [...HELP_GROUPS.flatMap((g) => g.names), "sandbox", "bg", "help"];
  const rank = (n: string): number => {
    const i = order.indexOf(n);
    return i < 0 ? order.length : i;
  };
  const primary = [...visible].sort((a, b) => rank(a.name) - rank(b.name) || a.name.localeCompare(b.name));
  // Absorbed verbs still appear AFTER the primary ones, marked with where they live and
  // flagged `hidden`, so typing `/co` still finds `/cost` and tells you it is now a tab of
  // /status, while BROWSING with a bare `/` shows only the consolidated surface.
  const moved = COMMANDS.filter((c) => ABSORBED[c.name]).map((c) => ({
    name: c.name,
    desc: `→ ${ABSORBED[c.name].where}`,
    hidden: true,
  }));
  return [...primary.map((c) => ({ name: c.name, desc: c.desc })), ...moved];
}

/** A tiny meter bar for /context and /usage (shared with the Settings view). */
const bar = meterBar;

/** /help categories: each command's name → its group. Anything unlisted falls in "More". */
/**
 * The command surface: as few commands as possible, each one properly built.
 *
 * FOURTEEN grouped commands carry everything; every other verb became a tab, an action
 * inside a miniapp, or a hidden alias that still runs for muscle memory. What absorbed what is
 * documented in ABSORBED below, and `/help` prints it, so nothing "disappears" silently.
 */
const HELP_GROUPS: Array<{ title: string; names: string[] }> = [
  { title: "Talk", names: ["resume", "compact", "context"] },
  { title: "Identity", names: ["persona", "status", "drift", "audit", "memory"] },
  { title: "Build", names: ["create", "compile", "skill"] },
  { title: "Run", names: ["model", "menu", "doctor"] },
];

/**
 * Where an absorbed verb now lives, as something EXECUTABLE (V8.A1).
 *
 * This used to be a map of prose, and prose cannot be enforced: `/state` and `/cost` really
 * did delegate, while `/lint`, `/validate`, `/overseer` and `/init` kept a SECOND
 * implementation of the same capability. Two implementations drift, and these did: the
 * remedies added to `doctor` and to the `lint` subcommand never reached the `/lint` slash
 * command, so the same query answered differently depending on where you typed it.
 *
 * Now the destination is data the code executes, and the alias body is GENERATED from it.
 */
export interface AbsorbedTarget {
  /** Human phrasing for `/help moved` and the palette. */
  where: string;
  /** The view it opens in the TUI. Pure navigation verbs have one. */
  view?: { name: string; tab?: string };
  /** The REPL command that owns the capability now; used without a TTY, and as the fallback. */
  command?: string;
  /**
   * Kept its own body ON PURPOSE: it takes an argument and DOES something (`/goal <text>`,
   * `/loop <n>`, `/improve <mode>`), so a navigation alias would silently drop the action.
   * These still share ONE implementation with their new home (V8.A4); what they must never
   * do is re-render the same information a second way.
   */
  keepsBody?: true;
}

export const ABSORBED: Record<string, AbsorbedTarget> = {
  // ── pure navigation: the body is generated, there is nothing to duplicate ──
  cost: { where: "/status → Usage", view: { name: "settings", tab: "Usage" }, command: "status" },
  usage: { where: "/status → Usage", view: { name: "settings", tab: "Usage" }, command: "status" },
  state: { where: "/status (live envelopes + self-edits)", view: { name: "settings", tab: "Status" }, command: "status" },
  config: { where: "/status → Config", view: { name: "settings", tab: "Config" }, command: "status" },
  dash: { where: "/drift", view: { name: "drift-planes" }, command: "drift" },
  replay: { where: "/audit → Integrity", view: { name: "audit", tab: "Integrity" }, command: "audit" },
  review: { where: "/persona → Evolution", view: { name: "persona", tab: "Evolution" }, command: "persona" },
  validate: { where: "/doctor → Spec", view: { name: "doctor" }, command: "doctor" },
  lint: { where: "/doctor → Lint", view: { name: "doctor" }, command: "doctor" },
  sessions: { where: "/resume", view: { name: "resume" }, command: "resume" },
  serve: { where: "/status → Daemons", view: { name: "settings", tab: "Status" }, command: "status" },
  watch: { where: "/status → Daemons", view: { name: "settings", tab: "Status" }, command: "status" },
  hooks: { where: "/status → Daemons", view: { name: "settings", tab: "Status" }, command: "status" },
  tasks: { where: "/bg (and /status → Tasks)", command: "bg" },
  overseer: { where: "/menu → All my projects", view: { name: "menu" }, command: "menu" },
  proof: { where: "/doctor → Proof", view: { name: "doctor" }, command: "doctor" },

  // ── verbs that ACT on an argument: they keep their body, by design ──
  rewind: { where: "/audit → Timeline", keepsBody: true },
  arbitrate: { where: "/persona → Values", keepsBody: true },
  goal: { where: "/persona → Evolution", keepsBody: true },
  loop: { where: "/persona → Evolution", keepsBody: true },
  improve: { where: "/persona → Evolution", keepsBody: true },
  init: { where: "/create", keepsBody: true },
  mode: { where: "/sandbox", keepsBody: true },
};

/**
 * The generated body of a navigation alias: open the view when there is a TTY, otherwise run
 * the command that owns the capability. One code path, so `/lint` and `/doctor` can never
 * again answer the same question two different ways.
 */
function absorbedRun(name: string): CommandDef["run"] {
  return async (arg, ctx) => {
    // Read on CALL, not on construction: the command table is built above ABSORBED,
    // so reading it here would hit the temporal dead zone at import time.
    const t = ABSORBED[name];
    if (t.view && ctx.openView && !arg.trim()) {
      return void ctx.openView(t.view.name, t.view.tab ? { tab: t.view.tab } : {});
    }
    if (t.command) return void (await runCommand(`/${t.command} ${arg}`.trim(), ctx));
    ctx.out(chalk.dim(`  /${name} now lives in ${t.where}`));
  };
}

/**
 * Aliases kept for muscle memory but never ADVERTISED, in `/help` or in the `/`
 * palette. One set, both surfaces: they disagreed for a whole release, and the
 * palette (the menu people actually open) was the one showing all forty.
 */
export const HELP_HIDDEN = new Set(["quit", ...Object.keys(ABSORBED)]);

/** Categorized help; `/help <query>` filters, `/help moved` prints the absorption map. */
function helpText(query = ""): string {
  const q = query.trim().toLowerCase();
  if (q === "moved" || q === "aliases") {
    const rows = Object.entries(ABSORBED)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, t]) => `  ${chalk.cyan(`/${name}`).padEnd(22)} ${chalk.dim(`→ ${t.where}`)}`);
    return [
      chalk.bold("Commands that became tabs or actions"),
      chalk.dim("  they still run if you type them; this is where the capability lives now"),
      "",
      ...rows,
    ].join("\n");
  }
  const visible = COMMANDS.filter((c) => !HELP_HIDDEN.has(c.name) && (!q || c.name.includes(q) || c.desc.toLowerCase().includes(q)));
  if (q && !visible.length) return chalk.dim(`  no command matches "${q}".`);
  const shown = new Set(visible.map((c) => c.name));
  const row = (c: CommandDef): string => `  ${chalk.cyan(`/${c.name}`).padEnd(22)} ${chalk.dim(c.desc)}`;
  const lines = [chalk.bold(q ? `Commands matching "${q}"` : "Commands")];
  const placed = new Set<string>();
  for (const g of HELP_GROUPS) {
    const rows = g.names.filter((n) => shown.has(n)).map((n) => COMMANDS.find((c) => c.name === n)!);
    if (!rows.length) continue;
    lines.push("", chalk.bold.dim(`  ${g.title}`));
    for (const c of rows) {
      lines.push(row(c));
      placed.add(c.name);
    }
  }
  const rest = visible.filter((c) => !placed.has(c.name));
  if (rest.length) {
    lines.push("", chalk.bold.dim("  More"));
    for (const c of rest) lines.push(row(c));
  }
  // V7.B: a query may name an ABSORBED verb; say where it lives instead of "no match".
  if (q) {
    const moved = Object.entries(ABSORBED).filter(([name]) => name.includes(q));
    if (moved.length) {
      lines.push("", chalk.bold.dim("  Moved (still works if you type it)"));
      for (const [name, t] of moved) lines.push(`  ${chalk.cyan(`/${name}`).padEnd(22)} ${chalk.dim(`→ ${t.where}`)}`);
    }
  }
  if (!q) {
    lines.push(
      "",
      chalk.dim("Type without a leading / to talk: plain language both converses AND uses tools."),
      chalk.dim("Everything else lives inside these: /help moved shows where each old command went."),
      chalk.dim("Ctrl+K opens the Command Center · shift+tab cycles the sandbox posture."),
    );
  }
  return lines.join("\n");
}

/**
 * The non-interactive door for a capability that no longer has a slash command.
 *
 * An absorbed verb is reachable two ways: inside the command that absorbed it, and from
 * a shell. This maps the retired name to the second one, so someone typing the old
 * command is told BOTH, instead of "unknown command".
 */
export const EXTERNAL_DOOR: Record<string, string> = {
  cost: "status", usage: "status", state: "status", config: "config",
  dash: "state drift", replay: "audit --tab Integrity", rewind: "state rewind <n>",
  review: "review", goal: "goal <text>", loop: "observe", improve: "improve <mode>",
  init: "create", validate: "validate", lint: "lint", sessions: "status",
  serve: "serve", watch: "watch", hooks: "hooks", tasks: "status",
  overseer: "overseer show", proof: "proof", arbitrate: "arbitrate", mode: "config",
};

/** CLI subcommands handled specially in the REPL (native or background), so the passthrough skips them. */
const REPL_UNAVAILABLE: Record<string, string> = {
  observe: "the living loop already runs a governed tick every turn, feed a one-off with `personaxis observe --observation \"…\"`",
};

export async function runCommand(line: string, ctx: Ctx): Promise<boolean> {
  const name = line.slice(1).split(/\s+/)[0];
  const arg = line.slice(1 + name.length).trim();

  // An ABSORBED verb is gone, not hidden (V8.A).
  //
  // Keeping them runnable-but-unlisted was half a consolidation: the clutter it was
  // meant to remove was still there, just invisible, and two ways to do one thing is
  // how the implementations drifted in the first place. So the capability MOVED, and
  // typing the old name says where it went. It does not run it: that is the point.
  const moved = ABSORBED[name];
  if (moved && !COMMANDS.some((c) => c.name === name)) {
    ctx.out(chalk.dim(`  /${name} is now part of ${chalk.cyan(moved.where)}`));
    const outside = EXTERNAL_DOOR[name];
    if (outside) ctx.out(chalk.dim(`  outside the REPL: ${chalk.cyan(`personaxis ${outside}`)}`));
    return false;
  }

  const cmd = COMMANDS.find((c) => c.name === name);
  if (cmd) return (await cmd.run(arg, ctx)) === true;

  // A user-defined custom command (.personaxis/commands/<name>.md): expand its
  // template with the args and run it as a turn to the current persona (F3.C12).
  const custom = findCustomCommand(ctx.handle.personaPath, name);
  if (custom) {
    ctx.out(chalk.dim(`  /${name} (custom): ${custom.description}`));
    await handleTurn(expandCommand(custom, arg), ctx);
    return false;
  }

  // Not a native `/command`, fall through to the CLI so EVERY subcommand is reachable from the app
  // (export, decompile, diff, spec, orchestrate, team, skills, scan, personas, migrate, push/pull, …).
  if (REPL_UNAVAILABLE[name]) {
    ctx.out(chalk.dim(`  /${name}: ${REPL_UNAVAILABLE[name]}.`));
    return false;
  }
  runCliPassthrough(name, arg, ctx);
  return false;
}
