/**
 * Model resolution (Fase 2), one config logic for dev AND prod, so nobody has to export env
 * vars before every launch.
 *
 * A model can be configured in layers; higher layers override lower ones:
 *
 *   global.default          ~/.personaxis/config.json           (defaultProfile + local; PERSONAXIS_HOME aware)
 *   project.default         <cwd>/.personaxis/config.json        (this project's defaultProfile + local)
 *   global.personas[slug]   ~/.personaxis/config.json            (per-persona: a profile ref and/or inline)
 *   project.personas[slug]  <cwd>/.personaxis/config.json        (per-persona, this project)
 *   frontmatter.runtime     the persona's own personaxis.md      (the persona declares its model)
 *   ENV                     PERSONAXIS_ENDPOINT/MODEL/API_KEY     (top override, dev & prod secrets)
 *
 * `profiles` is a named library of reusable settings (endpoint/model/key); `defaultProfile` and a
 * persona's `profile` field reference it by name. A profile edited once updates every reference.
 * Project profiles override global profiles of the same name. A config with only `local` (no
 * profiles) resolves exactly as before, so this layer is additive.
 *
 * SECRETS: the API key is NEVER required to live in a file. Preferred: name the env var holding it
 * with `apiKeyEnv` (e.g. "COHERE_API_KEY"); resolveModel reads that env var. Fallbacks: the
 * PERSONAXIS_API_KEY env var, then an inline `apiKey` (dev convenience, the config file must be
 * gitignored). In production the key comes from the deploy's secret manager via the env var.
 *
 * Dependency-free (node:fs/os/path), so core stays framework-agnostic and every surface
 * (REPL, MCP, serve, SDK) shares the exact same resolution.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { personaxisHome } from "./registry.js";

export interface ModelSettings {
  endpoint?: string;
  model?: string;
  /** Inline key (dev convenience; the file MUST be gitignored). Prefer `apiKeyEnv`. */
  apiKey?: string;
  /** Name of the env var that holds the key (preferred, the key never touches a file). */
  apiKeyEnv?: string;
}

/** Per-persona settings: an optional reference to a named `profile` plus inline overrides. */
export interface PersonaSettings extends ModelSettings {
  /** Name of a profile in `profiles`; its fields are the base, the inline fields above override it. */
  profile?: string;
}

/** The slice of `config.json` this module reads. Other keys (provider/byok/remote) are ignored here. */
export interface ModelConfigFile {
  local?: ModelSettings;
  /** A named library of reusable model settings (endpoints/models/keys). */
  profiles?: Record<string, ModelSettings>;
  /** Name of the profile this scope uses as its default (an inline `local` still overrides it). */
  defaultProfile?: string;
  /** Per-persona overrides, keyed by slug: a `profile` reference and/or inline fields. */
  personas?: Record<string, PersonaSettings>;
}

export interface ResolvedModel {
  endpoint: string;
  model: string;
  apiKey?: string;
}

export function globalConfigPath(): string {
  return join(personaxisHome(), "config.json");
}

export function projectConfigPath(cwd: string = process.cwd()): string {
  return join(cwd, ".personaxis", "config.json");
}

function readConfig(path: string): ModelConfigFile {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as ModelConfigFile;
  } catch {
    return {};
  }
}

/** Extract a persona slug from a `.personaxis/personas/<slug>/…` path (last segment wins). */
export function slugFromPersonaPath(personaPath?: string): string | undefined {
  if (!personaPath) return undefined;
  const matches = [...personaPath.matchAll(/[\\/]personas[\\/]([^\\/]+)/g)];
  return matches.length ? matches[matches.length - 1][1] : undefined;
}

function envSettings(): ModelSettings {
  return {
    ...(process.env.PERSONAXIS_ENDPOINT ? { endpoint: process.env.PERSONAXIS_ENDPOINT } : {}),
    ...(process.env.PERSONAXIS_MODEL ? { model: process.env.PERSONAXIS_MODEL } : {}),
    ...(process.env.PERSONAXIS_API_KEY ? { apiKey: process.env.PERSONAXIS_API_KEY } : {}),
  };
}

/** Merge a list of settings low→high precedence (later wins), dropping undefined fields. */
function mergeSettings(layers: Array<ModelSettings | undefined>): ModelSettings {
  const out: ModelSettings = {};
  for (const layer of layers) {
    if (!layer) continue;
    if (layer.endpoint) out.endpoint = layer.endpoint;
    if (layer.model) out.model = layer.model;
    if (layer.apiKey) out.apiKey = layer.apiKey;
    if (layer.apiKeyEnv) out.apiKeyEnv = layer.apiKeyEnv;
  }
  return out;
}

export interface ResolveModelOptions {
  /** Path to the persona (used for slug-based per-persona overrides). */
  personaPath?: string;
  /** Project root holding `.personaxis/config.json` (defaults to process.cwd()). */
  cwd?: string;
  /** The persona's frontmatter, its `runtime` block is a per-persona override. */
  frontmatter?: Record<string, unknown>;
}

/**
 * Resolve the effective model for a persona. Returns undefined (→ heuristic/offline) unless BOTH an
 * endpoint and a model are configured. The API key is resolved from the env var named by
 * `apiKeyEnv`, else PERSONAXIS_API_KEY, else an inline `apiKey`, in that order.
 */
export function resolveModel(opts: ResolveModelOptions = {}): ResolvedModel | undefined {
  const cwd = opts.cwd ?? process.cwd();
  const global = readConfig(globalConfigPath());
  const project = readConfig(projectConfigPath(cwd));
  const slug = slugFromPersonaPath(opts.personaPath);
  const runtime = opts.frontmatter?.runtime as ModelSettings | undefined;

  // The profile library is shared across scopes; a project profile overrides a global one by name.
  const profiles = { ...global.profiles, ...project.profiles };
  const byName = (name?: string): ModelSettings | undefined => (name ? profiles[name] : undefined);

  // A scope's default = its named default profile as the base, with an explicit `local` on top.
  const defaultLayer = (cfg: ModelConfigFile): ModelSettings => mergeSettings([byName(cfg.defaultProfile), cfg.local]);
  // A persona layer = its referenced profile as the base, with the persona's inline fields on top.
  const personaLayer = (cfg: ModelConfigFile): ModelSettings | undefined => {
    const p = slug ? cfg.personas?.[slug] : undefined;
    return p ? mergeSettings([byName(p.profile), p]) : undefined;
  };

  const merged = mergeSettings([
    defaultLayer(global),
    defaultLayer(project),
    personaLayer(global),
    personaLayer(project),
    runtime,
    envSettings(),
  ]);

  if (!merged.endpoint || !merged.model) return undefined;

  const apiKey =
    (merged.apiKeyEnv ? process.env[merged.apiKeyEnv] : undefined) ??
    process.env.PERSONAXIS_API_KEY ??
    merged.apiKey;

  return { endpoint: merged.endpoint, model: merged.model, ...(apiKey ? { apiKey } : {}) };
}

/** A human-readable description of the resolved model (for `/model` and labels). */
export function describeModel(opts: ResolveModelOptions = {}): string {
  const m = resolveModel(opts);
  return m ? `${m.model} @ ${m.endpoint}${m.apiKey ? " (key set)" : " (no key)"}` : "heuristic (offline, configure a model)";
}
