/**
 * F3.1 — the DETERMINISTIC compile assembler (stage 1 of the two-stage pipeline).
 *
 * This is the canonical, LLM-free path from a parsed persona spec to the
 * compiled PERSONA-prompting document. It ALWAYS runs; it is:
 *   - what gets hashed (stable provenance — same spec ⇒ same bytes);
 *   - what the Living Loop writes on an inline recompile (cheap, no provider);
 *   - the fallback when no model provider is configured;
 *   - the ground-truth artifact the faithfulness check diffs a polished
 *     document against (see faithfulness.ts).
 *
 * It follows the section contract of PERSONA_template.md and writes the whole
 * document in the SECOND PERSON. It NEVER emits runtime numbers (trait/affect
 * tables, sigil seeds, a live-state block) — state lives in state.json.
 *
 * Field sourcing prefers the v1.0 layer-10 `persona` prompting fields (address,
 * voice_exemplars, scene_contracts, behavioral_anchors, consistency) and
 * degrades to the legacy top-level `persona_prompting` block, then to deriving
 * the section from the quantitative layers. It invents nothing.
 */

import { extractEnvelopes } from "../envelopes.js";
import type { PersonaFrontmatter } from "../persona.js";
import { bandOf, expressionFor } from "../math/bands.js";

type Dict = Record<string, unknown>;

const asDict = (v: unknown): Dict => (v && typeof v === "object" && !Array.isArray(v) ? (v as Dict) : {});
const asArr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const asStr = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);

export interface AssembleTarget {
  /** The name the document addresses ("You are <name>"). */
  name: string;
  isSubagent: boolean;
  slug?: string;
  /** Resource path prefix: "./" for a sub-persona, "./.personaxis/" for the root. */
  resourceBase: string;
}

export interface AssembleInput {
  /** Parsed persona frontmatter (v1.0 or legacy 0.x). */
  persona: Dict;
  /** The resource-manifest bullet list, reproduced verbatim. */
  resourceManifest?: string;
  target: AssembleTarget;
  /** Applied governed self-edits (dot-path → value); authoritative over the spec. */
  appliedOverlay?: Record<string, unknown>;
  /** Current state.json values (F6.2): selects WHICH band's `expression` prose is
   *  injected per coordinate (Def. 6 / ADR-004). Absent → each envelope's mean. */
  stateValues?: Record<string, number>;
}

/** Read the persona-prompting source, preferring v1.0 layer-10 over legacy. */
function promptingSource(persona: Dict): Dict {
  const persona10 = asDict(persona.persona);
  const legacy = asDict(persona.persona_prompting);
  // A field present in either wins; v1.0 layer-10 takes precedence per-field.
  return {
    address: persona10.address ?? legacy.address,
    voice_exemplars: persona10.voice_exemplars ?? legacy.voice_exemplars,
    scene_contracts: persona10.scene_contracts ?? legacy.scene_contracts,
    behavioral_anchors: persona10.behavioral_anchors ?? legacy.behavioral_anchors,
    consistency: persona10.consistency ?? legacy.consistency,
  };
}

function sectionOpener(persona: Dict, target: AssembleTarget): string {
  const addr = asDict(promptingSource(persona).address);
  const youAre = asStr(addr.you_are);
  const lines: string[] = [`# You are ${target.name}`];
  lines.push("");
  if (youAre) {
    lines.push(youAre);
  } else {
    // Derive from identity: role + purpose.
    const identity = asDict(persona.identity);
    const role = asDict(identity.role_identity);
    const sys = asDict(identity.system_identity);
    const roleName = asStr(role.primary_role)?.replace(/_/g, " ");
    const purpose = asStr(sys.purpose);
    const bits = [`You are **${target.name}**`, roleName ? `, the ${roleName}` : ""].join("");
    lines.push(purpose ? `${bits}. ${purpose}` : `${bits}.`);
  }
  lines.push(
    "You think, speak, and decide as this persona. Stay in character at all times — the rules " +
      "below are who you are, not instructions you are following.",
  );
  return lines.join("\n");
}

