// Cross-repo spec mirror (F5.1), replaces the manual `cp` steps in CLAUDE.md.
//
// The single source of truth for the schemas is `@personaxis/spec`
// (`packages/spec/schema/`) and for the canonical templates is
// `packages/cli/templates/`. The sibling persona.md spec repo keeps a
// byte-identical mirror (its own docs/tooling read it). SPEC.md flows the OTHER
// way: it is AUTHORED in persona.md and mirrored INTO the CLI (embedded so
// `personaxis spec` prints it).
//
// Usage (from the cli repo root):
//   node scripts/sync-spec-mirror.mjs            # copy source -> mirror (writes)
//   node scripts/sync-spec-mirror.mjs --check    # verify only; exit 1 on drift (CI)
//   PERSONA_MD_DIR=../persona.md node scripts/sync-spec-mirror.mjs
//
// The CI byte-identity gate (.github/workflows/ci.yml) is the enforcement; this
// script is the one-command way to make them match (or to check that they do).

import { readFileSync, existsSync, copyFileSync, mkdirSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

const CLI_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PERSONA_MD = resolve(CLI_ROOT, process.env.PERSONA_MD_DIR ?? "../persona.md");

// Each pair: [source of truth, mirror]. `dir` tags the flow direction for logs.
const MIRRORS = [
  // Schemas: @personaxis/spec is canonical -> persona.md mirror.
  ["packages/spec/schema/persona.schema.json", "schema/persona.schema.json", "spec→persona.md"],
  ["packages/spec/schema/policy.schema.json", "schema/policy.schema.json", "spec→persona.md"],
  ["packages/spec/schema/state.schema.json", "schema/state.schema.json", "spec→persona.md"],
  ["packages/spec/schema/memory.schema.json", "schema/memory.schema.json", "spec→persona.md"],
  ["packages/spec/schema/legacy/persona-0.10.schema.json", "schema/legacy/persona-0.10.schema.json", "spec→persona.md"],
  // Canonical templates: cli is canonical -> persona.md mirror.
  ["packages/cli/templates/personaxis_template.md", ".personaxis/personaxis_template.md", "cli→persona.md"],
  ["packages/cli/templates/PERSONA_template.md", "PERSONA_template.md", "cli→persona.md"],
  ["packages/cli/templates/policy_template.yaml", ".personaxis/policy_template.yaml", "cli→persona.md"],
];

// SPEC.md is authored in persona.md and mirrored INTO the cli (reverse flow).
const REVERSE = [["docs/SPEC.md", "packages/cli/SPEC.md", "persona.md→cli"]];

const check = process.argv.includes("--check");

if (!existsSync(PERSONA_MD)) {
  console.error(`persona.md repo not found at ${PERSONA_MD}. Set PERSONA_MD_DIR or clone it side-by-side.`);
  process.exit(check ? 0 : 1); // in --check (CI) a missing sibling is a skip, not a failure
}

let drift = 0;
let synced = 0;

function handle(srcAbs, destAbs, label) {
  if (!existsSync(srcAbs)) {
    console.error(`::error::source missing: ${srcAbs}`);
    drift++;
    return;
  }
  const src = readFileSync(srcAbs);
  const same = existsSync(destAbs) && Buffer.compare(src, readFileSync(destAbs)) === 0;
  if (same) return;
  if (check) {
    console.error(`::error::mirror drift (${label}): ${destAbs} differs from ${srcAbs}`);
    drift++;
  } else {
    mkdirSync(dirname(destAbs), { recursive: true });
    copyFileSync(srcAbs, destAbs);
    console.log(`synced (${label}): ${destAbs}`);
    synced++;
  }
}

for (const [src, dest, label] of MIRRORS) handle(join(CLI_ROOT, src), join(PERSONA_MD, dest), label);
for (const [src, dest, label] of REVERSE) handle(join(PERSONA_MD, src), join(CLI_ROOT, dest), label);

if (check) {
  if (drift > 0) {
    console.error(`\n${drift} mirror file(s) out of sync. Run \`pnpm run sync-mirror\` and commit.`);
    process.exit(1);
  }
  console.log("spec mirror is byte-identical across cli ↔ persona.md ✓");
} else {
  console.log(synced === 0 ? "spec mirror already byte-identical ✓" : `\n${synced} file(s) synced.`);
}
