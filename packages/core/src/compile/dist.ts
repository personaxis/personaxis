/**
 * F3.2, `.dist/` consumer slices (formalizes the plan's `.dist/` model).
 *
 * The compiled PERSONA.md is the COLD, complete document. Hosts that inject an
 * identity ahead of EVERY turn pay for its full length on every call, but most
 * of that length (worked examples, audience adaptations, self-improvement prose)
 * is not needed on the hot path. So the deterministic compiler also emits a HOT
 * slice: the always-load essentials, the opener, how the persona speaks, the
 * always/never anchors, and the hard limits (safety must never be dropped from
 * a hot slice). Everything else stays in the cold document, loaded on demand.
 *
 * Slices are DETERMINISTIC and DERIVED (rebuildable from PERSONA.md); they are
 * ephemeral build output, never hand-edited, the same contract as the artifact
 * the assembler produces.
 */

/** Section headings that belong in the hot slice (always loaded), in order. */
const HOT_SECTIONS = [
  "how you speak",
  "what you always / never do",
  "hard limits (never overridden)",
  "staying in character",
];

interface Section {
  heading: string; // "" for the pre-first-heading preamble (the "# You are …" opener)
  text: string; // full text including the heading line
}

function splitSections(doc: string): Section[] {
  const lines = doc.split(/\r?\n/);
  const sections: Section[] = [];
  let heading = "";
  let buf: string[] = [];
  const flush = (): void => {
    if (buf.length) sections.push({ heading: heading.toLowerCase(), text: buf.join("\n").replace(/\s+$/, "") });
  };
  for (const line of lines) {
    const h = line.match(/^##\s+(.*)$/);
    if (h) {
      flush();
      heading = h[1].trim();
      buf = [line];
    } else {
      buf.push(line);
    }
  }
  flush();
  return sections;
}

export interface DistSlices {
  /** Always-load essentials: opener + how-you-speak + anchors + hard limits. */
  hot: string;
  /** The full compiled document (identical to PERSONA.md). */
  cold: string;
}

/**
 * Derive the hot/cold slices from a compiled document. `cold` is the document
 * verbatim; `hot` is the opener (everything before the first `## `) followed by
 * the HOT_SECTIONS present, in canonical order.
 */
export function distSlices(compiledDoc: string): DistSlices {
  const sections = splitSections(compiledDoc);
  const preamble = sections.find((s) => s.heading === "");
  const parts: string[] = [];
  if (preamble) parts.push(preamble.text.trim());
  for (const wanted of HOT_SECTIONS) {
    const s = sections.find((sec) => sec.heading === wanted);
    if (s) parts.push(s.text.trim());
  }
  return { hot: parts.join("\n\n").trimEnd() + "\n", cold: compiledDoc.trimEnd() + "\n" };
}

/** Standard slice file names under `.dist/`. */
export const DIST_HOT_FILE = "PERSONA.hot.md";
export const DIST_COLD_FILE = "PERSONA.cold.md";