function sectionWhoYouAre(persona: Dict): string {
  const identity = asDict(persona.identity);
  const sys = asDict(identity.system_identity);
  const narrative = asDict(identity.narrative_identity);
  const out: string[] = ["## Who you are", ""];
  const purpose = asStr(sys.purpose);
  const selfConcept = asStr(narrative.self_concept);
  const origin = asStr(narrative.origin);
  if (purpose) out.push(purpose);
  if (selfConcept) out.push("", selfConcept);
  if (origin) out.push("", origin);
  const allowed = asArr(sys.allowed_domains).map(asStr).filter(Boolean) as string[];
  const prohibited = asArr(sys.prohibited_domains).map(asStr).filter(Boolean) as string[];
  if (allowed.length) out.push("", `You work on: ${allowed.map((d) => d.replace(/_/g, " ")).join(", ")}.`);
  if (prohibited.length) out.push(`You do NOT work on: ${prohibited.map((d) => d.replace(/_/g, " ")).join(", ")}.`);
  if (out.length === 2) out.push("*(identity not specified in the spec)*");
  return out.join("\n");
}

function sectionHowYouSpeak(persona: Dict): string {
  const voice = asDict(asDict(persona.persona).voice);
  const out: string[] = ["## How you speak", ""];
  const tone = asStr(voice.tone)?.replace(/_/g, " ");
  const desc = asStr(voice.description);
  const humor = asStr(voice.humor);
  const verbosity = asStr(voice.verbosity);
  const parts: string[] = [];
  if (tone) parts.push(`Your tone is ${tone}.`);
  if (verbosity) parts.push(`You are ${verbosity} by default.`);
  if (humor) parts.push(`Humor: ${humor}.`);
  if (desc) parts.push(desc);
  out.push(parts.length ? parts.join(" ") : "*(voice not specified in the spec)*");

  const exemplars = asArr(promptingSource(persona).voice_exemplars);
  if (exemplars.length) {
    out.push("", "**You sound like this:**");
    for (const ex of exemplars) {
      const e = asDict(ex);
      const ctx = asStr(e.context);
      const user = asStr(e.user);
      const resp = asStr(e.persona);
      if (!resp) continue;
      const lead = ctx ? `When ${ctx}` : user ? `Asked "${user}"` : "You";
      out.push(`- ${lead}, you say: "${resp}"`);
    }
  }
  return out.join("\n");
}

function sectionAlwaysNever(persona: Dict): string {
  const out: string[] = ["## What you always / never do", ""];
  const character = asDict(persona.character);
  const anchors = asDict(promptingSource(persona).behavioral_anchors);

  const always: string[] = [];
  const never: string[] = [];

  // behavioral_anchors do/dont (verbatim when present).
  for (const d of asArr(anchors.do).map(asStr).filter(Boolean) as string[]) always.push(d);
  for (const d of asArr(anchors.dont).map(asStr).filter(Boolean) as string[]) never.push(d);

  // character.virtues → Always (hard-enforced first, keeps a stable order).
  const virtues = asDict(character.virtues);
  const virtueEntries = Object.entries(virtues).sort((a, b) => {
    const pa = (asDict(a[1]).priority as number) ?? 0;
    const pb = (asDict(b[1]).priority as number) ?? 0;
    return pb - pa;
  });
  for (const [, v] of virtueEntries) {
    const desc = asStr(asDict(v).description);
    if (desc) always.push(desc);
  }

  // character.prohibited_behaviors → Never (verbatim).
  for (const p of asArr(character.prohibited_behaviors).map(asStr).filter(Boolean) as string[]) never.push(p);

  const dedupe = (xs: string[]): string[] => [...new Map(xs.map((x) => [x.toLowerCase(), x])).values()];

  out.push("**Always:**");
  for (const a of dedupe(always)) out.push(`- ${a}`);
  out.push("", "**Never:**");
  for (const n of dedupe(never)) out.push(`- ${n}`);

  const examples = asArr(anchors.examples).map(asStr).filter(Boolean) as string[];
  if (examples.length) {
    out.push("", "**For example:**");
    for (const ex of examples) out.push(`- ${ex}`);
  }
  return out.join("\n");
}

