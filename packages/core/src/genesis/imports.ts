/**
 * Genesis import adapters, the ecosystem's folk formats become governed specs
 * (docs/architecture/genesis.md §2, `--from-import`).
 *
 * Character cards (V2/V3; JSON or PNG-embedded) are prose blobs with zero
 * governance, the adapters map their fields to evidence deterministically
 * (kind: imported-field), and the free prose flows to the LLM extractor when a
 * model is available. Numbers are NEVER copied from a card blindly; card text
 * only ever becomes evidence, and the builder's universals always win.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { EvidenceItem, PersonaSeed } from "./types.js";

export interface ImportedMaterial {
  /** Deterministically mapped seed fields. */
  seed: Partial<PersonaSeed>;
  evidence: EvidenceItem[];
  /** Free prose for the LLM extractor (empty when nothing beyond the fields). */
  prose: string;
  format: "card-v2" | "card-v3" | "system-prompt" | "agents-md" | "soul-md";
}

interface CardData {
  name?: string;
  description?: string;
  personality?: string;
  scenario?: string;
  first_mes?: string;
  mes_example?: string;
  creator_notes?: string;
  tags?: string[];
  system_prompt?: string;
}

// ── PNG tEXt extraction (no deps: walk chunks, find `chara`/`ccv3`) ──────────

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Extract the base64 card payload from a PNG's tEXt chunks. */
export function extractCardFromPng(buf: Buffer): { spec: "card-v2" | "card-v3"; json: unknown } | null {
  if (buf.length < 8 || !buf.subarray(0, 8).equals(PNG_MAGIC)) return null;
  let off = 8;
  const found: Record<string, string> = {};
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString("latin1", off + 4, off + 8);
    if (type === "tEXt") {
      const data = buf.subarray(off + 8, off + 8 + len);
      const nul = data.indexOf(0);
      if (nul > 0) {
        const keyword = data.toString("latin1", 0, nul);
        found[keyword] = data.toString("latin1", nul + 1);
      }
    }
    off += 12 + len; // length + type + data + CRC
    if (type === "IEND") break;
  }
  for (const [keyword, spec] of [["ccv3", "card-v3"], ["chara", "card-v2"]] as const) {
    if (found[keyword]) {
      try {
        return { spec, json: JSON.parse(Buffer.from(found[keyword], "base64").toString("utf-8")) };
      } catch {
        /* fall through to the other keyword */
      }
    }
  }
  return null;
}

function cardEvidence(field: string, value: string, paths: EvidenceItem["mappedFields"]): EvidenceItem {
  return {
    id: `card-${field}`,
    kind: "imported-field",
    source: "tool",
    excerpt: value.slice(0, 160),
    mappedFields: paths,
  };
}

