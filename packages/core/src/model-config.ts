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
  /** V5.FIX.2: set when resolution fell back to a usable profile (its name). */
  profile?: string;
  /** V5.FIX.2: true when the configured default was NOT usable and a fallback was taken. */
  fallback?: boolean;
}

/** A local inference server (Ollama, LM Studio, llama.cpp, vLLM on this machine) needs no key. */
export function isLocalEndpoint(endpoint: string): boolean {
  return /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\]|::1|0\.0\.0\.0)([:/]|$)/i.test(endpoint);
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

  const keyFor = (s: ModelSettings): string | undefined =>
    (s.apiKeyEnv ? process.env[s.apiKeyEnv] : undefined) ?? process.env.PERSONAXIS_API_KEY ?? s.apiKey;

  const direct =
    merged.endpoint && merged.model
      ? { endpoint: merged.endpoint, model: merged.model, apiKey: keyFor(merged) }
      : undefined;

  // Usable = it can actually answer: a key resolves, or the endpoint is local (no key needed).
  if (direct && (direct.apiKey || isLocalEndpoint(direct.endpoint))) {
    return { endpoint: direct.endpoint, model: direct.model, ...(direct.apiKey ? { apiKey: direct.apiKey } : {}) };
  }

  // V5.FIX.2 fallback: when the configured default is broken (points at a keyless
  // remote profile, or nothing is configured at all), fall back to the default
  // profile if usable, else the FIRST usable profile, before giving up. Explicit
  // env/runtime overrides are respected verbatim (no silent switching when the
  // user forced an endpoint/model): in that case the direct result stands so the
  // real error surfaces truthfully.
  const env = envSettings();
  // Forced = the user explicitly pointed THIS resolution somewhere: env vars, the
  // spec's runtime block, or a per-persona assignment. Those are respected
  // verbatim (their errors must surface); only a broken DEFAULT layer falls back.
  const forced = Boolean(
    env.endpoint || env.model || runtime?.endpoint || runtime?.model || personaLayer(global) || personaLayer(project),
  );
  if (!forced) {
    const ordered = [
      ...new Set(
        [project.defaultProfile, global.defaultProfile, ...Object.keys(profiles)].filter(
          (n): n is string => Boolean(n),
        ),
      ),
    ];
    // Two passes: a profile whose KEY actually resolves beats a local-no-key one
    // (a local server may simply not be running; a key is a stronger guarantee).
    for (const requireKey of [true, false]) {
      for (const name of ordered) {
        const s = profiles[name];
        if (!s?.endpoint || !s.model) continue;
        const k = keyFor(s);
        const usable = requireKey ? Boolean(k) : Boolean(k) || isLocalEndpoint(s.endpoint);
        if (!usable) continue;
        return {
          endpoint: s.endpoint,
          model: s.model,
          ...(k ? { apiKey: k } : {}),
          profile: name,
          ...(direct ? { fallback: true } : {}),
        };
      }
    }
  }

  // Nothing usable: return the direct resolution as-is (so callers can show an
  // actionable "this profile has no key" error) or undefined (offline).
  return direct ? { endpoint: direct.endpoint, model: direct.model } : undefined;
}

/** A human-readable description of the resolved model (for `/model` and labels). */
export function describeModel(opts: ResolveModelOptions = {}): string {
  const m = resolveModel(opts);
  if (!m) return "heuristic (offline, configure a model)";
  const via = m.fallback ? ` (fallback → profile "${m.profile}": the configured default has no usable key)` : m.profile ? ` (profile "${m.profile}")` : "";
  return `${m.model} @ ${m.endpoint}${m.apiKey ? " (key set)" : isLocalEndpoint(m.endpoint) ? " (local, no key needed)" : " (no key)"}${via}`;
}
