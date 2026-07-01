/**
 * `personaxis hooks` — wire a host so the persona learns from every turn (Fase 3).
 *
 * The living engine can't see inside the host's process; the host must FEED it. Claude Code's `Stop`
 * hook fires at the end of each turn with a JSON payload (incl. the transcript path). We install a
 * hook that pipes that payload to `personaxis observe --stdin`, which runs one governed tick on OUR
 * model and recompiles PERSONA.md on drift — so learning happens without spending the host's tokens.
 *
 * Idempotent: install merges our hook without clobbering existing ones; uninstall removes only ours.
 */

import { Command } from "commander";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import chalk from "chalk";

const HOOK_COMMAND = "personaxis observe --stdin --source user";
const MARKER = "personaxis observe"; // identifies OUR hook among others

type ClaudeSettings = {
  hooks?: { Stop?: Array<{ matcher?: string; hooks?: Array<{ type: string; command: string }> }> };
  [k: string]: unknown;
};

function claudeSettingsPath(global: boolean): string {
  return global ? join(homedir(), ".claude", "settings.json") : join(process.cwd(), ".claude", "settings.json");
}

function readSettings(path: string): ClaudeSettings {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as ClaudeSettings;
  } catch {
    return {};
  }
}

function writeSettings(path: string, s: ClaudeSettings): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(s, null, 2) + "\n", "utf-8");
}

/** Does any Stop hook already invoke `personaxis observe`? */
function hasOurHook(s: ClaudeSettings): boolean {
  return (s.hooks?.Stop ?? []).some((g) => (g.hooks ?? []).some((h) => h.command?.includes(MARKER)));
}

function installClaudeCode(global: boolean): { path: string; already: boolean } {
  const path = claudeSettingsPath(global);
  const s = readSettings(path);
  if (hasOurHook(s)) return { path, already: true };
  s.hooks = s.hooks ?? {};
  s.hooks.Stop = s.hooks.Stop ?? [];
  s.hooks.Stop.push({ hooks: [{ type: "command", command: HOOK_COMMAND }] });
  writeSettings(path, s);
  return { path, already: false };
}

function uninstallClaudeCode(global: boolean): { path: string; removed: boolean } {
  const path = claudeSettingsPath(global);
  const s = readSettings(path);
  if (!s.hooks?.Stop) return { path, removed: false };
  const before = s.hooks.Stop.length;
  s.hooks.Stop = s.hooks.Stop
    .map((g) => ({ ...g, hooks: (g.hooks ?? []).filter((h) => !h.command?.includes(MARKER)) }))
    .filter((g) => (g.hooks ?? []).length > 0);
  const removed = s.hooks.Stop.length !== before || before === 0 ? true : false;
  writeSettings(path, s);
  return { path, removed };
}

const installCommand = new Command("install")
  .description("Install the end-of-turn hook so the persona learns from each turn (runs on our model).")
  .option("--host <host>", "Host to wire: claude-code", "claude-code")
  .option("-g, --global", "Install to the user config (~/.claude/settings.json) instead of the project", false)
  .action((opts: { host: string; global?: boolean }) => {
    if (opts.host !== "claude-code") {
      console.error(
        chalk.yellow("·"),
        `host "${opts.host}" has no per-turn hook mechanism yet. For Codex/others, use the MCP server ` +
          `(personaxis-mcp, on-demand) or a serverless cron running \`personaxis observe --once\`.`,
      );
      process.exit(1);
    }
    const { path, already } = installClaudeCode(Boolean(opts.global));
    if (already) {
      console.log(chalk.dim("· personaxis Stop hook already installed at"), chalk.cyan(path));
    } else {
      console.log(chalk.green("✓"), "installed Claude Code Stop hook at", chalk.cyan(path));
      console.log(chalk.dim(`  it runs: ${HOOK_COMMAND}`));
      console.log(chalk.dim("  every turn now feeds one governed tick on your configured model (no host tokens)."));
    }
  });

const uninstallCommand = new Command("uninstall")
  .description("Remove the personaxis end-of-turn hook.")
  .option("--host <host>", "Host: claude-code", "claude-code")
  .option("-g, --global", "Remove from the user config instead of the project", false)
  .action((opts: { host: string; global?: boolean }) => {
    if (opts.host !== "claude-code") {
      console.error(chalk.yellow("·"), `unknown host "${opts.host}".`);
      process.exit(1);
    }
    const { path, removed } = uninstallClaudeCode(Boolean(opts.global));
    console.log(removed ? chalk.green("✓ removed") : chalk.dim("· nothing to remove"), chalk.cyan(path));
  });

export const hooksCommand = new Command("hooks")
  .description("Wire a host (Claude Code) so the persona learns from each turn via `personaxis observe`.")
  .addCommand(installCommand)
  .addCommand(uninstallCommand);
