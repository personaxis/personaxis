/**
 * FR.9, credential resolution: env-first, OS secure storage as fallback.
 *
 * Precedence (first defined wins):
 *   1. the environment variable itself (fast path, no process spawn);
 *   2. OS secure storage, shell-out only (keytar is FORBIDDEN: archived,
 *      native addon, incompatible with bun-compile):
 *        darwin → `security find-generic-password` (Keychain)
 *        linux  → `secret-tool lookup` (libsecret, when installed)
 *        win32  → NOT read (no built-in CLI reads Credential Manager
 *                 secrets; `cmdkey` is write/list-only). Documented
 *                 assumption: Windows stays env-only until a DPAPI helper
 *                 ships with the signed binary distribution.
 *
 * Secrets are looked up under the service name `personaxis` with the env-var
 * name as account, so `personaxis credential set ANTHROPIC_API_KEY` and
 * `export ANTHROPIC_API_KEY=…` are interchangeable spellings of one thing.
 *
 * OAuth (PKCE, Codex login pattern) is reserved for the SaaS, not here.
 */

import { spawnSync } from "node:child_process";

const SERVICE = "personaxis";

function fromSecureStorage(name: string): string | undefined {
  if (process.platform === "darwin") {
    const r = spawnSync("security", ["find-generic-password", "-s", SERVICE, "-a", name, "-w"], {
      encoding: "utf-8",
      windowsHide: true,
    });
    if (r.status === 0 && r.stdout.trim()) return r.stdout.trim();
    return undefined;
  }
  if (process.platform === "linux") {
    const r = spawnSync("secret-tool", ["lookup", "service", SERVICE, "account", name], {
      encoding: "utf-8",
      windowsHide: true,
    });
    if (r.status === 0 && r.stdout.trim()) return r.stdout.trim();
    return undefined;
  }
  return undefined; // win32: env-only (see header)
}

/**
 * Resolve a credential by its env-var name. Returns undefined when neither
 * the environment nor the OS store has it, callers keep their own errors.
 */
export function resolveCredential(name: string): string | undefined {
  const env = process.env[name];
  if (env) return env;
  return fromSecureStorage(name);
}

/** Store a credential in the OS secure store. Throws where unsupported. */
export function storeCredential(name: string, value: string): void {
  if (process.platform === "darwin") {
    const r = spawnSync(
      "security",
      ["add-generic-password", "-U", "-s", SERVICE, "-a", name, "-w", value],
      { encoding: "utf-8", windowsHide: true },
    );
    if (r.status !== 0) throw new Error(`Keychain write failed (exit ${r.status})`);
    return;
  }
  if (process.platform === "linux") {
    const r = spawnSync(
      "secret-tool",
      ["store", `--label=${SERVICE}:${name}`, "service", SERVICE, "account", name],
      { encoding: "utf-8", input: value, windowsHide: true },
    );
    if (r.status !== 0) {
      throw new Error(
        r.error?.message.includes("ENOENT")
          ? "secret-tool not found, install libsecret-tools, or use an environment variable"
          : `secret-tool store failed (exit ${r.status})`,
      );
    }
    return;
  }
  throw new Error(
    "OS secure storage is not supported on this platform yet, set the environment variable " +
      `${name} instead (Windows support arrives with the signed binary distribution).`,
  );
}
