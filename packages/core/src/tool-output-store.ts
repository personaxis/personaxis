/**
 * Tool-output offloading (J.6): a big tool output (a build log, a long directory listing,
 * a whole file) does not belong in the model's context verbatim. Truncation loses the tail;
 * offloading keeps it RECOVERABLE. The full output is stored out-of-band under a handle, the
 * model sees a short preview plus the handle, and it pulls the slice it needs on demand
 * (`read_output` / `grep_output`), instead of paying for 100k of context it will mostly ignore.
 *
 * The store is per-run and in memory (an offloaded output lives only for the run that made it).
 * Pure and injectable: the store is a plain object, and `outputStoreTools(store)` closes over
 * it exactly like `memoryTools` closes over a persona, so the loop wires it without a global.
 */

import type { ToolSpec } from "./tools/registry.js";

/** Outputs at or above this many characters are offloaded instead of inlined. */
export const OFFLOAD_THRESHOLD = 4_000;
/** How many leading characters of an offloaded output the model sees inline. */
export const PREVIEW_CHARS = 800;
/**
 * E109: how long an outline may be before the preview falls back to the head.
 *
 * Larger than the head it replaces, because an outline earns its characters: it says what the whole document
 * holds and where, while the same characters of head say one arbitrary section in full.
 */
const OUTLINE_CHARS = 1_400;
/** Fewer headings than this is not a document worth outlining; its head says more. */
const OUTLINE_MIN_HEADINGS = 3;

/**
 * The outline of a document that has headings: each one with the LINE it starts on, or "" for anything else.
 *
 * ## Why the line numbers are the whole point
 *
 * Measured on 2026-09-22 with the autonomy bench. A persona asked which sources its advice on game feel rested
 * on opened the right 9,836-character file, and then answered from the preview, which is the first 800
 * characters, which happen to be the first section: it cited the sources of "core loops" six times out of six.
 * The one run that did search for "game feel juice" got back the heading line and nothing else, because
 * `grep` returns matching LINES. So knowing a section exists is not enough. The only way to read one is
 * `read_output` at its offset, and offsets here are lines, so the outline has to carry them.
 *
 * All of the headings or none: a partial outline is read as the whole document, which is the lesson the work
 * map paid for the same afternoon with a truncated list of topics.
 */
