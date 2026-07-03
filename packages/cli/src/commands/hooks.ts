/**
 * `personaxis hooks` — make a host feed the persona from every turn (Fase 3), for ALL four focus
 * hosts. The living engine can't see inside a host's process; the host must FEED it. Each host fires
 * an end-of-turn (or end-of-session) hook that pipes the turn to `personaxis observe --stdin`, which
 * runs one governed tick on YOUR model and recompiles the identity on drift — no host tokens.
 *
 *   claude-code  → .claude/settings.json      Stop hook (project or ~/.claude with --global)
 *   codex        → .codex/hooks.json          Stop hook (project or ~/.codex with --global)
 *   hermes       → ~/.hermes/hooks/<name>/    HOOK.yaml (events: [agent:end]) + handler.py — Hermes'
 *                  real hook mechanism (gateway/hooks.py); agent:end fires PER TURN with the
 *                  message/response context. (Older installs wrote a hooks.on_session_end stanza
 *                  into ~/.hermes/config.yaml — that shape never existed in Hermes; install/uninstall
 *                  clean it up.)
 *   openclaw     → ~/.openclaw/hooks/<name>/   HOOK.md + handler.ts (command:stop), then enable it
 *
 * Idempotent: install merges without clobbering existing hooks; uninstall removes only ours.
 */

import { Command } from "commander";
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import yaml from "js-yaml";
import chalk from "chalk";

const OBSERVE_CMD = "personaxis observe --stdin --source user";
const MARKER = "personaxis observe"; // identifies OUR hook among a host's other hooks
export const HOSTS = ["claude-code", "codex", "openclaw", "hermes"] as const;
export type Host = (typeof HOSTS)[number];

// ── shared JSON Stop-hook shape (Claude Code + Codex use the identical structure) ────────────
type JsonHookSettings = {
  hooks?: { Stop?: Array<{ matcher?: string; hooks?: Array<{ type: string; command: string; timeout?: number }> }> };
  [k: string]: unknown;
};

function readJson<T>(path: string, fallback: T): T {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as T;
  } catch {
    return fallback;
  }
}
function writeJson(path: string, data: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2) + "\n", "utf-8");
}

function jsonStopHookPath(host: "claude-code" | "codex", global: boolean): string {
  if (host === "claude-code") return global ? join(homedir(), ".claude", "settings.json") : join(process.cwd(), ".claude", "settings.json");
  return global ? join(homedir(), ".codex", "hooks.json") : join(process.cwd(), ".codex", "hooks.json");
}
function hasJsonStopHook(s: JsonHookSettings): boolean {
  return (s.hooks?.Stop ?? []).some((g) => (g.hooks ?? []).some((h) => h.command?.includes(MARKER)));
}
function installJsonStopHook(path: string): { path: string; already: boolean } {
  const s = readJson<JsonHookSettings>(path, {});
  if (hasJsonStopHook(s)) return { path, already: true };
  s.hooks = s.hooks ?? {};
  s.hooks.Stop = s.hooks.Stop ?? [];
  s.hooks.Stop.push({ hooks: [{ type: "command", command: OBSERVE_CMD, timeout: 30 }] });
  writeJson(path, s);
  return { path, already: false };
}
function uninstallJsonStopHook(path: string): { path: string; removed: boolean } {
  const s = readJson<JsonHookSettings>(path, {});
  if (!s.hooks?.Stop) return { path, removed: false };
  const before = JSON.stringify(s.hooks.Stop);
  s.hooks.Stop = s.hooks.Stop
    .map((g) => ({ ...g, hooks: (g.hooks ?? []).filter((h) => !h.command?.includes(MARKER)) }))
    .filter((g) => (g.hooks ?? []).length > 0);
  writeJson(path, s);
  return { path, removed: JSON.stringify(s.hooks.Stop) !== before };
}

