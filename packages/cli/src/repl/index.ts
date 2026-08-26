/**
 * `personaxis` (no subcommand) -> the living REPL.
 *
 * A persistent, interactive session where you talk to your persona in natural
 * language, drive it with /commands, and hand it real tasks with /do (the governed
 * Agent Loop). On a TTY it renders through Ink (InkScreen): a <Static> transcript
 * (native scrollback), a bounded live region (spinner/approval), a live `/` command
 * palette, and shift+tab to cycle the sandbox posture. When stdin isn't a TTY
 * (pipes/CI) it falls back to a simple line reader.
 */

import * as readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { join, relative, resolve, dirname, basename } from "node:path";
import { homedir } from "node:os";
import chalk from "chalk";
import { record, readState, extractEnvelopes, resolveModel, registerProject, listSessions, proposals, applySelfEdit, rejectSelfEdit, announcePresence, releasePresence, acquireLease, releaseLease, describeLease, PRESENCE_HEARTBEAT_MS } from "@personaxis/core";
import { animateLogo, awaken, voiceWrap, farewell, driftGauge } from "@personaxis/tui/visual";
import { type SlashItem } from "@personaxis/tui/screen";
import { InkScreen } from "@personaxis/tui/ink";
import { writeStarterPersona } from "../starter.js";
import { runCompile } from "../commands/compile.js";
import { runModelSetup } from "../config-wizard.js";
import { runCommandCenter } from "../command-center.js";
import type { Ctx, ReplOptions } from "./types.js";
import { POSTURES, resolvePersonaPath, notePostureChange, llmConfig, ctxModelArg, makeMeter } from "./config.js";
import { loadMergedConfig } from "../config.js";
import { matchPermission, callDetail } from "../permissions.js";
import { readHooksConfig, runHooks } from "@personaxis/core";
import { replyLine, userLine, fmtK, firstRunModelHint } from "./render.js";
import { makeCtx, closeSession, resumeSessionInto, replayTranscript } from "./session.js";
import { dispatchTurn, buildRoster, maybeRecompile } from "./turn.js";
import { listCommands, runCommand } from "./commands.js";
import { loadCustomCommands } from "./custom-commands.js";
import { discoverTree } from "./roster.js";
import { registerTabbedView } from "./views/tabbed.js";
import { doctorProvider } from "./views/doctor-view.js";
import { settingsProvider, personaProvider } from "./views/interactive.js";
import { scopedProvider } from "./views/scoped.js";
import { driftProvider } from "./views/drift-view.js";
import { registerResumeView } from "./views/resume.js";
import { registerMemoryView } from "./views/memory.js";
import { memoryKindRows, openInEditor, memoryConsolidate, memoryPrune } from "./views/memory-data.js";
import { registerImproveView, registerReviewView } from "./views/governance.js";
import { runMode } from "../commands/improve.js";
import { registerHooksView } from "./views/hooks.js";
import { HOSTS, hookStatus, installHook, uninstallHook } from "../commands/hooks.js";
import { registerSkillsView } from "./views/skills.js";
import { listSkills, addSkill, pullSkill, updateSkill, removeSkill } from "./views/skills-data.js";
import { qualitativeDriftLines } from "./views/drift-data.js";
import { AUDIT_TABS, auditLines } from "./views/audit-data.js";
import { registerHistoryView } from "./views/history.js";
import { rewind, rewindPlan } from "../rewind.js";
import { resolveDeclaredSkills } from "../targets/skills.js";
import { loadPersonaFile, slugAddressFromPath } from "../load.js";

// Re-exported for the REPL's public surface (tests + the CLI entry import these). The whole
// REPL was split into modules (F3.6): types, config, render, daemons, session, turn, commands.
export { parseMentions } from "./turn.js";
export { notePostureChange, listCommands };

/**
 * Update this session's live activity and re-announce it at once (V9/G.2), so the fleet and the
 * Command Center show what the persona is doing right now instead of a permanent "idle".
 */
