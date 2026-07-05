/**
 * Placement adapter — thin CLI shim over the core target registry (F3.2).
 *
 * The pure placement logic (paths + content per host, SOUL.md, TOML) now lives
 * in `@personaxis/core` (`compile/targets.ts`) so the SaaS can place documents
 * server-side too. This module keeps the CLI's existing `placeCompiledDocument`
 * signature (which takes a `CompileTargetInfo`) by delegating to `placeForTarget`.
 */
import { placeForTarget, isSoulTarget, BUILTIN_TARGETS } from "@personaxis/core";
import type { PlacementResult } from "@personaxis/core";
import type { CompileTargetInfo } from "../compile-instructions.js";

export const PLACEMENT_PLATFORMS = BUILTIN_TARGETS;
export type PlacementPlatform = (typeof PLACEMENT_PLATFORMS)[number];
export type { PlacementResult };

export function placeCompiledDocument(
  compiledText: string,
  target: CompileTargetInfo,
  platform: PlacementPlatform,
): PlacementResult {
  return placeForTarget(compiledText, platform, {
    isSubagent: target.isSubagent,
    slug: target.slug,
    rootOutputPath: target.outputPath,
  });
}

/** Hosts that read SOUL.md at the workspace/profile root (no @PERSONA.md baseline injection). */
export function isSoulPlatform(platform: PlacementPlatform | undefined): boolean {
  return isSoulTarget(platform);
}
