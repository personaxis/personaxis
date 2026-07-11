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
import { join } from "node:path";
import chalk from "chalk";
import { readState } from "@personaxis/core";
import { animateLogo, awaken, voiceWrap, farewell, driftGauge } from "@personaxis/tui/visual";
import { type SlashItem } from "@personaxis/tui/screen";
import { InkScreen } from "@personaxis/tui/ink";
import { writeStarterPersona } from "../starter.js";
import type { Ctx, ReplOptions } from "./types.js";
import { POSTURES, resolvePersonaPath, notePostureChange, llmConfig, ctxModelArg, makeMeter } from "./config.js";
import { replyLine, fmtK, firstRunModelHint } from "./render.js";
import { makeCtx } from "./session.js";
import { dispatchTurn, buildRoster } from "./turn.js";
import { COMMANDS, listCommands, runCommand } from "./commands.js";

// Re-exported for the REPL's public surface (tests + the CLI entry import these). The whole
// REPL was split into modules (F3.6): types, config, render, daemons, session, turn, commands.
export { parseMentions } from "./turn.js";
export { notePostureChange, listCommands };

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
    stdout.write(chalk.green("  ✓ ") + `created ${chalk.cyan(personaPath)}, ${chalk.bold(name)} is ready.\n`);
  }

  const meter = makeMeter();
  const ctx = makeCtx(personaPath, meter);

  if (stdin.isTTY) {
    await runScreenMode(ctx);
  } else {
    await runLineMode(ctx);
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


// ── TTY: minimalist interactive REPL in the NORMAL buffer ────────────────────
async function runScreenMode(ctx: Ctx): Promise<void> {
  const commands: SlashItem[] = COMMANDS.filter((c) => c.name !== "quit").map((c) => ({ name: c.name, desc: c.desc }));
  let screen: InkScreen;
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

  // FASE 7 P2, the persistent header: compact wordmark · persona · posture.
  const header = (): string =>
    chalk.bold("◉ personaxis") +
    chalk.dim("  ·  ") +
    chalk.bold.ansi256(ctx.theme.palette.accent)(ctx.name) +
    chalk.dim(`  ·  ${POSTURES[ctx.postureIndex]}`);

  screen = new InkScreen({
    prompt: () => chalk.bold("› "),
    status,
    commands,
    header,
    personaPath: ctx.handle.personaPath,
    // FASE 7 P2, the live drift gauge, themed by the persona (gap G5).
    driftSegment: (report) =>
      driftGauge(ctx.theme, report as Parameters<typeof driftGauge>[1]),
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
      // Chat/agent turn, route to the ROOT or to sub-personas via @mentions.
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
  // FASE 7 P2, the app breathes the math: the loop's events drive the gauge,
  // the crossing moment, the drift view, and full-screen suspensions.
  ctx.onDrift = (report) => screen.setDrift(report as never);
  ctx.onMoment = (crossings) => screen.playMoment(crossings);
  ctx.openDriftView = () => screen.openView("drift");
  ctx.suspend = (fn) => screen.suspend(fn);

  screen.start();
  screen.print(replyLine(ctx, "awake, talk naturally (it can use tools), /help for commands, ctrl+c to exit."), "persona");
  if (roster.subs.length) {
    const tags = roster.subs.map((s) => chalk.ansi256(roster.color(s.address) ?? 39).bold(`@${s.address}`)).join("  ");
    screen.print(chalk.dim(`  sub-personas: `) + tags + chalk.dim("  ·  @address · @all · @parent/all"));
  }
  if (!llmConfig(ctxModelArg(ctx))) firstRunModelHint((s) => screen.print(s, "activity"));

  // Ink keeps the process alive until unmount / ctrl+c; block here so the session
  // stays open, then say goodbye (the /quit path exits directly before this).
  await screen.waitUntilExit();
  await farewell(ctx.handle.frontmatter);
}

/** Guide a first-time user to configure a model instead of silently falling back to heuristic mode. */
