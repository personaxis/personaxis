/**
 * Structural self-awareness for a persona (F2).
 *
 * A persona must know, at runtime, WHERE it sits and WHAT it has: whether it is the
 * project ROOT or a SUB-persona, its own hierarchical address, the sub-personas it can
 * delegate to, and the supporting resources beside its spec. This is injected into the
 * agent's system prompt every turn, it is NOT baked into the compiled PERSONA.md (which
 * stays portable + purely qualitative).
 */

import { dirname } from "node:path";
import { isSubagentPath, slugAddressFromPath } from "../load.js";
import { buildResourceManifest } from "../resource-manifest.js";
import { discoverTree } from "./roster.js";

/** Build the `# Structure & resources` block for the persona at `personaPath`. */
export function buildAwarenessBlock(personaPath: string): string {
  const lines: string[] = ["# Structure & resources"];

  const address = slugAddressFromPath(personaPath);
  if (isSubagentPath(personaPath) && address) {
    lines.push(
      `You are a SUB-persona at address \`${address}\` (delegated under the project root). ` +
        "You are an independent persona with your own spec, state, memory and self-improvement ledger. " +
        "You may READ other personas' files but only WRITE within your own folder.",
    );
  } else {
    lines.push(
      "You are the ROOT persona of this project (the repo-wide agent). " +
        "Sub-personas are specialists you can delegate to; you may READ their files but never WRITE them.",
    );
  }

  // Sub-personas THIS persona can delegate to (works for root and for any sub).
  const subs = discoverTree(personaPath);
  if (subs.length) {
    lines.push(
      "",
      "## Sub-personas you can delegate to",
      "Address with @address (also @all, or @parent/all). You may READ their files but never edit them.",
      ...subs.map((s) => `${"  ".repeat(s.depth - 1)}- @${s.address}`),
    );
  } else {
    lines.push("", "## Sub-personas", "(none, you have no sub-personas)");
  }

  // Resource inventory beside this persona's spec (.personaxis/ or .../personas/<slug>/).
  const manifest = buildResourceManifest(dirname(personaPath));
  lines.push("", "## Your resources");
  lines.push(manifest.trim() ? manifest : "(no supporting resources yet)");

  return lines.join("\n");
}
