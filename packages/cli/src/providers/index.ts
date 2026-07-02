import { resolveModel } from "@personaxis/core";
import { loadMergedConfig } from "../config.js";
import type { Provider, ProviderName } from "./types.js";
import { createLocalProvider } from "./local.js";
import { createByokProvider } from "./byok.js";
import { createAgentProvider } from "./agent.js";
import { createRemoteProvider } from "./remote.js";

export * from "./types.js";

/**
 * Resolves the configured provider for compile/decompile/self-improvement.
 * Order: explicit `override`, then `provider` from the merged config (project over global), then a
 * SMART default: if a model resolves (env/config `local.endpoint`+`model`), use `local` — otherwise
 * `agent` (no network; hands the prompt to the active coding agent). This avoids the footgun where a
 * user configured a model but compile still tried the `agent` handoff because `provider` was unset.
 */
export function resolveProvider(override?: ProviderName): Provider {
  const config = loadMergedConfig();
  const smartDefault: ProviderName = resolveModel({ cwd: process.cwd() }) ? "local" : "agent";
  const name = override ?? config.provider ?? smartDefault;

  switch (name) {
    case "local":
      return createLocalProvider(config);
    case "byok":
      return createByokProvider(config);
    case "remote":
      return createRemoteProvider(config);
    case "agent":
    default:
      return createAgentProvider();
  }
}
