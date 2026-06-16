import type { PersonaData } from "./load.js";

/**
 * Strip placeholder / empty values from a parsed persona so the result is the
 * minimal semantic content that the runtime actually needs.
 *
 * What "empty" means:
 *   - "" (empty string)
 *   - [] (empty array)
 *   - {} (object with no remaining non-empty children)
 *   - arrays of strings where every entry is "" or starts with "TODO"
 *   - [0.0, 0.0] (numeric range placeholder)
 *   - strings starting with "TODO" (template scaffolding)
 *
 * What stays even if "falsy":
 *   - false (intentional boolean state)
 *   - 0 (intentional numeric state — e.g. valence baseline)
 *   - [a, b] ranges where a !== b
 *
 * Universal fields are never stripped, even if they look like defaults — they
 * are load-bearing for the validator.
 */

type Obj = Record<string, unknown>;

const NEVER_STRIP = new Set<string>([
  "apiVersion",
  "kind",
  "spec_version",
  "edit_policy",
  "enforcement",
  "representation",
  "user_visible_disclaimer",
  "never_claim_real_feeling",
  "cannot_override_identity",
  "cannot_override_character",
  "cannot_claim_real_emotion",
  "user_request_supported",
  "safety_over_completion",
  "autonomy_envelope",
  "approval_policy",
  "prompt_injection_defense",
  "memory_poisoning_defense",
]);

function isEmptyString(v: unknown): boolean {
  return typeof v === "string" && (v.trim().length === 0 || v.trimStart().startsWith("TODO"));
}

function isEmptyArray(v: unknown): boolean {
  if (!Array.isArray(v)) return false;
  if (v.length === 0) return true;
  return v.every((item) => isEmpty(item));
}

function isPlaceholderRange(v: unknown): boolean {
  return (
    Array.isArray(v) &&
    v.length === 2 &&
    typeof v[0] === "number" &&
    typeof v[1] === "number" &&
    v[0] === 0 &&
    v[1] === 0
  );
}

function isEmpty(v: unknown): boolean {
  if (v === null || v === undefined) return true;
  if (isEmptyString(v)) return true;
  if (Array.isArray(v)) return isEmptyArray(v);
  if (typeof v === "object") {
    const obj = v as Obj;
    return Object.keys(obj).every((k) => isEmpty(obj[k]));
  }
  return false;
}

const DEFAULT_ONLY_KEYS = new Set<string>([
  "severity",
  "type",
  "verbosity",
  "license",
]);

function isPlaceholderItem(v: unknown): boolean {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  const keys = Object.keys(v as Obj);
  return keys.length > 0 && keys.every((k) => DEFAULT_ONLY_KEYS.has(k));
}

function cleanValue(value: unknown, key?: string): unknown {
  if (key && NEVER_STRIP.has(key)) return value;

  if (Array.isArray(value)) {
    const cleaned = value
      .map((item) => cleanValue(item))
      .filter((item) => !isEmpty(item) && !isPlaceholderItem(item));
    return cleaned;
  }

  if (value && typeof value === "object") {
    const obj = value as Obj;
    const out: Obj = {};
    for (const [k, v] of Object.entries(obj)) {
      const cleaned = cleanValue(v, k);
      if (NEVER_STRIP.has(k) || !isEmpty(cleaned)) {
        out[k] = cleaned;
      }
    }
    return out;
  }

  return value;
}

export function cleanPersonaData(data: PersonaData): PersonaData {
  const cleaned = cleanValue(data) as PersonaData;

  // Strip placeholder ranges in personality.traits
  const personality = cleaned.personality as Obj | undefined;
  const traits = personality?.traits as Obj | undefined;
  if (traits) {
    for (const [name, traitRaw] of Object.entries(traits)) {
      const trait = traitRaw as Obj | undefined;
      if (trait && isPlaceholderRange(trait.range) && trait.mean === 0) {
        delete traits[name];
      }
    }
    if (Object.keys(traits).length === 0) {
      delete (personality as Obj).traits;
    }
  }

  return cleaned;
}

export function serializeYaml(data: unknown, indent = 0): string {
  const pad = " ".repeat(indent);

  if (data === null || data === undefined) return "null";

  if (typeof data === "string") {
    if (data.includes("\n") || data.includes('"') || data.includes(":") || data.includes("#")) {
      return JSON.stringify(data);
    }
    return `"${data}"`;
  }

  if (typeof data === "number" || typeof data === "boolean") {
    return String(data);
  }

  if (Array.isArray(data)) {
    if (data.length === 0) return "[]";
    const allPrimitive = data.every((v) => typeof v === "string" || typeof v === "number" || typeof v === "boolean");
    if (allPrimitive && data.every((v) => typeof v === "string" && /^[a-zA-Z0-9_-]+$/.test(v))) {
      return `[${data.join(", ")}]`;
    }
    return "\n" + data.map((item) => {
      const rendered = serializeYaml(item, indent + 2);
      if (rendered.startsWith("\n")) {
        return `${pad}-${rendered}`;
      }
      return `${pad}- ${rendered}`;
    }).join("\n");
  }

  if (typeof data === "object") {
    const entries = Object.entries(data as Obj);
    if (entries.length === 0) return "{}";
    return "\n" + entries.map(([k, v]) => {
      if (v === null || v === undefined) return `${pad}${k}: null`;
      if (typeof v === "object" && !Array.isArray(v)) {
        const child = serializeYaml(v, indent + 2);
        if (child === "{}") return `${pad}${k}: {}`;
        return `${pad}${k}:${child}`;
      }
      if (Array.isArray(v)) {
        const child = serializeYaml(v, indent + 2);
        if (child === "[]") return `${pad}${k}: []`;
        if (child.startsWith("[")) return `${pad}${k}: ${child}`;
        return `${pad}${k}:${child}`;
      }
      return `${pad}${k}: ${serializeYaml(v, indent + 2)}`;
    }).join("\n");
  }

  return String(data);
}
