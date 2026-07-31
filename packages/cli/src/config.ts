import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "fs";
import { dirname, resolve } from "path";
import { globalConfigPath as coreGlobalConfigPath, projectConfigPath as coreProjectConfigPath, type ModelSettings } from "@personaxis/core";
import type { ProviderName } from "./providers/types.js";

/** "project" → <cwd>/.personaxis/config.json · "global" → ~/.personaxis/config.json (PERSONAXIS_HOME). */
export type ConfigScope = "project" | "global";

export interface PersonaxisConfig {
  /** Default provider for compile/decompile. Defaults to "agent" if unset. */
  provider?: ProviderName;
  local?: ModelSettings;
  /** A named library of reusable model profiles, referenced by defaultProfile / personas[].profile. */
  profiles?: Record<string, ModelProfile>;
  /** Name of the profile used as the default (an inline `local` still overrides it). */
  defaultProfile?: string;
  /** Per-persona model overrides, keyed by slug: a `profile` reference and/or inline fields. */
  personas?: Record<string, ModelSettings & { profile?: string }>;
  byok?: {
    /** Which API the key in ANTHROPIC_API_KEY / OPENAI_API_KEY belongs to. */
    apiProvider?: "anthropic" | "openai";
    model?: string;
  };
  remote?: {
    apiBase?: string;
    model?: string;
  };
  /** Persistent tool-permission rules (V2-F3.B9): allow/deny glob patterns matched
   *  against a tool call before the human is asked. Project rules concatenate onto global. */
  permissions?: { allow?: string[]; deny?: string[] };
  /** MCP client servers (V2-F3.B11): stdio MCP servers this persona can mount as tools,
   *  keyed by name. Managed with `personaxis mcp add/list/remove`. */
  mcpServers?: Record<string, { command: string; args?: string[]; env?: Record<string, string> }>;
  /** Opt-in telemetry (V2-F3.D21), default OFF. Lightweight local span log; an
   *  OpenTelemetry SDK exporter is a follow-up. */
  telemetry?: { enabled?: boolean; file?: string };
  /** Configurable statusline template (V2-F3.D20). `{key}` placeholders are filled
   *  (persona, model, posture, drift, tokens). Unset uses the built-in line. */
  statusline?: string;
  /**
   * Folders `personaxis scan-projects` may walk looking for personas (V8.E2).
   *
   * Declared by the user, never inferred: the registry only ever knew a project if the
   * REPL had been opened inside it, so someone with ten projects saw one. Scanning fixes
   * that, but scanning somebody's disk uninvited does not become acceptable just because
   * it is useful. `~` is expanded.
   */
  scanRoots?: string[];
  /**
   * Take an exclusive write lease while a session runs (V8.D4). Default off.
   *
   * Off is correct for almost everyone: per-writer chains make concurrent evolution safe
   * on their own. Turn it on when you would rather one machine be the only author for a
   * stretch, and accept that the others go read-only while it is.
   */
  writeLease?: boolean;
}

/**
 * A named, reusable model profile. Covers every provider kind so one profile can drive both
 * compile/decompile (via `resolveProvider`) and the live REPL reasoning (via `resolveModel`, which
 * reads the OpenAI-compatible `endpoint`/`model`/key subset). Provider-specific fields:
 *   local  (default) → endpoint, model, apiKey/apiKeyEnv
 *   byok             → apiProvider (anthropic|openai), model; key from ANTHROPIC_API_KEY/OPENAI_API_KEY
 *                      (a byok-openai profile also sets endpoint so the live REPL can use it)
 *   remote           → apiBase, model; token from PERSONAXIS_API_TOKEN
 *   agent            → no fields (hands the prompt to the active coding agent)
 */
export interface ModelProfile extends ModelSettings {
  provider?: ProviderName;
  /** For provider "byok": which vendor the key belongs to. */
  apiProvider?: "anthropic" | "openai";
  /** For provider "remote": the Personaxis-hosted API base. */
  apiBase?: string;
}

export function configPath(scope: ConfigScope = "project"): string {
  return scope === "global" ? coreGlobalConfigPath() : resolve(coreProjectConfigPath(process.cwd()));
}

export function loadConfig(scope: ConfigScope = "project"): PersonaxisConfig {
  const p = configPath(scope);
  if (!existsSync(p)) return {};
  try {
    return JSON.parse(readFileSync(p, "utf-8")) as PersonaxisConfig;
  } catch {
    return {};
  }
}

export function saveConfig(config: PersonaxisConfig, scope: ConfigScope = "project"): void {
  const p = configPath(scope);
  mkdirSync(dirname(p), { recursive: true });
  // The config may hold an inline API key (like ~/.aws/credentials, ~/.config/gh/hosts.yml, …), so
  // write it user-only-readable (0o600). No-op on Windows, protective on Unix.
  writeFileSync(p, JSON.stringify(config, null, 2) + "\n", { encoding: "utf-8", mode: 0o600 });
  try {
    chmodSync(p, 0o600); // enforce perms on an already-existing file too
  } catch {
    /* Windows / unsupported FS, home dir is already user-scoped */
  }
}

/**
 * The effective config = global defaults overridden by the project, per section. This is what the
 * provider factory reads, so `config set --global provider/byok/remote/local …` reaches compile, 
 * the same precedence the living loop's resolveModel uses (env > project > global).
 */
export function loadMergedConfig(): PersonaxisConfig {
  const g = loadConfig("global");
  const p = loadConfig("project");
  return {
    ...g,
    ...p,
    local: { ...g.local, ...p.local },
    byok: { ...g.byok, ...p.byok },
    remote: { ...g.remote, ...p.remote },
    personas: { ...g.personas, ...p.personas },
    permissions: {
      allow: [...(g.permissions?.allow ?? []), ...(p.permissions?.allow ?? [])],
      deny: [...(g.permissions?.deny ?? []), ...(p.permissions?.deny ?? [])],
    },
  };
}

/**
 * Set one model field in the chosen config scope. Used by `personaxis model set`.
 * V5.P1.8: `personaSlug` targets a specific persona's override (`personas.<slug>`)
 * instead of the shared `local` section, so the main persona and every sub can run
 * different models per project or globally.
 */
export function setModelSetting(key: string, value: string, global = false, personaSlug?: string): void {
  const scope: ConfigScope = global ? "global" : "project";
  const field = key === "key-env" ? "apiKeyEnv" : key === "endpoint" ? "endpoint" : key === "model" ? "model" : key === "key" ? "apiKey" : undefined;
  if (!field) throw new Error(`unknown model setting "${key}" (use: endpoint | model | key-env | key)`);
  const config = loadConfig(scope);
  if (personaSlug) {
    const personas = (config.personas ?? {}) as Record<string, Record<string, string>>;
    personas[personaSlug] = { ...(personas[personaSlug] ?? {}), [field]: value };
    config.personas = personas as never;
  } else {
    config.local = { ...config.local, [field]: value };
  }
  saveConfig(config, scope);
}
