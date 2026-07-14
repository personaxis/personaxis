import { resolveModel, slugFromPersonaPath } from "@personaxis/core";
import { loadMergedConfig, type PersonaxisConfig, type ModelProfile } from "../config.js";
import type { Provider, ProviderName } from "./types.js";
import { createLocalProvider } from "./local.js";
import { createByokProvider } from "./byok.js";
import { createAgentProvider } from "./agent.js";
import { createRemoteProvider } from "./remote.js";

export * from "./types.js";

/** The profile a scope resolves to: the persona's assigned profile, else the default profile. */
function activeProfile(config: PersonaxisConfig, personaPath?: string): ModelProfile | undefined {
  const slug = slugFromPersonaPath(personaPath);
  const ref = (slug ? config.personas?.[slug]?.profile : undefined) ?? config.defaultProfile;
  return ref ? config.profiles?.[ref] : undefined;
}

/** Project a profile onto the legacy config sections so the existing provider factories build from it. */
function withProfile(config: PersonaxisConfig, p: ModelProfile): PersonaxisConfig {
  const provider = p.provider ?? "local";
  if (provider === "local") return { ...config, provider, local: { ...config.local, endpoint: p.endpoint, model: p.model, apiKey: p.apiKey, apiKeyEnv: p.apiKeyEnv } };
  if (provider === "byok") return { ...config, provider, byok: { ...config.byok, apiProvider: p.apiProvider, model: p.model } };
  if (provider === "remote") return { ...config, provider, remote: { ...config.remote, apiBase: p.apiBase, model: p.model } };
  return { ...config, provider }; // agent
}

/**
 * Resolves the configured provider for compile/decompile/self-improvement.
 * Order: explicit `override`, then the active profile's `provider` (per-persona assignment, else the
 * default profile), then top-level `provider`, then a SMART default: if a model resolves (env/config
 * `local.endpoint`+`model`), use `local`, otherwise `agent` (no network; hands the prompt to the
 * active coding agent). This avoids the footgun where a model is configured but compile still tries
 * the `agent` handoff because `provider` was unset. A config with no profiles behaves as before.
 */
export function resolveProvider(override?: ProviderName, opts: { personaPath?: string } = {}): Provider {
  const base = loadMergedConfig();
  const profile = activeProfile(base, opts.personaPath);
  const config = profile ? withProfile(base, profile) : base;
  const smartDefault: ProviderName = resolveModel({ cwd: process.cwd(), personaPath: opts.personaPath }) ? "local" : "agent";
  const name = override ?? config.provider ?? smartDefault;

  switch (name) {
    case "local":
      return createLocalProvider(config, opts.personaPath);
    case "byok":
      return createByokProvider(config);
    case "remote":
      return createRemoteProvider(config);
    case "agent":
    default:
      return createAgentProvider();
  }
}