function outlineOf(content: string): string {
	const lines = content.split("\n");
	const headings: string[] = [];
	for (let i = 0; i < lines.length; i += 1) {
		const heading = /^(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/.exec(lines[i]!);
		if (heading) headings.push(`line ${i}: ${heading[1]} ${heading[2]!.trim()}`);
	}
	if (headings.length < OUTLINE_MIN_HEADINGS) return "";
	const outline = headings.join("\n");
	return outline.length <= OUTLINE_CHARS ? outline : "";
}

export interface StoredOutput {
  handle: string;
  tool: string;
  content: string;
  bytes: number;
  lines: number;
}

export interface OffloadResult {
  /** What the model sees in the transcript (either the original, or preview + pointer). */
  text: string;
  /** True when the output was offloaded (large); false when it was small enough to inline. */
  offloaded: boolean;
  handle?: string;
}

export class ToolOutputStore {
  private readonly items = new Map<string, StoredOutput>();
  private seq = 0;

  /**
   * Offload `content` if it exceeds the threshold; otherwise pass it through unchanged.
   * A deterministic per-store handle (`out-1`, `out-2`, …) keeps runs reproducible.
   */
  offload(tool: string, content: string, threshold = OFFLOAD_THRESHOLD): OffloadResult {
    // A window of a stored output is never stored again. Found 2026-09-11 in the E52 bench:
    // `read_output(out-1, limit: 200)` returned the whole file, which crossed the threshold,
    // was stored as `out-2`, the model read `out-2` the same way, and so on until the step
    // ran out: 19 reads, no write, the step failed. `slice` and `grep` now fit their answer
    // under the threshold, and this is the second lock on the same door.
    if (tool === "read_output" || tool === "grep_output") return { text: content, offloaded: false };
    if (content.length < threshold) return { text: content, offloaded: false };
    const handle = `out-${++this.seq}`;
    const lines = content.split("\n").length;
    this.items.set(handle, { handle, tool, content, bytes: content.length, lines });
    // E109: a document gets its outline, anything else gets its head. The head of a document is one section
    // in full and the model answers from it; the outline is every section with the line it starts on, which
    // is what `read_output` needs to go and get one.
    const outline = outlineOf(content);
    const text =
      outline === ""
        ? `${content.slice(0, PREVIEW_CHARS)}\n…[output truncated in context; ${content.length} chars / ${lines} lines stored as '${handle}'. ` +
          `Use read_output(handle:'${handle}', offset, limit) or grep_output(handle:'${handle}', pattern) to read the rest.]`
        : `['${handle}': ${content.length} chars / ${lines} lines, not shown here. Its sections:]\n${outline}\n` +
          `…[read one with read_output(handle:'${handle}', offset:<the line above>, limit:20). ` +
          `grep_output(handle:'${handle}', pattern) returns the matching LINES only, so searching for a heading ` +
          `gives you the heading and not what is under it.]`;
    return { text, offloaded: true, handle };
  }

  get(handle: string): StoredOutput | undefined {
    return this.items.get(handle);
  }

  /**
   * A window of LINES from a stored output ([offset, offset+limit)), cut short so it fits under
   * the offload threshold: a window that did not fit would be the same problem it was asked to
   * solve. When it is cut, it says which line to ask for next.
   */
  slice(handle: string, offset = 0, limit = 100): string {
    const item = this.items.get(handle);
    if (!item) return `no stored output '${handle}'`;
    const all = item.content.split("\n");
    const start = Math.max(0, Math.floor(offset));
    const wanted = Math.min(all.length, start + Math.max(1, Math.floor(limit)));
    const budget = OFFLOAD_THRESHOLD - 300;
    const lines: string[] = [];
    let used = 0;
    let end = start;
    while (end < wanted) {
      const line = all[end]!;
      if (lines.length > 0 && used + line.length + 1 > budget) break;
      // A single line longer than the whole budget is cut, and says so, rather than sent whole.
      lines.push(line.length > budget ? `${line.slice(0, budget)} …[line cut at ${budget} chars]` : line);
      used += Math.min(line.length, budget) + 1;
      end += 1;
    }
    const body = lines.join("\n");
    const more = end < all.length ? `\n…[lines ${end}-${all.length - 1} remain; call again with offset ${end}]` : "";
    return `'${handle}' lines ${start}-${end - 1} of ${all.length}:\n${body}${more}`;
  }

  /** Lines of a stored output matching a pattern (literal substring or /regex/). */
  grep(handle: string, pattern: string, max = 50): string {
    const item = this.items.get(handle);
    if (!item) return `no stored output '${handle}'`;
    let re: RegExp;
    try {
      const m = pattern.match(/^\/(.*)\/([a-z]*)$/);
      re = m ? new RegExp(m[1], m[2]) : new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    } catch {
      re = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    }
    const hits: string[] = [];
    const all = item.content.split("\n");
    // Fits under the offload threshold, like `slice`, so a search is never stored again.
    const budget = OFFLOAD_THRESHOLD - 300;
    let used = 0;
    let cut = false;
    for (let i = 0; i < all.length && hits.length < max; i++) {
      if (!re.test(all[i])) continue;
      const hit = `${i}: ${all[i]!.length > 400 ? `${all[i]!.slice(0, 400)} …` : all[i]}`;
      if (used + hit.length + 1 > budget) {
        cut = true;
        break;
      }
      hits.push(hit);
      used += hit.length + 1;
    }
    if (!hits.length) return `no line in '${handle}' matched ${pattern}`;
    return `${hits.length} match(es) in '${handle}'${cut ? " (more matches; narrow the pattern)" : ""}:\n${hits.join("\n")}`;
  }

  get size(): number {
    return this.items.size;
  }
}

/** Read-only tools over a per-run output store, closured like memoryTools. */
export function outputStoreTools(store: ToolOutputStore): ToolSpec[] {
  const allow = {
    decision: "allow" as const,
    reason: "reads an output this run already produced (in-memory)",
    class: { writesFiles: false, network: false, destructive: false, escapesWorkspace: false },
  };
  return [
    {
      name: "read_output",
      category: "meta",
      isReadOnly: true,
      isConcurrencySafe: true,
      description:
        "Read a window of a large tool output that was offloaded (you saw its handle 'out-N' in a truncation notice). Returns the requested LINES so you can inspect the part that was cut.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["handle"],
        properties: {
          handle: { type: "string", description: "The 'out-N' handle from the truncation notice." },
          offset: { type: "number", description: "First line to return (default 0)." },
          limit: { type: "number", description: "How many lines to return (default 100)." },
        },
      },
      gate: () => allow,
      execute: async (args) => {
        const handle = typeof args.handle === "string" ? args.handle : "";
        const offset = typeof args.offset === "number" ? args.offset : 0;
        const limit = typeof args.limit === "number" ? args.limit : 100;
        return store.slice(handle, offset, limit);
      },
    },
    {
      name: "grep_output",
      category: "meta",
      isReadOnly: true,
      isConcurrencySafe: true,
      description:
        "Search a large offloaded tool output (handle 'out-N') for matching lines, instead of reading it all. Pattern is a substring or /regex/.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["handle", "pattern"],
        properties: {
          handle: { type: "string", description: "The 'out-N' handle." },
          pattern: { type: "string", description: "Substring, or /regex/flags." },
        },
      },
      gate: () => allow,
      execute: async (args) => {
        const handle = typeof args.handle === "string" ? args.handle : "";
        const pattern = typeof args.pattern === "string" ? args.pattern : "";
        return store.grep(handle, pattern);
      },
    },
  ];
}