// ── Hermes: ~/.hermes/hooks/personaxis-observe/{HOOK.yaml, handler.py} ────────────────────────
// Hermes' real hook mechanism (hermes-agent gateway/hooks.py): hooks are discovered from
// ~/.hermes/hooks/<name>/ with a HOOK.yaml (metadata + `events` list) and a Python
// `handler.py` exposing `async def handle(event_type, context)`. Events include
// gateway:startup, session:start/end/reset, agent:start/step/end, command:*.
// `agent:end` fires PER TURN and carries platform/user_id/session_id + the message and
// response — the right feed for per-turn learning (session:end only fires on /new / /reset).
// Handler errors are caught by Hermes and never block its pipeline; our handler is
// additionally fire-and-forget with a timeout.
function hermesConfigPath(): string {
  return join(homedir(), ".hermes", "config.yaml");
}
function hermesHookDir(): string {
  return join(homedir(), ".hermes", "hooks", "personaxis-observe");
}
const HERMES_HOOK_YAML = `name: personaxis-observe
description: "Feed each turn to personaxis (governed tick on your own model; recompiles SOUL.md on drift)."
events:
  - agent:end
`;
const HERMES_HANDLER_PY = `# personaxis-observe — Hermes hook handler (installed by \`personaxis hooks install --host hermes\`).
# Pipes each turn (agent:end) to \`${OBSERVE_CMD}\`: one governed Living-Loop tick on YOUR
# configured model — no Hermes tokens spent. Fire-and-forget: never blocks or raises into Hermes.
import asyncio
import json


async def handle(event_type, context):
    try:
        proc = await asyncio.create_subprocess_exec(
            "personaxis", "observe", "--stdin", "--source", "user",
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.DEVNULL,
        )
        payload = json.dumps({"event": event_type, "context": context}, default=str).encode()
        await asyncio.wait_for(proc.communicate(payload), timeout=60)
    except Exception:
        pass  # best-effort: the persona tick must never break the Hermes pipeline
`;
type HermesLegacyConfig = { hooks?: Record<string, Array<{ command?: string; timeout?: number }>> } & Record<string, unknown>;
/** Remove the stanza an older (incorrect) installer wrote into ~/.hermes/config.yaml. */
function cleanLegacyHermesConfig(): boolean {
  const path = hermesConfigPath();
  if (!existsSync(path)) return false;
  try {
    const cfg = (yaml.load(readFileSync(path, "utf-8")) as HermesLegacyConfig) ?? {};
    const arr = cfg.hooks?.on_session_end;
    if (!arr) return false;
    const kept = arr.filter((h) => !h.command?.includes(MARKER));
    if (kept.length === arr.length) return false;
    if (kept.length === 0) delete cfg.hooks!.on_session_end;
    else cfg.hooks!.on_session_end = kept;
    if (cfg.hooks && Object.keys(cfg.hooks).length === 0) delete cfg.hooks;
    writeFileSync(path, yaml.dump(cfg), "utf-8");
    return true;
  } catch {
    return false; // never let legacy cleanup break the install
  }
}
function installHermes(): { path: string; already: boolean } {
  const dir = hermesHookDir();
  const already = existsSync(join(dir, "HOOK.yaml"));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "HOOK.yaml"), HERMES_HOOK_YAML, "utf-8");
  writeFileSync(join(dir, "handler.py"), HERMES_HANDLER_PY, "utf-8");
  cleanLegacyHermesConfig();
  return { path: dir, already };
}
function uninstallHermes(): { path: string; removed: boolean } {
  const dir = hermesHookDir();
  const hadDir = existsSync(dir);
  if (hadDir) rmSync(dir, { recursive: true, force: true });
  const hadLegacy = cleanLegacyHermesConfig();
  return { path: dir, removed: hadDir || hadLegacy };
}

