#!/usr/bin/env node
/**
 * Single-file binary packaging (F0, plan/00-foundations).
 *
 * Strategy (see plan/RESEARCH/02): keep TypeScript; ship `bun compile` single-file
 * binaries per platform AND publish to npm with a thin-shim + optionalDependencies.
 * This script drives the bun side.
 *
 * Assets (schema/*.json, templates/*, version) are embedded at build time via
 * scripts/embed-assets.mjs -> packages/cli/src/generated/assets.ts, so the compiled
 * binary is self-contained (no runtime fs reads of bundled assets). Verified:
 * `personaxis --version` and `personaxis validate <persona>` work from the binary.
 *
 * Usage: node scripts/package.mjs [target-name]   (requires `bun` on PATH)
 */

import { execSync } from "node:child_process";
import { mkdirSync } from "node:fs";

const targets = [
  // bun --target triplets; emit per-platform binaries in CI.
  { name: "linux-x64", target: "bun-linux-x64" },
  { name: "linux-arm64", target: "bun-linux-arm64" },
  { name: "darwin-x64", target: "bun-darwin-x64" },
  { name: "darwin-arm64", target: "bun-darwin-arm64" },
  { name: "windows-x64", target: "bun-windows-x64" },
];

mkdirSync("dist-bin", { recursive: true });
const entry = "packages/cli/dist/index.js";
const only = process.argv[2]; // optional single target name

for (const t of targets) {
  if (only && only !== t.name) continue;
  const out = `dist-bin/personaxis-${t.name}`;
  console.log(`> bun build ${entry} --compile --target ${t.target} --outfile ${out}`);
  execSync(`bun build ${entry} --compile --target ${t.target} --outfile ${out}`, {
    stdio: "inherit",
  });
}
console.log("done. NOTE: embed schema/templates assets before shipping (see header).");
