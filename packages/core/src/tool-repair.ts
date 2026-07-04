/**
 * Tool-call repair (FR.10 — ported from OpenClaw's self-contained module):
 * salvage malformed / truncated LLM tool-call argument JSON before rejecting
 * it. Weaker models routinely emit almost-JSON — a code fence around it,
 * single quotes, a trailing comma, or a truncation mid-object. Rejecting those
 * costs a full round-trip; a deterministic repair pass recovers most of them.
 *
 * Repairs are CONSERVATIVE and layered; the result reports `repaired: true`
 * so callers can log/trace that the model needed help (a quality signal).
 */

export interface RepairResult {
  ok: boolean;
  value?: Record<string, unknown>;
  repaired: boolean;
  /** Which repairs were applied, in order (for tracing). */
  applied: string[];
  error?: string;
}

/** Parse tool-call args, repairing common LLM malformations when needed. */
export function repairToolArgs(raw: string): RepairResult {
  const applied: string[] = [];
  let text = raw.trim();

  const attempt = (): Record<string, unknown> | null => {
    try {
      const v = JSON.parse(text) as unknown;
      return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  };

  // 0. Already valid.
  let v = attempt();
  if (v) return { ok: true, value: v, repaired: false, applied };

  // 1. Strip a markdown code fence (```json ... ```).
  const fence = text.match(/^```[a-zA-Z]*\s*\n?([\s\S]*?)\n?```\s*$/);
  if (fence) {
    text = fence[1].trim();
    applied.push("strip-code-fence");
    if ((v = attempt())) return { ok: true, value: v, repaired: true, applied };
  }

  // 2. Extract the outermost {...} from surrounding prose.
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first > 0 || (first === 0 && last !== text.length - 1)) {
    if (first !== -1 && last > first) {
      text = text.slice(first, last + 1);
      applied.push("extract-object");
      if ((v = attempt())) return { ok: true, value: v, repaired: true, applied };
    }
  }

  // 3. Normalize single-quoted strings/keys → double quotes (when no double
  //    quotes are present at all — avoids corrupting embedded apostrophes).
  if (!text.includes('"') && text.includes("'")) {
    text = text.replace(/'/g, '"');
    applied.push("single-to-double-quotes");
    if ((v = attempt())) return { ok: true, value: v, repaired: true, applied };
  }

  // 4. Quote unquoted keys ({key: → {"key":).
  const quotedKeys = text.replace(/([{,]\s*)([A-Za-z_][A-Za-z0-9_]*)(\s*:)/g, '$1"$2"$3');
  if (quotedKeys !== text) {
    text = quotedKeys;
    applied.push("quote-keys");
    if ((v = attempt())) return { ok: true, value: v, repaired: true, applied };
  }

  // 5. Remove trailing commas before } or ].
  const noTrailing = text.replace(/,\s*([}\]])/g, "$1");
  if (noTrailing !== text) {
    text = noTrailing;
    applied.push("strip-trailing-commas");
    if ((v = attempt())) return { ok: true, value: v, repaired: true, applied };
  }

  // 6. Truncation: close an unterminated string, then balance braces/brackets.
  const closed = closeTruncated(text);
  if (closed !== text) {
    text = closed;
    applied.push("close-truncated");
    if ((v = attempt())) return { ok: true, value: v, repaired: true, applied };
  }

  return { ok: false, repaired: applied.length > 0, applied, error: "unrecoverable tool-call JSON" };
}

/** Close an unterminated trailing string and balance {} / []. */
function closeTruncated(text: string): string {
  let inString = false;
  let escaped = false;
  const stack: string[] = [];
  for (const ch of text) {
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === "{") stack.push("}");
    else if (ch === "[") stack.push("]");
    else if (ch === "}" || ch === "]") {
      if (stack[stack.length - 1] === ch) stack.pop();
    }
  }
  let out = text;
  // A truncated value like `{"a": "unfinish` → close the string first.
  if (inString) out += '"';
  // Drop a dangling comma/colon before closing (`{"a": 1,` / `{"a":`).
  out = out.replace(/[,:]\s*$/, (m) => (m.trim() === ":" ? ': null' : ""));
  while (stack.length > 0) out += stack.pop();
  return out;
}
