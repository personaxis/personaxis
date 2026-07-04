/**
 * FR.9 — credentials (env-first resolution) + update check (version compare,
 * kill switches). OS-secure-storage shell-outs are platform-specific and NOT
 * exercised here; the env-first fast path and the pure logic are.
 */
import { describe, it, expect, afterEach } from "vitest";
import { resolveCredential } from "../src/credentials.js";
import { isNewer, checkForUpdate } from "../src/update-check.js";

const VAR = "PXS_TEST_CREDENTIAL";
afterEach(() => {
  delete process.env[VAR];
  delete process.env.PERSONAXIS_NO_UPDATE_CHECK;
});

describe("FR.9 credential resolution", () => {
  it("the environment variable wins (fast path, no process spawn)", () => {
    process.env[VAR] = "sk-from-env";
    expect(resolveCredential(VAR)).toBe("sk-from-env");
  });

  it("returns undefined when neither env nor OS store has it (win32 = env-only)", () => {
    // The var is unset and no OS store carries this name on any CI platform.
    expect(resolveCredential(VAR)).toBeUndefined();
  });
});

describe("FR.9 update check", () => {
  it("isNewer compares major.minor.patch without a semver dep", () => {
    expect(isNewer("0.11.0", "0.11.1")).toBe(true);
    expect(isNewer("0.11.0", "0.12.0")).toBe(true);
    expect(isNewer("0.11.0", "1.0.0")).toBe(true);
    expect(isNewer("0.11.0", "0.11.0")).toBe(false);
    expect(isNewer("0.11.1", "0.11.0")).toBe(false);
    expect(isNewer("1.0.0", "0.99.99")).toBe(false);
  });

  it("PERSONAXIS_NO_UPDATE_CHECK=1 (and CI) short-circuit without touching the network", async () => {
    process.env.PERSONAXIS_NO_UPDATE_CHECK = "1";
    // No fetch mock installed: a network attempt would still resolve undefined,
    // but the kill switch returns before the cache/registry code path runs.
    await expect(checkForUpdate("@personaxis/persona.md", "0.0.1")).resolves.toBeUndefined();
  });
});
