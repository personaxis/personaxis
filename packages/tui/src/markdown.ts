/**
 * Terminal markdown / syntax / diff rendering (FR.3 decision table):
 *   markdown → marked + marked-terminal
 *   syntax   → shiki, LAZY-loaded (heavy; first highlight pays the import)
 *   diff     → jsdiff + chalk
 */

import chalk from "chalk";
import { Marked } from "marked";
import { markedTerminal } from "marked-terminal";
import { diffLines } from "diff";

const marked = new Marked(
  markedTerminal({
    reflowText: false,
    tab: 2,
  }) as Parameters<Marked["use"]>[0],
);

/** Render markdown for the terminal (synchronous, no syntax highlight). */
export function renderMarkdown(md: string): string {
  const out = marked.parse(md, { async: false }) as string;
  return out.replace(/\n+$/, "");
}

// ── lazy shiki ────────────────────────────────────────────────────────────────

type Highlighter = { codeToAnsi?: unknown } & Record<string, unknown>;
let shikiPromise: Promise<Highlighter | null> | null = null;

async function shiki(): Promise<Highlighter | null> {
  if (!shikiPromise) {
    // Optional at runtime: highlighting degrades to plain text when shiki is
    // not installed (it is a heavy optional enhancement, not a core need).
    shikiPromise = import(/* @vite-ignore */ "shiki" as string)
      .then((m) => m as Highlighter)
      .catch(() => null);
  }
  return shikiPromise;
}

/** Highlight code with shiki when available; plain text otherwise. */
export async function highlightCode(code: string, lang: string): Promise<string> {
  const m = (await shiki()) as
    | { codeToAnsi?: (code: string, opts: { lang: string; theme: string }) => Promise<string> }
    | null;
  if (!m?.codeToAnsi) return code;
  try {
    return await m.codeToAnsi(code, { lang, theme: "github-dark" });
  } catch {
    return code;
  }
}

// ── diffs ─────────────────────────────────────────────────────────────────────

/** Line diff, colored for the terminal. */
export function renderDiff(before: string, after: string): string {
  return diffLines(before, after)
    .map((part) => {
      const lines = part.value.replace(/\n$/, "").split("\n");
      if (part.added) return lines.map((l) => chalk.green(`+ ${l}`)).join("\n");
      if (part.removed) return lines.map((l) => chalk.red(`- ${l}`)).join("\n");
      return lines.map((l) => chalk.dim(`  ${l}`)).join("\n");
    })
    .join("\n");
}
