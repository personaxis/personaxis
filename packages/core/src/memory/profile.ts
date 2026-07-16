/**
 * The user profile (V2-F1.1), the fix for "the persona forgot my name".
 *
 * Design decision (documented; no new artifact): stable user facts REUSE the spec's
 * `user_preferences` store (`memory/preferences.json`, last-wins, timestamped) under
 * dotted `user.*` keys, e.g. `user.name`. The profile is therefore governed by the
 * same flag (`memory.types.user_preferences`), the same injection guard, and needs
 * no second file. `userProfile()` splits the store into profile facts (`user.*`)
 * vs plain preferences for prompt rendering.
 *
 * `extractUserFacts` is the OFFLINE path: deterministic ES/EN patterns that catch a
 * user introducing themselves or stating a durable preference, so name recall works
 * with no model configured. The LLM appraiser proposes the same shape (dotted keys)
 * when a model is available.
 */

import type { ProposedPreference } from "../appraisal.js";
import { readPreferences, type PreferenceValue } from "../memory-kinds.js";

/** Keys under this prefix are the user profile (identity facts, not preferences). */
export const USER_KEY_PREFIX = "user.";

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
 * Deterministic ES/EN presentation patterns. Precision over recall: a wrong "name"
 * poisons every later greeting, so only unambiguous presentations match ("soy X"
 * alone is NOT taken as a name, "I'm tired" / "soy sincero" would false-positive).
 * The trigger phrase is case-insensitive by construction; the NAME capture is NOT
 * (a global `i` flag would fold \p{Lu} and swallow "y trabajo en" as surnames).
 */
const ci = (s: string): string => s.replace(/[a-záéíóú]/g, (c) => `[${c}${c.toUpperCase()}]`);
const FACT_RULES: FactRule[] = [
  { key: "user.name", re: new RegExp(`\\b${ci("me llamo")}\\s+${NAME}`, "u"), rationale: "the user introduced themselves (es)" },
  { key: "user.name", re: new RegExp(`\\b${ci("mi nombre es")}\\s+${NAME}`, "u"), rationale: "the user stated their name (es)" },
  { key: "user.name", re: new RegExp(`\\b${ci("my name is")}\\s+${NAME}`, "u"), rationale: "the user stated their name (en)" },
  { key: "user.name", re: new RegExp(`\\b[Ii](?:'| a)?${ci("m called")}\\s+${NAME}`, "u"), rationale: "the user stated their name (en)" },
  { key: "user.alias", re: new RegExp(`\\b(?:[Ll]l[aá]mame|${ci("dime")}|${ci("call me")})\\s+${NAME}`, "u"), rationale: "the user asked to be addressed this way" },
];

const cap = (s: string): string => s.replace(/\s+/g, " ").trim();

/** Extract stable user facts from one observation (offline, deterministic). */
export function extractUserFacts(observation: string): ProposedPreference[] {
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

export interface UserProfileView {
  /** `user.*` facts (identity), prefix stripped: e.g. { name: "David" }. */
  facts: Record<string, PreferenceValue>;
  /** Everything else in the preferences store. */
  preferences: Record<string, PreferenceValue>;
}

/** Split the preferences store into the user profile vs plain preferences. */
export function userProfile(personaPath: string): UserProfileView {
  const all = readPreferences(personaPath);
  const facts: Record<string, PreferenceValue> = {};
  const preferences: Record<string, PreferenceValue> = {};
  for (const [k, v] of Object.entries(all)) {
    if (k.startsWith(USER_KEY_PREFIX)) facts[k.slice(USER_KEY_PREFIX.length)] = v;
    else preferences[k] = v;
  }
  return { facts, preferences };
}

/** Render the `# User profile` prompt block ("" when empty). Budgeted by caller. */
export function renderUserProfile(view: UserProfileView, extras: { workingSelf?: string; anchors?: string[] } = {}): string {
  const lines: string[] = [];
  for (const [k, v] of Object.entries(view.facts)) lines.push(`- ${k}: ${v.value}`);
  if (extras.anchors?.length) for (const a of extras.anchors) lines.push(`- anchor: ${a}`);
  if (!lines.length && !extras.workingSelf) return "";
  const head = extras.workingSelf ? [`(self-model: ${extras.workingSelf})`] : [];
  return ["# User profile (stable facts, always loaded)", ...head, ...lines].join("\n");
}
