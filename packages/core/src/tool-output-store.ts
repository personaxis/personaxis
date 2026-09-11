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
    const preview = content.slice(0, PREVIEW_CHARS);
    const text =
      `${preview}\n…[output truncated in context; ${content.length} chars / ${lines} lines stored as '${handle}'. ` +
      `Use read_output(handle:'${handle}', offset, limit) or grep_output(handle:'${handle}', pattern) to read the rest.]`;
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
