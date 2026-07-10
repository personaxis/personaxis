/**
 * REPL background daemons + CLI passthrough (F3.6 split).
 *
 * `/serve` and `/watch` run as detached-from-the-terminal (but REPL-tied) child
 * processes so the app never blocks; any other `/command` that isn't native
 * falls through to a `personaxis <name>` subprocess whose output is echoed back.
 */

import { execFileSync, spawn } from "node:child_process";
import chalk from "chalk";
import type { Ctx } from "./types.js";

/** Kill any background daemons (serve/watch) started from `/` — called on exit. */
export function stopDaemons(ctx: Ctx): void {
  for (const child of Object.values(ctx.bg ?? {})) {
    try {
      child.kill();
    } catch {
      /* already gone */
    }
  }
  ctx.bg = {};
}

/** Start or stop a long-running daemon (serve/watch) in the BACKGROUND, so the app doesn't block. */
export function startStopDaemon(
  name: string,
  arg: string,
  ctx: Ctx,
  buildArgs: (port: string) => string[],
  describe: (port: string) => string,
): void {
  ctx.bg = ctx.bg ?? {};
  const rest = arg.trim();
  if (rest === "stop") {
    const child = ctx.bg[name];
    if (!child) return void ctx.out(chalk.dim(`  /${name}: not running.`));
    try {
      child.kill();
    } catch {
      /* already gone */
    }
    delete ctx.bg[name];
    return void ctx.out(chalk.green(`  ✓ stopped ${name}`));
  }
  if (ctx.bg[name] && ctx.bg[name].exitCode === null) {
    return void ctx.out(chalk.dim(`  /${name} is already running (pid ${ctx.bg[name].pid}) — /${name} stop to stop it.`));
  }
  const port = rest; // for serve
  const child = spawn(process.execPath, [process.argv[1], ...buildArgs(port)], {
    cwd: process.cwd(),
    detached: false, // tied to the REPL: stopping the app stops the daemon
    stdio: "ignore",
    env: { ...process.env },
  });
  child.on("error", (e) => ctx.out(chalk.red(`  /${name} failed to start: ${e.message}`)));
  ctx.bg[name] = child;
  ctx.out(chalk.green(`  ✓ ${name} running in the background`) + chalk.dim(` (pid ${child.pid}) — ${describe(port)}`));
  ctx.out(chalk.dim(`  /${name} stop to stop it (it also stops when you /exit).`));
}

/** FASE 7 P2 — run `personaxis <name> <args>` on the RAW TTY (stdio inherited),
 *  for full-screen flows the app suspends into: proof scenes, the Genesis wizard.
 *  Cross-OS: process.execPath + argv[1], no shell. */
export function runCliInteractive(name: string, arg: string): Promise<void> {
  const args = arg.split(/\s+/).filter(Boolean);
  return new Promise<void>((resolve) => {
    const child = spawn(process.execPath, [process.argv[1], name, ...args], {
      cwd: process.cwd(),
      stdio: "inherit",
      env: { ...process.env, FORCE_COLOR: process.env.NO_COLOR ? "0" : "1" },
    });
    child.on("close", () => resolve());
    child.on("error", () => resolve());
  });
}

/** Run `personaxis <name> <args>` as a subprocess (the same build) and echo its output into the REPL. */
export function runCliPassthrough(name: string, arg: string, ctx: Ctx): void {
  const args = arg.split(/\s+/).filter(Boolean);
  try {
    const out = execFileSync(process.execPath, [process.argv[1], name, ...args], {
      cwd: process.cwd(), // where the user launched the app (the project root)
      encoding: "utf-8",
      env: { ...process.env, FORCE_COLOR: "1" },
      timeout: 60_000,
    });
    for (const l of out.replace(/\n$/, "").split("\n")) ctx.out("  " + l);
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; status?: number };
    const text = ((err.stdout ?? "") + (err.stderr ?? "")).trim();
    if (text) for (const l of text.split("\n")) ctx.out("  " + l);
    else ctx.out(chalk.yellow(`  /${name} failed (exit ${err.status ?? "?"}) — is it a valid command? try /help or \`personaxis --help\``));
  }
}
