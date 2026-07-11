import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "fs";
import { dirname, resolve } from "path";
import { globalConfigPath as coreGlobalConfigPath, projectConfigPath as coreProjectConfigPath } from "@personaxis/core";
import type { ProviderName } from "./providers/types.js";

/** "project" → <cwd>/.personaxis/config.json · "global" → ~/.personaxis/config.json (PERSONAXIS_HOME). */
export type ConfigScope = "project" | "global";

export interface PersonaxisConfig {
  /** Default provider for compile/decompile. Defaults to "agent" if unset. */
  provider?: ProviderName;
  local?: {
    /** OpenAI-compatible chat-completions endpoint, e.g. http://localhost:11434/v1 */
    endpoint?: string;
    model?: string;
    /** Optional bearer token for an authenticated endpoint (dev only, the file must be gitignored). */
    apiKey?: string;
    /** Name of the env var holding the key (preferred, the key never touches a file). */
    apiKeyEnv?: string;
  };
  /** Per-persona model overrides, keyed by slug. */
  personas?: Record<string, { endpoint?: string; model?: string; apiKey?: string; apiKeyEnv?: string }>;
  byok?: {
    /** Which API the key in ANTHROPIC_API_KEY / OPENAI_API_KEY belongs to. */
    apiProvider?: "anthropic" | "openai";
    model?: string;
  };
  remote?: {
    apiBase?: string;
    model?: string;
  };
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
  };
}

/** Set one model field in the `local` section of the chosen config scope. Used by `/model set`. */
export function setModelSetting(key: string, value: string, global = false): void {
  const scope: ConfigScope = global ? "global" : "project";
  const field = key === "key-env" ? "apiKeyEnv" : key === "endpoint" ? "endpoint" : key === "model" ? "model" : key === "key" ? "apiKey" : undefined;
  if (!field) throw new Error(`unknown model setting "${key}" (use: endpoint | model | key-env | key)`);
  const config = loadConfig(scope);
  config.local = { ...config.local, [field]: value };
  saveConfig(config, scope);
}
