#!/usr/bin/env node
// The public docs keep the plain-writing rules that a reader can measure.
//
//   pnpm check-docs-style            # every public markdown file
//   pnpm check-docs-style --control  # proves the check catches what it claims to catch
//
// Only the patterns a program can find are checked: the long dash character, a heading that
// defines a thing by what it is not, and a short list of words that signal filler. What a
// program cannot find (a sentence that says nothing, a claim with no number) stays a matter
// for review.
//
// The control exists because a gate that cannot fail is worse than no gate: it plants each
// pattern in a sample and fails if the check does not report it.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const EM_DASH = String.fromCharCode(0x2014);

/** Words that signal filler in documentation. A literal use is rare enough to rephrase. */
const BANNED = ["delve", "seamless", "seamlessly", "tapestry", "holistic", "game-changer", "cutting-edge", "supercharge", "unlock the power"];

/** A heading that defines something by negation. */
const NEGATED_HEADING = /^#{1,6}\s+(what (this|it) is not|not to be confused with)\b/i;

/** The findings in one markdown text, ignoring fenced code blocks. */
export function findings(text) {
  const out = [];
  let fenced = false;
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*```/.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    if (line.includes(EM_DASH)) out.push({ line: i + 1, why: "the long dash character" });
    if (NEGATED_HEADING.test(line)) out.push({ line: i + 1, why: "a heading that defines by negation" });
    const lower = line.toLowerCase();
    for (const word of BANNED) {
      if (new RegExp(`\\b${word}\\b`).test(lower)) out.push({ line: i + 1, why: `the word "${word}"` });
    }
  }
  return out;
}

function control() {
  const planted = [
    ["a long dash", `text ${EM_DASH} more`],
    ["a negated heading", "## What this is not"],
    ["a banned word", "A seamless experience."],
  ];
  let failed = false;
  for (const [name, sample] of planted) {
    if (findings(sample).length === 0) {
      console.error(`control FAILED: the check did not catch ${name}.`);
      failed = true;
    }
  }
  const fencedSample = "```\n" + `text ${EM_DASH} more` + "\n```";
  if (findings(fencedSample).length !== 0) {
    console.error("control FAILED: the check reported something inside a fenced code block.");
    failed = true;
  }
  if (failed) process.exit(1);
  console.log("control: each planted pattern is caught, and fenced code is ignored.");
}

const SKIP = new Set(["node_modules", "dist", ".git", "coverage", "generated"]);

function markdownFiles(dir, acc = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const full = join(dir, name);
    const stat = statSync(full);
    if (stat.isDirectory()) markdownFiles(full, acc);
    else if (name.endsWith(".md")) acc.push(full);
  }
  return acc;
}

function main() {
  // docs/security is private (gitignored), so it is not part of what is published.
  const files = [
    join(ROOT, "README.md"),
    ...markdownFiles(join(ROOT, "docs")).filter((f) => !relative(ROOT, f).split(sep).includes("security")),
    ...readdirSync(join(ROOT, "packages")).flatMap((p) => {
      const readme = join(ROOT, "packages", p, "README.md");
      try {
        statSync(readme);
        return [readme];
      } catch {
        return [];
      }
    }),
  ];
  let total = 0;
  for (const file of files) {
    for (const f of findings(readFileSync(file, "utf8"))) {
      console.error(`${relative(ROOT, file)}:${f.line}: ${f.why}`);
      total++;
    }
  }
  if (total > 0) {
    console.error(`\ndocs style: ${total} finding(s) in ${files.length} files.`);
    process.exit(1);
  }
  console.log(`docs style: ${files.length} public markdown files, no findings.`);
}

if (process.argv.includes("--control")) control();
else main();
