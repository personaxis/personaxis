/**
 * `personaxis card` (V2-F4.3c), a shareable persona card: the deterministic sigil
 * glyph plus verifiable stats (name, role, spec, sigil seed, mutation count,
 * content hash). The viral/trust artifact. Text now; an SVG export is a follow-up.
 */

import { Command } from "commander";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import chalk from "chalk";
import { sigilParams, renderSigil, readState, type PersonaFrontmatter } from "@personaxis/core";
import { loadPersonaFile } from "../load.js";

export interface CardData {
  name: string;
  role?: string;
  specVersion?: string;
  sigilSeed: string;
  glyph: string[];
  mutations: number;
  contentSha256: string;
}

export function buildCard(data: Record<string, unknown>, raw: string, personaPath: string): CardData {
  const id = (data.identity ?? {}) as { display_name?: string; canonical_id?: string; role_identity?: { primary_role?: string } };
  const params = sigilParams(data as unknown as PersonaFrontmatter);
  const statePath = join(dirname(personaPath), "state.json");
  let mutations = 0;
  try {
    if (existsSync(statePath)) mutations = readState(statePath).mutation_log.length;
  } catch {
    /* no state yet */
  }
  return {
    name: id.display_name ?? id.canonical_id ?? "persona",
    role: id.role_identity?.primary_role,
    specVersion: data.spec_version as string | undefined,
    sigilSeed: (params.seed >>> 0).toString(16).padStart(8, "0"),
    glyph: renderSigil(params).grid,
    mutations,
    contentSha256: createHash("sha256").update(raw).digest("hex"),
  };
}

export function renderCardText(card: CardData): string {
  const lines = [
    `╭─ ${card.name}${card.role ? ` · ${card.role}` : ""} ─`,
    ...card.glyph.map((g) => `│  ${g}`),
    `│  spec ${card.specVersion ?? "?"} · sigil ${card.sigilSeed} · ${card.mutations} mutations`,
    `│  sha256 ${card.contentSha256.slice(0, 16)}…`,
    `╰─ personaxis`,
  ];
  return lines.join("\n");
}

export const cardCommand = new Command("card")
  .description("print a shareable persona card (sigil + verifiable stats)")
  .option("--persona <path>", "path to personaxis.md (default: resolve from cwd)")
  .option("--json", "output the card data as JSON")
  .action((opts: { persona?: string; json?: boolean }) => {
    const { data, raw, path } = loadPersonaFile(opts.persona);
    const card = buildCard(data as Record<string, unknown>, raw, path);
    if (opts.json) {
      console.log(JSON.stringify(card, null, 2));
      return;
    }
    console.log(chalk.ansi256(sigilParams(data as unknown as PersonaFrontmatter).color)(renderCardText(card)));
  });
