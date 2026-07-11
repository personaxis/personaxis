/**
 * F3.7, surgical, comment-preserving dot-path edits of a persona spec.
 *
 * The persona spec (`personaxis.md` frontmatter) is authored YAML with dense
 * tier/consumer-tag comments. Editing it must NEVER parse→re-serialize (that
 * strips every author comment), so, like the migrate codemods, this edits the
 * raw text: it locates the dot-path's leaf line by indentation and replaces only
 * the scalar value, keeping indentation and any trailing `# comment`.
 *
 * Supported leaves:
 *   - block scalars at any depth        (a.b.c: value)
 *   - one-level flow-map leaves          (parent: { key: value, … } → edit key)
 * A path that resolves to a block/array (not a scalar) is rejected, those are
 * structural edits the author makes in the file (or via a codemod), not surgical
 * value changes.
 */

const INDENT = "  ";

/** Read the value at a dot-path from a parsed object (undefined if absent). */
export function getAtPath(root: unknown, dotPath: string): unknown {
  let node: unknown = root;
  for (const seg of dotPath.split(".")) {
    if (node == null || typeof node !== "object") return undefined;
    node = (node as Record<string, unknown>)[seg];
  }
  return node;
}

/** Coerce a raw CLI string to the type of an existing sample value (num/bool/string). */
export function coerceLike(raw: string, sample: unknown): unknown {
  if (typeof sample === "number") {
    const n = Number(raw);
    if (!Number.isFinite(n)) throw new Error(`"${raw}" is not a number (the current value is numeric)`);
    return n;
  }
  if (typeof sample === "boolean") {
    if (raw === "true") return true;
    if (raw === "false") return false;
    throw new Error(`"${raw}" is not a boolean (use true/false)`);
  }
  return raw; // string (or unknown sample) → verbatim
}

/** Serialize a scalar for YAML: quote a string only when needed; numbers/bools bare. */
function scalarToYaml(v: unknown): string {
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  const s = String(v);
  // Quote when the string could be misread as another YAML type or has special chars.
  if (s === "" || /^[\s]|[\s]$|[:#{}[\],&*!|>'"%@`]|^(true|false|null|~|-?\d)/.test(s)) {
    return JSON.stringify(s); // JSON string is valid YAML double-quoted
  }
  return s;
}

/** The line index of `indent + key:` within [from, to); -1 if absent. */
function findKeyLine(lines: string[], key: string, indent: string, from: number, to: number): number {
  const prefix = indent + key + ":";
  for (let i = from; i < to; i++) if (lines[i].startsWith(prefix)) return i;
  return -1;
}

/** End (exclusive) of the block owned by the key at `start` (indent-based). */
function blockEnd(lines: string[], start: number, indent: string, to: number): number {
  let end = start + 1;
  while (end < to) {
    const l = lines[end];
    if (l.trim() !== "" && !l.startsWith(indent + " ") && !l.startsWith(indent + "\t")) break;
    end++;
  }
  return end;
}

/** Split a `key: value  # comment` line into value + trailing comment (comment kept verbatim). */
function splitValueComment(afterColon: string): { value: string; comment: string } {
  // A '#' starts a comment only when preceded by whitespace (or at col 0 of the value).
  const m = afterColon.match(/^(.*?)(\s+#.*)?$/s);
  return { value: (m?.[1] ?? afterColon).trimEnd(), comment: m?.[2] ?? "" };
}

export interface SpecEditResult {
  text: string;
  previous: unknown;
}

/**
 * Set a scalar at `dotPath` in the raw frontmatter YAML, preserving comments.
 * `parsed` is the same YAML already parsed (for the current value + type). Throws
 * with a clear message when the path is missing or is not a scalar leaf.
 */
export function setScalarAtPath(
  frontmatterYaml: string,
  parsed: Record<string, unknown>,
  dotPath: string,
  newValue: unknown,
): SpecEditResult {
  const previous = getAtPath(parsed, dotPath);
  if (previous === undefined) throw new Error(`path not found: ${dotPath}`);
  if (previous !== null && typeof previous === "object") {
    throw new Error(`${dotPath} is a ${Array.isArray(previous) ? "list" : "block"}, not a scalar, edit it in the file directly`);
  }

  const lines = frontmatterYaml.split("\n");
  const segs = dotPath.split(".");
  let from = 0;
  let to = lines.length;
  let indent = "";

  // Descend the block structure for every segment but the last.
  for (let s = 0; s < segs.length - 1; s++) {
    const idx = findKeyLine(lines, segs[s], indent, from, to);
    if (idx === -1) throw new Error(`path not found: ${dotPath} (missing "${segs[s]}")`);
    // Flow-map fallback: the value is inline `{ … }` and the rest of the path is inside it.
    const afterColon = lines[idx].slice((indent + segs[s] + ":").length);
    if (afterColon.trim().startsWith("{")) {
      return editFlowMapLeaf(lines, idx, indent + segs[s] + ":", segs.slice(s + 1), newValue, previous);
    }
    from = idx + 1;
    to = blockEnd(lines, idx, indent, to);
    indent += INDENT;
  }

  // The leaf: a block scalar `indent + key: value`.
  const leaf = segs[segs.length - 1];
  const li = findKeyLine(lines, leaf, indent, from, to);
  if (li === -1) throw new Error(`path not found: ${dotPath} (missing "${leaf}")`);
  const afterColon = lines[li].slice((indent + leaf + ":").length);
  if (afterColon.trim() === "" || afterColon.trim().startsWith("{") || afterColon.trim().startsWith("[")) {
    throw new Error(`${dotPath} is not a block scalar, edit it in the file directly`);
  }
  const { comment } = splitValueComment(afterColon);
  lines[li] = `${indent}${leaf}: ${scalarToYaml(newValue)}${comment}`;
  return { text: lines.join("\n"), previous };
}

/** Replace `key: value` for one key inside a single-line flow map `parent: { … }`. */
function editFlowMapLeaf(
  lines: string[],
  lineIdx: number,
  keyPrefix: string,
  remaining: string[],
  newValue: unknown,
  previous: unknown,
): SpecEditResult {
  if (remaining.length !== 1) {
    throw new Error(`nested flow-map path too deep, edit "${keyPrefix.replace(/:$/, "")}" in the file directly`);
  }
  const nested = remaining[0];
  const line = lines[lineIdx];
  const re = new RegExp(`(\\{[^}]*?\\b${nested}\\s*:\\s*)([^,}]*?)(\\s*[,}])`);
  if (!re.test(line)) throw new Error(`key "${nested}" not found in the flow map`);
  lines[lineIdx] = line.replace(re, (_m, pre: string, _old: string, post: string) => `${pre}${scalarToYaml(newValue)}${post}`);
  return { text: lines.join("\n"), previous };
}