export function noteActivity(ctx: Ctx, activity: string): void {
  ctx.presence.activity = activity;
  try {
    announcePresence(ctx.handle.personaPath, { host: "repl", project: process.cwd(), sessionId: ctx.sessionId, activity });
  } catch {
    /* presence is best-effort, never a precondition for answering */
  }
}

export async function startRepl(opts: ReplOptions = {}): Promise<void> {
  let personaPath = resolvePersonaPath(opts.persona);
  await animateLogo();

  // Transparency when the persona was INHERITED from an ancestor directory (the
  // git-like walk-up): say which one, so "who am I talking to" is never a mystery.
  if (personaPath && !opts.persona) {
    const rel = relative(process.cwd(), personaPath);
    if (rel.startsWith("..")) stdout.write(chalk.dim(`  persona: ${personaPath} (inherited from an ancestor directory)\n`));
  }

  // V5.P0.2: starting at the user's HOME with no persona means creating their MAIN
  // AI persona (the personal one every project inherits unless it has its own).
  const atHome = resolve(process.cwd()) === resolve(homedir());
  if (!personaPath) {
    stdout.write(
      atHome
        ? chalk.yellow("  No main persona yet.") + chalk.dim(" This is your home directory: the persona created here is YOUR personal AI persona, inherited by every project that has none of its own.\n\n")
        : chalk.yellow("  No persona here yet.") + chalk.dim(" Let's create one so you can start playing.\n\n"),
    );
    let name = "Aria";
    if (stdin.isTTY) {
      const onboard = readline.createInterface({ input: stdin, output: stdout });
      try {
        const prompt = atHome
          ? `  Create your MAIN persona in ${chalk.cyan("~/.personaxis/")}? ${chalk.dim("[Y/n]")} `
          : `  Create a starter persona in ${chalk.cyan(".personaxis/")}? ${chalk.dim("[Y/n]")} `;
        const yn = ((await onboard.question(prompt)) || "y").trim().toLowerCase();
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
    stdout.write(chalk.green("  ✓ ") + `created ${chalk.cyan(personaPath)}\n`);
    // Born compiled: the deterministic stage-1 assembler needs no model, so a starter
    // persona always has its PERSONA.md from second zero (never a phantom compile).
    try {
      await runCompile({ root: true, noPolish: true });
    } catch (e) {
      stdout.write(chalk.yellow("  ! ") + `first compile failed: ${(e as Error).message}\n`);
    }
    stdout.write(chalk.green("  ✓ ") + `${chalk.bold(name)} is ready.\n`);
  }

  // V5.P0.2: keep the global registry aware of every PROJECT with a persona, so the
  // Command Center's all-projects scope can enumerate them. Home is not a "project".
  try {
    const norm = resolve(personaPath).replace(/\\/g, "/");
    const home = resolve(homedir()).replace(/\\/g, "/");
    if (norm.endsWith("/.personaxis/personaxis.md") && !norm.startsWith(`${home}/.personaxis/`)) {
      const projectRoot = dirname(dirname(resolve(personaPath)));
      const subs = discoverTree(personaPath).map((s) => s.address);
      registerProject(projectRoot, subs);
    }
  } catch {
    /* registry is best-effort, never blocks a session */
  }

  // First-run model setup: if no model resolves, offer an interactive setup (skippable).
  if (stdin.isTTY && !resolveModel({ cwd: process.cwd(), personaPath })) {
    const rl = readline.createInterface({ input: stdin, output: stdout });
    let yn = "y";
    try {
      yn = ((await rl.question(`\n  ${chalk.yellow("No model configured.")} Set one up now? ${chalk.dim("[Y/skip]")} `)) || "y").trim().toLowerCase();
    } finally {
      rl.close();
    }
    if (yn === "y" || yn === "yes") {
      if (!process.env.PERSONAXIS_NO_INK && stdout.isTTY) {
        // The Command Center's Model section, the SAME stable alt-screen config
        // the REPL's /config opens (one config UX, first-run and later alike).
        await runCommandCenter({ personaPath, cwd: process.cwd(), section: "model" });
      } else {
        // Headless / NO_INK fallback: the readline wizard.
        const rl2 = readline.createInterface({ input: stdin, output: stdout });
        try {
          await runModelSetup(rl2, { scope: "global", out: (s) => stdout.write(s + "\n") });
        } finally {
          rl2.close();
        }
      }
    } else {
      stdout.write(chalk.dim("  Skipped, running offline (heuristic). Configure anytime with ") + chalk.cyan("/config") + chalk.dim(" here, or ") + chalk.cyan("personaxis config set") + chalk.dim(".\n"));
    }
  }

  const meter = makeMeter();
  const ctx = makeCtx(personaPath, meter);
  // SessionStart user hook (V2-F3.C14): best-effort, never blocks startup.
  void runHooks("SessionStart", { persona: personaPath }, readHooksConfig(personaPath)).catch(() => {});

  // --continue / --resume [id]: rehydrate a saved conversation before the UI starts.
  if (opts.continueLast || opts.resume !== undefined) {
    const query = opts.continueLast ? "" : (opts.resume ?? "");
    const s = resumeSessionInto(ctx, query);
    if (s) {
      stdout.write(chalk.green("  ✓ ") + `resumed ${chalk.bold(s.name)}` + chalk.dim(` · ${ctx.conversation.length} message(s) · ${s.id}\n`));
    } else if (query) {
      stdout.write(chalk.yellow(`  no session matching "${query}"`) + chalk.dim("; starting fresh (see /sessions).\n"));
    } else {
      stdout.write(chalk.dim("  no saved conversation yet; starting fresh.\n"));
    }
  }

  // V8.D: presence belongs to the SESSION, not to a render mode. It lived inside the
  // TTY path at first, so a piped or CI-driven session held the persona invisibly:
  // exactly the concurrent use that presence exists to reveal.
  announcePresence(ctx.handle.personaPath, {
    host: "repl",
    project: process.cwd(),
    sessionId: ctx.sessionId,
    activity: ctx.presence.activity,
  });
  // V8.D4: the write lease, only if this user asked for one. Default is off, because the
  // per-writer model already makes concurrent evolution safe; the lease exists for people
  // who would rather serialise than merge.
  const wantsLease = loadMergedConfig().writeLease === true;
  let readOnly = false;
  if (wantsLease) {
    const taken = acquireLease(ctx.handle.personaPath, { sessionId: ctx.sessionId, reason: "repl session" });
    if (!taken.ok) {
      readOnly = true;
      stdout.write(
        chalk.yellow("  read-only: ") +
          chalk.dim(`another instance holds the write lease · ${describeLease(taken.heldBy)}\n`) +
          chalk.dim("  it frees on exit, or after 90s without a heartbeat.\n"),
      );
    } else if (taken.how === "reclaimed") {
      stdout.write(chalk.dim("  write lease reclaimed from an instance that stopped reporting.\n"));
    }
  }

  const beat = setInterval(() => {
    // G.2: announce the CURRENT activity, not a hardcoded "idle", so a heartbeat during a long
    // turn does not clobber "answering".
    announcePresence(ctx.handle.personaPath, { host: "repl", project: process.cwd(), sessionId: ctx.sessionId, activity: ctx.presence.activity });
    // Renewing on the same beat as presence keeps the two from disagreeing about whether
    // this instance is still alive.
    if (wantsLease && !readOnly) acquireLease(ctx.handle.personaPath, { sessionId: ctx.sessionId, reason: "repl session" });
    // D6: the interval is DERIVED from the staleness window core enforces, never a second
    // literal. This one read 20s while the window said 90s; two numbers that must agree and
    // live apart is how a writer ends up beating slower than readers expire.
  }, PRESENCE_HEARTBEAT_MS);
  beat.unref?.();
  try {
    if (stdin.isTTY) {
      await runScreenMode(ctx);
    } else {
      await runLineMode(ctx);
    }
  } finally {
    clearInterval(beat);
    // A crash skips this, which is why readers also judge by heartbeat age: nothing
    // may depend on a dying process doing the right thing.
    releasePresence(ctx.handle.personaPath);
    if (wantsLease && !readOnly) releaseLease(ctx.handle.personaPath);
  }
}

// ── Non-TTY: simple line reader (pipes/CI) ───────────────────────────────────
async function runLineMode(ctx: Ctx): Promise<void> {
  stdout.write("\n");
  await awaken(ctx.handle.frontmatter, readState(ctx.handle.statePath));
  stdout.write(voiceWrap(ctx.theme, `  ${ctx.name} is awake`) + chalk.dim(` · mode=${ctx.mode} · posture=${POSTURES[ctx.postureIndex]}\n\n`));

  const roster = buildRoster(ctx);
  if (roster.subs.length) {
    stdout.write(chalk.dim(`  sub-personas: `) + roster.subs.map((s) => chalk.ansi256(roster.color(s.address) ?? 39).bold(`@${s.address}`)).join("  ") + chalk.dim(`  ·  @${roster.subs[0]!.address} <message> to address one · @all = every sub\n\n`));
  }
  if (!llmConfig(ctxModelArg(ctx))) firstRunModelHint((s) => stdout.write(s + "\n"));

  const rl = readline.createInterface({ input: stdin, output: stdout });
  for await (const raw of rl) {
    const line = raw.trim();
    if (line) {
      if (line.startsWith("/")) {
        if (await runCommand(line, ctx)) break;
      } else {
        noteActivity(ctx, "answering");
        try {
          await dispatchTurn(line, ctx, roster);
        } finally {
          noteActivity(ctx, "idle");
        }
      }
    }
  }
  rl.close();
  closeSession(ctx);
  await farewell(ctx.handle.frontmatter);
}


// ── TTY: minimalist interactive REPL in the NORMAL buffer ────────────────────
async function runScreenMode(ctx: Ctx): Promise<void> {
  // ONE source for "what commands exist": `listCommands()`, the same list `/help`
  // and line-mode use. This used to build its own from raw COMMANDS, so the palette
  // offered all forty while /help showed the grouped surface, so the consolidation
  // was invisible exactly where a person looks for it.
  const commands: SlashItem[] = [
    ...listCommands(),
    // User-defined commands (.personaxis/commands/*.md) show in the palette too.
    ...loadCustomCommands(ctx.handle.personaPath).map((c) => ({ name: c.name, desc: `${c.description} (custom)` })),
  ];
  let screen: InkScreen;
  let lastMs = 0;

  const roster = buildRoster(ctx);

  // Status line shown BELOW the input. Labels are explicit so "locked" etc. are
  // unambiguous. Width-aware: drops low-priority segments on narrow terminals.
  // V7.E3: the status bar carries the numbers that matter, in priority order, each
  // with its own visual weight: a proportional context meter that turns amber then
  // red as it fills, session spend, the model actually answering, reply time, the
  // persona's improve mode, the session posture, and any daemon running. Segments
  // drop from the right as the terminal narrows, so it never wraps.
  const status = (): string => {
    const m = ctx.meter;
    const cols = stdout.columns ?? 80;
    const seg: string[] = [];

    if (m.limit) {
      const pct = Math.round(m.pct * 100);
      const filled = Math.max(0, Math.min(8, Math.round(m.pct * 8)));
      const bar = "█".repeat(filled) + "░".repeat(8 - filled);
      const paint = m.pct >= 0.85 ? chalk.red : m.pct >= 0.6 ? chalk.yellow : chalk.green;
      seg.push(`${paint(bar)} ${chalk.dim(`${fmtK(m.used)}/${fmtK(m.limit)}`)} ${paint(`${pct}%`)}`);
    } else {
      seg.push(chalk.dim("no model"));
    }
    if (ctx.usage.costUsd > 0) seg.push(chalk.dim(`$${ctx.usage.costUsd.toFixed(3)}`));
    const llm = llmConfig(ctxModelArg(ctx));
    if (llm && cols >= 100) seg.push(chalk.dim(llm.model));
    if (lastMs) seg.push(chalk.dim(`${(lastMs / 1000).toFixed(1)}s`));
    seg.push(chalk.dim(`improve ${ctx.mode}`));
    if (cols >= 64) seg.push(chalk.dim(`${POSTURES[ctx.postureIndex]}`) + chalk.dim.italic(" shift+tab"));
    const daemons = Object.entries(ctx.bg ?? {}).filter(([, c]) => c.exitCode === null).map(([n]) => n);
    if (daemons.length && cols >= 80) seg.push(chalk.green(`● ${daemons.join(" ")}`));
    return "  " + seg.join(chalk.dim("  ·  "));
  };

  // The header is the INPUT's chrome, not a banner. The wordmark is gone: repeating the
  // tool's own name above every prompt is noise, since you already know what you launched.
  // What stays is who you are talking to, where, and under which posture, prefixed by a
  // rule so it never reads as part of the reply above it.
  const headerAddress = slugAddressFromPath(ctx.handle.personaPath);
  const header = (): string =>
    chalk.dim("─ ") +
    chalk.bold.ansi256(ctx.theme.palette.accent)(ctx.name) +
    chalk.dim(headerAddress ? ` @${headerAddress}` : " (main)") +
    chalk.dim(`  ·  ${basename(process.cwd()) || process.cwd()}`) +
    chalk.dim(`  ·  ${POSTURES[ctx.postureIndex]}`);

  screen = new InkScreen({
    prompt: () => chalk.bold("› "),
    status,
    commands,
    header,
    personaPath: ctx.handle.personaPath,
    // V5.P2.1: the qualitative plane shown below the numeric coordinates in /drift.
    qualitativeDrift: () => qualitativeDriftLines(ctx),
    // FASE 7 P2, the live drift gauge, themed by the persona (gap G5).
    driftSegment: (report) =>
      driftGauge(ctx.theme, report as Parameters<typeof driftGauge>[1]),
    onCycleMode: () => {
      ctx.postureIndex = (ctx.postureIndex + 1) % POSTURES.length;
      notePostureChange(ctx);
      // V7.A2: ctx lives outside React, so the header/status only repaint if we ask.
      screen.refresh();
    },
    // V2-F2, Ctrl+K = the Command Center, same stable modal /menu opens.
    onOpenMenu: async () => {
      await runCommand("/menu", ctx);
    },
    onExit: () => screen.stop(),
    onSubmit: async (line) => {
      if (line.startsWith("/")) {
        screen.print("", "divider");
        screen.print(userLine(line), "user");
        const done = await runCommand(line, ctx);
        if (done) {
          screen.stop();
          closeSession(ctx); // distill + consolidate + prune before we vanish
          await farewell(ctx.handle.frontmatter);
          process.exit(0);
        }
        screen.print(""); // trailing gap before the next prompt
        return;
      }
      // Chat/agent turn, route to the ROOT or to sub-personas via @mentions.
      screen.print("", "divider");
      screen.print(userLine(line), "user");
      screen.setBusy(true, "thinking");
      const t0 = Date.now();
      noteActivity(ctx, "answering");
      try {
        await dispatchTurn(line, ctx, roster, (p) => screen.setPhase(p));
      } finally {
        screen.setBusy(false);
        noteActivity(ctx, "idle");
      }
      lastMs = Date.now() - t0;
    },
  });

  ctx.out = (t, role) => screen.print(t, role ?? "system");
  ctx.phase = (label) => screen.setPhase(label);
  // Lets a view collect an argument (a goal's text, a tick count), which is what
  // allows those capabilities to live inside the command that absorbed them instead
  // of surviving as hidden slash commands.
  ctx.ask = (prompt) => screen.ask(prompt);
  const perms = loadMergedConfig().permissions ?? {};
  ctx.approve = async (call) => {
    // Persistent permissions (V2-F3.B9): consult config allow/deny before asking.
    const decision = matchPermission(call.name, callDetail(call.args), perms);
    if (decision === "deny") return "deny";
    if (decision === "allow") return "always";
    const ans = (await screen.ask(`  approve ${chalk.cyan(call.name)}?  [y]es · [a]lways · [N]o`)).trim().toLowerCase();
    return ans === "y" || ans === "yes" ? "approve" : ans === "a" || ans === "always" ? "always" : "deny";
  };
  // FASE 7 P2, the app breathes the math: the loop's events drive the gauge,
  // the crossing moment, the drift view, and full-screen suspensions.
  ctx.onDrift = (report) => screen.setDrift(report as never);
  ctx.onMoment = (crossings) => screen.playMoment(crossings);
  ctx.openDriftView = () => screen.openView("drift");
  ctx.openView = (name, params) => screen.openView(name, params);
  ctx.suspend = (fn) => screen.suspend(fn);
  ctx.clearScreen = () => screen.clearScreen();
  // V5.P1.2 + V6.1: the Settings miniapp, now interactive (in-place edits + drill-downs).
  registerTabbedView("settings", settingsProvider(ctx));
  // V5.P1.4: the /memory two-level browser (kinds -> entries -> default editor).
  registerMemoryView({
    kinds: () => memoryKindRows(ctx),
    openFile: openInEditor,
    consolidate: () => memoryConsolidate(ctx),
    prune: () => memoryPrune(ctx),
    notify: (line) => screen.print(line, "activity"),
  });
  // V5.P3.3 + V6.1: the Persona miniapp; Anatomy drills into each of the ten layers.
  registerTabbedView("persona", personaProvider(ctx));
  // V7.B: the Ledger, one place for all the evidence (absorbs /replay and hosts /rewind).
  // V7.C1b: scoped, because every persona keeps its OWN mutation log, memory chain and
  // self-edits; a ledger that only ever showed the main persona's evidence would be the
  // exact gap that made sub-personas hard to manage.
  registerTabbedView(
    "audit",
    scopedProvider(ctx, (c) => ({ title: "Ledger", tabs: [...AUDIT_TABS], lines: (t) => auditLines(c, t) })),
  );
  // V7.F: /drift as three planes (Continuous / Structural / Behavioral), every row a
  // delta with a magnitude and, where there is one, a literal before/after behind Enter.
  registerTabbedView("drift-planes", driftProvider(ctx));
  // V7.B4 + V7.C1b: Doctor as a scoped miniapp, so a sub-persona's health is one key
  // away instead of requiring `/doctor @slug` typed from memory.
  registerTabbedView("doctor", doctorProvider(ctx));
  // V5.P2.3: the state history view behind /rewind and /replay.
  registerHistoryView({
    log: () =>
      (readState(ctx.handle.statePath).mutation_log ?? []).map((m, idx) => ({
        idx,
        ts: (m as { ts?: string }).ts ?? "",
        field: (m as { field?: string }).field ?? "?",
        from: (m as { from?: number }).from,
        to: (m as { to?: number }).to,
        actor: (m as { actor?: string }).actor,
        clamped: (m as { clamped?: boolean }).clamped,
        blocked: (m as { blocked?: boolean }).blocked,
        reason: (m as { reason?: string }).reason,
      })),
    preview: (n) => {
      // The plan and nothing else. Showing somebody what would happen used to run the
      // same code that did it, against a clone, which is a simulation only for as
      // long as nobody forgets the clone.
      const env = extractEnvelopes(ctx.handle.frontmatter);
      const { moves } = rewindPlan(readState(ctx.handle.statePath), env.envelopes, n);
      return moves.map((m) => ({ field: m.field, from: m.from, to: m.to }));
    },
    rewind: async (n) => {
      const env = extractEnvelopes(ctx.handle.frontmatter);
      const { changed, steps } = await rewind(
        ctx.handle.personaPath,
        ctx.handle.statePath,
        readState(ctx.handle.statePath),
        env.envelopes,
        n,
        // The operator, unnamed. The REPL knows a person typed this and does not know
        // which person, and inventing one would put a name on entries nobody signed.
        record.authorOf("human-operator"),
      );
      return changed.length
        ? chalk.dim(`  rewound ${steps} mutation(s) · restored ${changed.length} field(s): ${changed.join(", ")} (recorded, chain intact)`)
        : chalk.dim(`  rewind ${steps}: state already at that point.`);
    },
    notify: (line) => screen.print(line, "activity"),
  });
  // V5.P1.10: the /skill miniapp (per-persona list, apply, pull hint).
  const skillPersonaPath = (who: string): string => {
    if (who === "main") return ctx.handle.personaPath;
    const hit = discoverTree(ctx.handle.personaPath).find((s) => `@${s.address}` === who);
    return hit ? hit.path : ctx.handle.personaPath;
  };
  // V7.A5: every action is REAL now (add / materialize / update / remove), shared with
  // the external subcommands through views/skills-data.ts, and scoped to the persona
  // selected in the miniapp instead of always acting on main.
  registerSkillsView({
    personas: () => ["main", ...discoverTree(ctx.handle.personaPath).map((s) => `@${s.address}`)],
    skills: (who) => listSkills(skillPersonaPath(who)),
    apply: (_who, name) => {
      void runCommand(`/skill ${name}`, ctx);
    },
    add: (who, ref) => addSkill(skillPersonaPath(who), ref).message,
    pull: (who, name) => pullSkill(skillPersonaPath(who), name).message,
    update: (who, name) => updateSkill(skillPersonaPath(who), name).message,
    remove: (who, name) => removeSkill(skillPersonaPath(who), name).message,
    notify: (line) => screen.print(line, "activity"),
  });
  // V5.P1.9: the /hooks submenu (status + install/uninstall per host).
  const HOOK_WHAT: Record<string, string> = {
    "claude-code": "adds a Stop hook to .claude/settings.json: each Claude Code turn feeds a governed tick (no host tokens spent)",
    codex: "adds a Stop hook to .codex/hooks.json: each Codex turn feeds a governed tick",
    openclaw: "installs ~/.openclaw/hooks/personaxis-observe (enable with: openclaw hooks enable personaxis-observe)",
    hermes: "installs ~/.hermes/hooks/personaxis-observe, fires on agent:end (per turn)",
  };
  registerHooksView({
    rows: () =>
      HOSTS.map((h) => {
        const scoped = h === "claude-code" || h === "codex";
        return {
          host: h,
          scoped,
          projectInstalled: scoped ? hookStatus(h, false).installed : false,
          globalInstalled: hookStatus(h, true).installed,
          path: hookStatus(h, true).path,
          what: HOOK_WHAT[h] ?? "",
        };
      }),
    install: (host, global) => {
      try {
        const r = installHook(host as never, global);
        return (r.already ? chalk.dim(`  · already installed at ${r.path}`) : chalk.green(`  ✓ installed at ${r.path}`)) + chalk.dim(r.extra);
      } catch (e) {
        return chalk.red(`  ${(e as Error).message}`);
      }
    },
    uninstall: (host, global) => {
      try {
        const r = uninstallHook(host as never, global);
        return r.removed ? chalk.green(`  ✓ removed from ${r.path}`) : chalk.dim(`  · nothing installed at ${r.path}`);
      } catch (e) {
        return chalk.red(`  ${(e as Error).message}`);
      }
    },
    notify: (line) => screen.print(line, "activity"),
  });
  // V5.P1.5 + P1.6: the /improve minimenu and the /review queue.
  registerImproveView({
    current: () => ctx.mode,
    set: (mode) => {
      try {
        const r = runMode(ctx.handle.personaPath, mode as never);
        ctx.mode = r.current;
        return chalk.green(`  ✓ improvement mode → ${chalk.bold(ctx.mode)}`) + (r.changed ? "" : chalk.dim(" (unchanged)"));
      } catch (e) {
        return chalk.red(`  could not set mode: ${(e as Error).message}`);
      }
    },
    notify: (line) => screen.print(line, "activity"),
  });
  registerReviewView({
    pending: () =>
      proposals(ctx.handle.personaPath)
        .filter((x) => x.status === "pending")
        .map((x) => ({ id: x.id, targetPath: x.targetPath, toValue: JSON.stringify(x.toValue).slice(0, 90), rationale: x.rationale ?? "" })),
    approve: (id) => {
      try {
        const r = applySelfEdit(ctx.handle.personaPath, id, "user");
        return chalk.green(`  ✓ applied ${id}`) + chalk.dim(` → v${r.version}`);
      } catch (e) {
        return chalk.red(`  ${id}: ${(e as Error).message}`);
      }
    },
    reject: (id) => {
      try {
        rejectSelfEdit(ctx.handle.personaPath, id, "user");
        return chalk.dim(`  ✗ rejected ${id}`);
      } catch (e) {
        return chalk.red(`  ${id}: ${(e as Error).message}`);
      }
    },
    onClose: (anyApproved) => {
      if (anyApproved) void maybeRecompile(ctx);
    },
    notify: (line) => screen.print(line, "activity"),
  });
  // V5.P1.3: the /resume session picker.
  registerResumeView({
    list: () => listSessions(ctx.handle.personaPath),
    liveId: () => ctx.sessionId,
    resume: (id) => {
      const s = resumeSessionInto(ctx, id);
      if (!s) return null;
      // V7.A6: REBUILD the chosen conversation. The screen is wiped and the whole
      // session is re-printed as it was left, so you land inside that chat instead
      // of continuing it underneath a different one.
      screen.clearScreen();
      screen.print(chalk.dim(`  resumed "${s.name}"  ·  ${ctx.conversation.length} message(s)`), "activity");
      for (const line of replayTranscript(ctx)) screen.print(line.text, line.role);
      // Says where the past ends and the live conversation begins, which a bare
      // divider did not: the whole point of resuming is landing INSIDE that chat.
      screen.print(chalk.dim(`  ── end of the restored history · type to carry on ──`), "activity");
      return { name: s.name, messages: ctx.conversation.length };
    },
    notify: (line) => screen.print(chalk.dim(line), "activity"),
  });

  screen.start();


  screen.print(replyLine(ctx, "awake, talk naturally (it can use tools), /help for commands, ctrl+c to exit."), "persona");
  if (roster.subs.length) {
    const tags = roster.subs.map((s) => chalk.ansi256(roster.color(s.address) ?? 39).bold(`@${s.address}`)).join("  ");
    const first = roster.subs[0]!.address;
    screen.print(chalk.dim(`  sub-personas: `) + tags);
    screen.print(chalk.dim(`  address one directly: `) + chalk.cyan(`@${first} <message>`) + chalk.dim(`  ·  @all = every sub  ·  @<branch>/all = a subtree`));
  }
  if (!llmConfig(ctxModelArg(ctx))) firstRunModelHint((s) => screen.print(s, "activity"));

  // Ink keeps the process alive until unmount / ctrl+c; block here so the session
  // stays open, then say goodbye (the /quit path exits directly before this).
  await screen.waitUntilExit();
  closeSession(ctx);
  await farewell(ctx.handle.frontmatter);
}

/** Guide a first-time user to configure a model instead of silently falling back to heuristic mode. */