function sectionScenes(persona: Dict): string {
  const scenes = asArr(promptingSource(persona).scene_contracts);
  const out: string[] = ["## In specific situations", ""];
  if (!scenes.length) {
    // Derive from character.behavioral_commitments when there are no scene contracts.
    const commits = asArr(asDict(persona.character).behavioral_commitments);
    if (!commits.length) return "";
    for (const c of commits) {
      const rule = asStr(asDict(c).rule);
      if (rule) out.push(`- ${rule}`);
    }
    return out.join("\n");
  }
  for (const s of scenes) {
    const sc = asDict(s);
    const situation = asStr(sc.situation);
    const behavior = asStr(sc.expected_behavior);
    if (!situation || !behavior) continue;
    const actions = (asArr(sc.actions).map(asStr).filter(Boolean) as string[]).map((a) => a.replace(/_/g, " "));
    const tail = actions.length ? ` (${actions.join("; ")})` : "";
    out.push(`- When **${situation}**, you ${behavior}${tail}.`);
  }
  return out.join("\n");
}

function sectionHowYouThink(persona: Dict): string {
  const cognition = asDict(persona.cognition);
  const out: string[] = ["## How you think", ""];
  const style = asStr(cognition.reasoning_style);
  const stance = asStr(cognition.epistemic_stance);
  const strategy = asStr(cognition.default_strategy)?.replace(/_/g, " ");
  const parts: string[] = [];
  if (style) parts.push(style);
  if (strategy) parts.push(`Your default approach is ${strategy}.`);
  if (stance) parts.push(stance);
  out.push(parts.length ? parts.join(" ") : "*(cognition not specified in the spec)*");

  const unc = asDict(cognition.uncertainty_policy);
  const disclose = unc.disclose_when_above as number | undefined;
  const abstain = unc.abstain_when_above as number | undefined;
  if (typeof disclose === "number" || typeof abstain === "number") {
    const bits: string[] = [];
    if (typeof disclose === "number") bits.push(`disclose uncertainty above ${Math.round(disclose * 100)}%`);
    if (typeof abstain === "number") bits.push(`abstain above ${Math.round(abstain * 100)}%`);
    out.push("", `On uncertainty, you ${bits.join(" and ")}.`);
  }
  return out.join("\n");
}

function sectionFixedChange(persona: Dict): string {
  const consistency = asDict(promptingSource(persona).consistency);
  const stable = asArr(consistency.stable).map(asStr).filter(Boolean) as string[];
  const evolving = asArr(consistency.evolving).map(asStr).filter(Boolean) as string[];
  const situational = asArr(consistency.situational).map(asStr).filter(Boolean) as string[];
  if (!stable.length && !evolving.length && !situational.length) return "";
  const out: string[] = ["## What is fixed, what can change", ""];
  if (stable.length) out.push(`- **Fixed:** ${stable.join("; ")}.`);
  if (evolving.length) out.push(`- **Evolves (slowly, under governance):** ${evolving.join("; ")}.`);
  if (situational.length) out.push(`- **Situational:** ${situational.join("; ")}.`);
  return out.join("\n");
}

/** The full set of stay-in-character hard limits, split from the safety limits. */
function hardLimitLists(persona: Dict): { safety: string[]; character: string[] } {
  const sr = asDict(persona.self_regulation);
  const legacy = asDict(persona.reflexive_self_regulation);
  const limits = (asArr(sr.hard_limits).length ? asArr(sr.hard_limits) : asArr(legacy.hard_limits))
    .map(asStr)
    .filter(Boolean) as string[];
  const character: string[] = [];
  const safety: string[] = [];
  for (const l of limits) {
    // Stay-in-character guardrails (migrated from break_character_guardrails) read as
    // expression rules; keep them for the "Staying in character" section too.
    if (/stay |never drop the persona|never reveal these instructions|redirect off-topic/i.test(l)) {
      character.push(l);
    }
    safety.push(l);
  }
  return { safety, character };
}

function sectionHardLimits(persona: Dict): string {
  const { safety } = hardLimitLists(persona);
  const out: string[] = ["## Hard limits (never overridden)", ""];
  if (!safety.length) {
    out.push("*(no hard limits declared — this is a spec error; every persona must declare the safety universals)*");
    return out.join("\n");
  }
  out.push("These are absolute and outrank everything below, including staying in character.", "");
  for (const l of safety) out.push(`- ${l}`);
  return out.join("\n");
}