// ── openclaw: ~/.openclaw/hooks/personaxis-observe/{HOOK.md, handler.ts} ──────────────────────
function openclawHookDir(): string {
  return join(homedir(), ".openclaw", "hooks", "personaxis-observe");
}
const OPENCLAW_HOOK_MD = `---
name: personaxis-observe
description: "Feed each turn to personaxis (governed tick on your own model; recompiles SOUL.md on drift)."
metadata:
  { "openclaw": { "emoji": "🧠", "events": ["command:stop"], "requires": { "bins": ["personaxis"] } } }
---

# Personaxis observe

On \`/stop\`, pipes the turn context to \`${OBSERVE_CMD}\` — one governed Living-Loop tick on your
configured model, recompiling SOUL.md when a governed self-edit drifts the spec. Never blocks the turn.
`;
const OPENCLAW_HANDLER_TS = `import { execFile } from "node:child_process";

// Feed each /stop event to personaxis (best-effort; never throws into the host).
export default async function handler(event: { type?: string; action?: string; context?: unknown }): Promise<void> {
  if (event?.type !== "command" || event?.action !== "stop") return;
  await new Promise<void>((resolve) => {
    const child = execFile("personaxis", ["observe", "--stdin", "--source", "user"], () => resolve());
    try {
      child.stdin?.end(JSON.stringify({ context: event.context ?? "" }));
    } catch {
      resolve();
    }
  });
}
`;
function installOpenclaw(): { path: string; already: boolean } {
  const dir = openclawHookDir();
  const already = existsSync(join(dir, "HOOK.md"));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "HOOK.md"), OPENCLAW_HOOK_MD, "utf-8");
  writeFileSync(join(dir, "handler.ts"), OPENCLAW_HANDLER_TS, "utf-8");
  return { path: dir, already };
}
function uninstallOpenclaw(): { path: string; removed: boolean } {
  const dir = openclawHookDir();
  const removed = existsSync(dir);
  if (removed) rmSync(dir, { recursive: true, force: true });
  return { path: dir, removed };
}

/** Install the end-of-turn hook for a host. Reusable by `hooks install` and `onboard`. */
export function installHook(host: Host, global: boolean): { path: string; already: boolean; extra: string } {
  if (host === "claude-code" || host === "codex") {
    return { ...installJsonStopHook(jsonStopHookPath(host, global)), extra: "" };
  }
  if (host === "hermes") {
    return { ...installHermes(), extra: " · fires on agent:end (per turn) via ~/.hermes/hooks/personaxis-observe" };
  }
  return { ...installOpenclaw(), extra: " · enable it with: openclaw hooks enable personaxis-observe" };
}

// ── command wiring ───────────────────────────────────────────────────────────────────────────
const installCommand = new Command("install")
  .description(`Install the end-of-turn hook so the persona learns from each turn. Hosts: ${HOSTS.join(" | ")}.`)
  .option("--host <host>", `Host to wire: ${HOSTS.join(" | ")}`, "claude-code")
  .option("-g, --global", "Install to the user config instead of the project (claude-code/codex)", false)
  .action((opts: { host: string; global?: boolean }) => {
    if (!(HOSTS as readonly string[]).includes(opts.host)) {
      console.error(chalk.red("Error:"), `unknown host "${opts.host}". Use: ${HOSTS.join(" | ")}`);
      process.exit(1);
    }
    const res = installHook(opts.host as Host, Boolean(opts.global));
    if (res.already) {
      console.log(chalk.dim(`· personaxis hook already installed at`), chalk.cyan(res.path));
    } else {
      console.log(chalk.green("✓"), `installed ${opts.host} hook at`, chalk.cyan(res.path));
      console.log(chalk.dim(`  runs: ${OBSERVE_CMD}${res.extra}`));
      console.log(chalk.dim("  every turn now feeds one governed tick on your configured model (no host tokens)."));
    }
  });

const uninstallCommand = new Command("uninstall")
  .description("Remove the personaxis end-of-turn hook for a host.")
  .option("--host <host>", `Host: ${HOSTS.join(" | ")}`, "claude-code")
  .option("-g, --global", "Remove from the user config instead of the project (claude-code/codex)", false)
  .action((opts: { host: string; global?: boolean }) => {
    if (!(HOSTS as readonly string[]).includes(opts.host)) {
      console.error(chalk.red("Error:"), `unknown host "${opts.host}".`);
      process.exit(1);
    }
    const host = opts.host as Host;
    let res: { path: string; removed: boolean };
    if (host === "claude-code" || host === "codex") res = uninstallJsonStopHook(jsonStopHookPath(host, Boolean(opts.global)));
    else if (host === "hermes") res = uninstallHermes();
    else res = uninstallOpenclaw();
    console.log(res.removed ? chalk.green("✓ removed") : chalk.dim("· nothing to remove"), chalk.cyan(res.path));
  });

export const hooksCommand = new Command("hooks")
  .description("Wire a host (Claude Code, Codex, openclaw, Hermes) so the persona learns from each turn via `personaxis observe`.")
  .addCommand(installCommand)
  .addCommand(uninstallCommand);

// Exported for tests.
export { jsonStopHookPath, installJsonStopHook, hasJsonStopHook, hermesConfigPath, hermesHookDir, openclawHookDir, OBSERVE_CMD };
