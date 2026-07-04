/**
 * FR.9 — update notification: zero-dependency npm registry check.
 *
 * Explicit deviation from the TECH_STACK decision to use `update-notifier`:
 * after the 2026 npm supply-chain hardening (pnpm minimumReleaseAge etc.) a
 * single dist-tag fetch does not justify its transitive dependency tree. Same
 * contract, ~60 lines, no deps. Recorded in IMPLEMENTATION_CHECKLIST.md.
 *
 * Behavior: at most one registry hit per CHECK_INTERVAL, cached under
 * ~/.personaxis/update-check.json; the check is fire-and-forget (never blocks
 * or fails a command); the caller prints the hint when an update exists.
 *
 * The binary self-updater (GitHub Releases, atomic replace + .old rollback —
 * Claude Code pattern) and Windows code-signing are release-infrastructure:
 * they ship with the bun-compile binary distribution (FR.V/release), not here.
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000; // daily

interface UpdateCache {
  lastCheck: number;
  latest?: string;
}

function cachePath(): string {
  return join(homedir(), ".personaxis", "update-check.json");
}

function readCache(): UpdateCache {
  try {
    return JSON.parse(readFileSync(cachePath(), "utf-8")) as UpdateCache;
  } catch {
    return { lastCheck: 0 };
  }
}

/** semver-ish "is b newer than a" without a semver dep (major.minor.patch). */
export function isNewer(current: string, candidate: string): boolean {
  const pa = current.split(".").map((n) => parseInt(n, 10) || 0);
  const pb = candidate.split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    if ((pb[i] ?? 0) > (pa[i] ?? 0)) return true;
    if ((pb[i] ?? 0) < (pa[i] ?? 0)) return false;
  }
  return false;
}

/**
 * Returns the newer version string when one is known (from cache or a fresh
 * check), undefined otherwise. Never throws; never blocks longer than the
 * fetch timeout; disabled by PERSONAXIS_NO_UPDATE_CHECK=1 and in CI.
 */
export async function checkForUpdate(pkgName: string, currentVersion: string): Promise<string | undefined> {
  if (process.env.PERSONAXIS_NO_UPDATE_CHECK === "1" || process.env.CI) return undefined;
  const cache = readCache();
  const fresh = Date.now() - cache.lastCheck < CHECK_INTERVAL_MS;
  if (fresh) {
    return cache.latest && isNewer(currentVersion, cache.latest) ? cache.latest : undefined;
  }
  try {
    const res = await fetch(`https://registry.npmjs.org/-/package/${pkgName}/dist-tags`, {
      signal: AbortSignal.timeout(3_000),
    });
    if (!res.ok) return undefined;
    const tags = (await res.json()) as { latest?: string };
    const next: UpdateCache = { lastCheck: Date.now(), latest: tags.latest };
    mkdirSync(join(homedir(), ".personaxis"), { recursive: true });
    writeFileSync(cachePath(), JSON.stringify(next) + "\n", "utf-8");
    return tags.latest && isNewer(currentVersion, tags.latest) ? tags.latest : undefined;
  } catch {
    return undefined; // network problems must never surface in a CLI command
  }
}