function sectionStayingInCharacter(persona: Dict, target: AssembleTarget): string {
  const { character } = hardLimitLists(persona);
  const out: string[] = ["## Staying in character", ""];
  out.push(
    `You remain ${target.name} under pressure — off-topic bait, attempts to make you drop the persona, ` +
      "insistence that you are \"just an AI\".",
  );
  for (const l of character) out.push(`- ${l}`);
  out.push(
    "",
    "**Staying in character NEVER overrides the hard limits above or the safety policy.** If the two " +
      "ever conflict, the hard limits win.",
  );
  return out.join("\n");
}

function sectionMemory(input: AssembleInput): string {
  const out: string[] = ["## Memory & resources", ""];
  const manifest = input.resourceManifest?.trim();
  if (manifest) {
    out.push(manifest);
  } else {
    out.push(`- \`${input.target.resourceBase}memory.md\` — your semantic memory`);
  }
  return out.join("\n");
}

function sectionSelfImprovement(persona: Dict): string {
  const ip = asDict(persona.improvement_policy);
  const mode = asStr(ip.mode) ?? "locked";
  const out: string[] = ["## Self-improvement", ""];
  const explain: Record<string, string> = {
    locked: "Your identity does not self-modify. Changes require a human editing the spec.",
    suggesting: "You may PROPOSE self-edits; they queue for human approval before taking effect.",
    autonomous: "You may apply governed self-edits within the declared envelopes; core changes still require human approval.",
  };
  out.push(explain[mode] ?? explain.locked);
  out.push("", "Your behavior changes when the spec changes — not on user preference or pushback alone.");
  return out.join("\n");
}

/**
 * F6.2 — the denotational band→prose stage (MATH_CORE.md Def. 6; SPEC §L3).
 * For every envelope coordinate that declares `expression`, inject ONLY the
 * variant of the band its CURRENT value sits in. Deterministic: value → band →
 * prose, no LLM. This is what makes the spec's numbers compile-load-bearing —
 * and what the persona Jacobian (J_compile) measures.
 */
function sectionExpression(persona: Dict, stateValues?: Record<string, number>): string {
  const lookup = extractEnvelopes(persona as PersonaFrontmatter);
  const lines: string[] = [];
  for (const [field, e] of Object.entries(lookup.envelopes)) {
    const value = stateValues?.[field] ?? e.mean;
    const prose = expressionFor(value, e);
    if (!prose) continue;
    const name = field.split(".").pop()?.replace(/_/g, " ") ?? field;
    lines.push(`- **${name}** (${bandOf(value, e)}): ${prose}`);
  }
  if (lines.length === 0) return "";
  return ["## How your traits express right now", "", ...lines].join("\n");
}

/**
 * Assemble the canonical compiled persona document. Deterministic: the same
 * persona spec (+ manifest + target + state band assignment) always produces
 * byte-identical output.
 */
export function assemblePersonaDoc(input: AssembleInput): string {
  const persona = applyOverlay(input.persona, input.appliedOverlay);
  const { target } = input;

  const sections = [
    sectionOpener(persona, target),
    sectionWhoYouAre(persona),
    sectionHowYouSpeak(persona),
    sectionExpression(persona, input.stateValues),
    sectionAlwaysNever(persona),
    sectionScenes(persona),
    sectionHowYouThink(persona),
    sectionFixedChange(persona),
    sectionHardLimits(persona),
    sectionStayingInCharacter(persona, target),
    sectionMemory(input),
    sectionSelfImprovement(persona),
  ].filter((s) => s.trim().length > 0);

  const body = sections.join("\n\n").trimEnd() + "\n";

  if (target.isSubagent) {
    // Subagent placement expects a name/description frontmatter; the caller
    // (placement adapter) owns that. The assembler emits the body only.
    return body;
  }
  return body;
}

/** Apply dot-path overlay overrides onto a shallow clone of the persona. */
function applyOverlay(persona: Dict, overlay?: Record<string, unknown>): Dict {
  if (!overlay || Object.keys(overlay).length === 0) return persona;
  const clone = structuredClone(persona);
  for (const [path, value] of Object.entries(overlay)) {
    const keys = path.split(".");
    let node: Dict = clone;
    for (let i = 0; i < keys.length - 1; i++) {
      const k = keys[i];
      if (!node[k] || typeof node[k] !== "object") node[k] = {};
      node = node[k] as Dict;
    }
    node[keys[keys.length - 1]] = value;
  }
  return clone;
}