function fromCardData(data: CardData, format: "card-v2" | "card-v3"): ImportedMaterial {
  const seed: Partial<PersonaSeed> = {};
  const evidence: EvidenceItem[] = [];
  if (data.name) {
    seed.displayName = data.name;
    seed.slug = data.name;
    evidence.push(cardEvidence("name", data.name, [{ path: "identity.display_name", value: data.name, rule: "card-field" }]));
  }
  if (data.description) {
    seed.description = data.description.slice(0, 300);
    seed.selfConcept = data.description.slice(0, 300);
    evidence.push(cardEvidence("description", data.description, [{ path: "identity.narrative_identity.self_concept", value: "(from card description)", rule: "card-field" }]));
  }
  if (data.scenario) {
    seed.origin = data.scenario.slice(0, 300);
    evidence.push(cardEvidence("scenario", data.scenario, [{ path: "identity.narrative_identity.origin", value: "(from card scenario)", rule: "card-field" }]));
  }
  if (data.first_mes) {
    seed.voiceExemplars = [{ context: "opening", persona: data.first_mes.slice(0, 400) }];
    evidence.push(cardEvidence("first_mes", data.first_mes, [{ path: "persona.voice_exemplars[0]", value: "(card first message)", rule: "card-field" }]));
  }
  // Free prose (personality + example dialogue + notes) → LLM extractor evidence.
  const prose = [
    data.personality ? `PERSONALITY: ${data.personality}` : "",
    data.mes_example ? `EXAMPLE DIALOGUE:\n${data.mes_example}` : "",
    data.creator_notes ? `CREATOR NOTES: ${data.creator_notes}` : "",
    data.system_prompt ? `SYSTEM PROMPT: ${data.system_prompt}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
  return { seed, evidence, prose, format };
}

/** Parse a character card file: .json, or .png with embedded chara/ccv3 chunk. */
export function importCharacterCard(path: string): ImportedMaterial {
  const buf = readFileSync(path);
  let payload: unknown;
  let format: "card-v2" | "card-v3" = "card-v2";
  if (path.toLowerCase().endsWith(".png")) {
    const extracted = extractCardFromPng(buf);
    if (!extracted) throw new Error(`${path}: no chara/ccv3 tEXt chunk found, not a character-card PNG.`);
    payload = extracted.json;
    format = extracted.spec;
  } else {
    payload = JSON.parse(buf.toString("utf-8"));
  }
  const o = payload as { spec?: string; data?: CardData } & CardData;
  if (o.spec === "chara_card_v3") format = "card-v3";
  else if (o.spec === "chara_card_v2") format = "card-v2";
  const data = o.data ?? o; // V2/V3 nest under data; V1 is flat
  return fromCardData(data, format);
}

// ── SOUL.md / SoulSpec (V3.3 embrace-extend) ─────────────────────────────────

/** Slice a markdown section body by any of the given heading names (## / ###). */
function mdSection(text: string, names: string[]): string | null {
  const pat = new RegExp(`^#{2,3}\\s+(?:${names.join("|")})\\b[^\\n]*\\n([\\s\\S]*?)(?=\\n#{1,3}\\s|(?![\\s\\S]))`, "im");
  const m = text.match(pat);
  return m ? m[1].trim() : null;
}

/** The bullet lines of a markdown block, markers stripped. */
function bullets(block: string): string[] {
  return block
    .split("\n")
    .map((l) => l.match(/^\s*[-*+]\s+(.*)$/)?.[1]?.trim())
    .filter((x): x is string => Boolean(x));
}

/**
 * SOUL.md / SoulSpec import (V3.3, the embrace-extend wedge): the ecosystem's
 * soft persona file becomes evidence for a governed spec. Deterministic mapping:
 * the name (from a sibling `soul.json`, `IDENTITY.md`, or the first heading),
 * an identity section into the self-concept, and boundary/never bullets into
 * prohibited-behavior evidence (text, never numbers; the builder's universals
 * always win). ALL prose still flows to the LLM extractor. Accepts a lone
 * SOUL.md or a SoulSpec package directory's SOUL.md with siblings present.
 */
export function importSoulMd(path: string): ImportedMaterial {
  const text = readFileSync(path, "utf-8");
  const dir = dirname(path);
  const seed: Partial<PersonaSeed> = {};
  const evidence: EvidenceItem[] = [];
  const proseParts: string[] = [text];

  // Name precedence: soul.json (SoulSpec metadata) > IDENTITY.md > first heading.
  let name: string | undefined;
  const jsonPath = join(dir, "soul.json");
  if (existsSync(jsonPath)) {
    try {
      const meta = JSON.parse(readFileSync(jsonPath, "utf-8")) as { name?: string; description?: string };
      if (typeof meta.name === "string" && meta.name.trim()) name = meta.name.trim();
      if (typeof meta.description === "string" && meta.description.trim()) seed.description = meta.description.slice(0, 300);
    } catch {
      /* malformed metadata never blocks the import; SOUL.md is the source */
    }
  }
  const identityPath = join(dir, "IDENTITY.md");
  if (existsSync(identityPath)) {
    const idText = readFileSync(identityPath, "utf-8");
    proseParts.push(`IDENTITY.md:\n${idText}`);
    name ??= idText.match(/^\s*(?:\*\*)?Name(?:\*\*)?\s*[:=]\s*(.+)$/im)?.[1]?.trim();
  }
  name ??= text.match(/^#\s+(?:You are\s+)?([^\n#]{1,40}?)\s*$/m)?.[1]?.replace(/^SOUL$/i, "")?.trim() || undefined;
  if (name) {
    seed.displayName = name;
    seed.slug = name;
    evidence.push({
      id: "soul-name",
      kind: "imported-field",
      source: "tool",
      excerpt: name,
      mappedFields: [{ path: "identity.display_name", value: name, rule: "soul-name" }],
    });
  }

  // Identity / core-identity section → self-concept (first paragraph).
  const identity = mdSection(text, ["core identity", "identity", "who you are", "self"]);
  if (identity) {
    const para = identity.split(/\n\s*\n/)[0]?.trim();
    if (para) {
      seed.selfConcept = para.slice(0, 300);
      evidence.push({
        id: "soul-identity",
        kind: "imported-field",
        source: "tool",
        excerpt: para.slice(0, 160),
        mappedFields: [{ path: "identity.narrative_identity.self_concept", value: "(from SOUL.md identity section)", rule: "soul-section" }],
      });
    }
  }

  // Boundaries / never / limits / rules bullets → prohibited-behavior evidence.
  // Text only: SOUL.md's soft constraints become the governed refusal surface's
  // INPUT, which is exactly the gap its own ecosystem documents (no enforcement).
  const bounds = mdSection(text, ["boundaries", "hard limits", "limits", "never", "rules"]);
  const dont = bounds ? bullets(bounds) : [];
  if (dont.length) {
    seed.prohibitedBehaviors = dont.map((b) => b.slice(0, 160));
    evidence.push({
      id: "soul-boundaries",
      kind: "imported-field",
      source: "tool",
      excerpt: dont.slice(0, 3).join(" · ").slice(0, 160),
      mappedFields: [{ path: "self_regulation.prohibited_behaviors", value: `(${dont.length} boundary bullet(s))`, rule: "soul-boundaries" }],
    });
  }

  return { seed, evidence, prose: proseParts.join("\n\n"), format: "soul-md" };
}

/** True when a path names a SOUL.md file (or a SoulSpec package directory). */
export function isSoulImport(path: string): boolean {
  return /(^|[\\/])SOUL\.md$/i.test(path) || existsSync(join(path, "SOUL.md"));
}

/** A bare system prompt / CLAUDE.md / AGENTS.md: everything is extractor prose. */
export function importPrompt(path: string): ImportedMaterial {
  const text = readFileSync(path, "utf-8");
  const isAgents = /CLAUDE\.md$|AGENTS\.md$/i.test(path);
  // Cheap deterministic signal: a first-heading name ("# You are X" / "# X").
  const seed: Partial<PersonaSeed> = {};
  const evidence: EvidenceItem[] = [];
  const m = text.match(/^#\s+(?:You are\s+)?([A-Z][\w-]{1,30})/m);
  if (m) {
    seed.displayName = m[1];
    seed.slug = m[1];
    evidence.push({
      id: "prompt-heading",
      kind: "imported-field",
      source: "tool",
      excerpt: m[0],
      mappedFields: [{ path: "identity.display_name", value: m[1], rule: "first-heading" }],
    });
  }
  return { seed, evidence, prose: text, format: isAgents ? "agents-md" : "system-prompt" };
}
