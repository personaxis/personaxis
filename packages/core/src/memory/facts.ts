/**
 * Entity-facts memory (V2-F1.1, generalized). The stable, always-loaded knowledge
 * a persona keeps about the entities it interacts with and the world it operates
 * in. It is NOT limited to "the user": a fact's SUBJECT is any named entity, the
 * ambient interlocutor (a human, another agent, or an app), a named person /
 * agent / app, the project, a system. The name case is just one instance of the
 * same logic.
 *
 * Facts REUSE the spec's `user_preferences` store (`memory/preferences.json`,
 * last-wins, timestamped): a key WITH a dot is a subject-qualified fact
 * (`<subject>.<attribute>`, always loaded, grouped by subject); a key WITHOUT a
 * dot is a loose preference. No hardcoded entity, no second artifact, governed by
 * the same `memory.types.user_preferences` flag and injection guard.
 *
 * `extractFacts` is the OFFLINE path: deterministic ES/EN patterns capturing the
 * interlocutor's self-introduction (name/alias), entity-neutrally, so recall
 * works with no model. The LLM appraiser proposes the same `subject.attribute`
 * shape and can attribute a fact to ANY subject it identifies.
 */

import type { ProposedPreference } from "../appraisal.js";
import { readPreferences, type PreferenceValue } from "../memory-kinds.js";

/**
 * A captured name: the first word in any case (people type lowercase), but
 * CONTINUATION words only when Capitalized (surnames), so "me llamo David y
 * trabajo en esto" captures "David", never "David y trabajo".
 */
const NAME = "([\\p{L}][\\p{L}'’-]{0,29}(?:\\s+[\\p{Lu}][\\p{L}'’-]{0,29}){0,3})";

interface FactRule {
  key: string;
  re: RegExp;
  rationale: string;
}

/**
 * Deterministic ES/EN presentation patterns. Precision over recall: a wrong name
 * poisons every later reference, so only unambiguous presentations match ("soy X"
 * alone is NOT taken as a name, "I'm tired" / "soy sincero" would false-positive).
 * The trigger phrase is case-insensitive by construction; the NAME capture is NOT
 * (a global `i` flag would fold \p{Lu} and swallow "y trabajo en" as surnames).
 *
 * The subject is the entity-neutral `interlocutor` (the party the persona is
 * talking to, whoever/whatever it is), NEVER a hardcoded "user".
 */
const ci = (s: string): string => s.replace(/[a-záéíóúñ]/g, (c) => `[${c}${c.toUpperCase()}]`);
const FACT_RULES: FactRule[] = [
  { key: "interlocutor.name", re: new RegExp(`\\b${ci("me llamo")}\\s+${NAME}`, "u"), rationale: "the interlocutor introduced themselves (es)" },
  { key: "interlocutor.name", re: new RegExp(`\\b${ci("mi nombre es")}\\s+${NAME}`, "u"), rationale: "the interlocutor stated their name (es)" },
  { key: "interlocutor.name", re: new RegExp(`\\b${ci("my name is")}\\s+${NAME}`, "u"), rationale: "the interlocutor stated their name (en)" },
  { key: "interlocutor.name", re: new RegExp(`\\b[Ii](?:'| a)?${ci("m called")}\\s+${NAME}`, "u"), rationale: "the interlocutor stated their name (en)" },
  { key: "interlocutor.alias", re: new RegExp(`\\b(?:[Ll]l[aá]mame|${ci("dime")}|${ci("call me")})\\s+${NAME}`, "u"), rationale: "the interlocutor asked to be addressed this way" },
];

const cap = (s: string): string => s.replace(/\s+/g, " ").trim();

/** Extract stable entity facts from one observation (offline, deterministic). */
export function extractFacts(observation: string): ProposedPreference[] {
  const out: ProposedPreference[] = [];
  const seen = new Set<string>();
  for (const rule of FACT_RULES) {
    const m = rule.re.exec(observation);
    if (m && !seen.has(rule.key)) {
      seen.add(rule.key);
      out.push({ key: rule.key, value: cap(m[1]), rationale: rule.rationale });
    }
  }
  return out;
}

/** True when a preference key is a subject-qualified fact (`subject.attribute`). */
export function isFactKey(key: string): boolean {
  return key.includes(".");
}

/** The subject of a fact key ("interlocutor.name" -> "interlocutor"). */
export function subjectOf(key: string): string {
  return key.slice(0, key.indexOf("."));
}

export interface FactsView {
  /** Subject-qualified facts (dotted keys), full key preserved. */
  facts: Record<string, PreferenceValue>;
  /** Loose preferences (no dot in the key). */
  preferences: Record<string, PreferenceValue>;
}

/** Split the preferences store into subject-qualified facts vs loose preferences. */
export function factsView(personaPath: string): FactsView {
  const all = readPreferences(personaPath);
  const facts: Record<string, PreferenceValue> = {};
  const preferences: Record<string, PreferenceValue> = {};
  for (const [k, v] of Object.entries(all)) {
    if (isFactKey(k)) facts[k] = v;
    else preferences[k] = v;
  }
  return { facts, preferences };
}

/**
 * Render the `# Known facts` prompt block, grouped by subject ("" when empty).
 * Works for any subject the store holds (interlocutor, a named person/agent/app,
 * the project, …), so the block never assumes a single "user". Budgeted by caller.
 */
export function renderFacts(view: FactsView, extras: { workingSelf?: string; anchors?: string[] } = {}): string {
  const bySubject = new Map<string, string[]>();
  for (const [k, v] of Object.entries(view.facts)) {
    const subj = subjectOf(k);
    const attr = k.slice(subj.length + 1);
    bySubject.set(subj, [...(bySubject.get(subj) ?? []), `${attr} = ${v.value}`]);
  }
  const lines: string[] = [];
  for (const [subj, attrs] of bySubject) lines.push(`- ${subj}: ${attrs.join(", ")}`);
  if (extras.anchors?.length) for (const a of extras.anchors) lines.push(`- anchor: ${a}`);
  if (!lines.length && !extras.workingSelf) return "";
  const head = extras.workingSelf ? [`(self-model: ${extras.workingSelf})`] : [];
  return ["# Known facts (stable, always loaded)", ...head, ...lines].join("\n");
}

/** Any `*.name` fact (whatever the subject), for a reply that addresses a known party. */
export function knownName(view: FactsView): string | undefined {
  for (const [k, v] of Object.entries(view.facts)) {
    if (k.endsWith(".name")) return v.value;
  }
  return undefined;
}
