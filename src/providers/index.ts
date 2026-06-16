import { loadConfig } from "../config.js";
import type { Provider, ProviderName } from "./types.js";
import { createLocalProvider } from "./local.js";
import { createByokProvider } from "./byok.js";
import { createAgentProvider } from "./agent.js";
import { createRemoteProvider } from "./remote.js";

export * from "./types.js";

/**
 * Resolves the configured provider for compile/decompile/self-improvement.
 * Order: explicit `override`, then `.personaxis/config.json#/provider`,
 * then the "agent" default (no network call, works inside any coding agent
 * session without setup).
 */
export function resolveProvider(override?: ProviderName): Provider {
  const config = loadConfig();
  const name = override ?? config.provider ?? "agent";

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
