/**
 * `personaxis sign` / `personaxis verify`, the local integrity attestation for a
 * persona spec. `sign` writes personaxis.sig.json (a content hash + deterministic
 * sigil fingerprint over the source personaxis.md); `verify` recomputes it and
 * reports tamper-evidence. This is the free, self-hostable seam that the hosted
 * verifier (the saas) extends into a cryptographically attestable credential
 * other agents can check.
 *
 * verify exit codes (CI gates): 0 verified, 1 mismatch/tampered, 2 error.
 */

import { Command } from "commander";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, basename, relative } from "node:path";
import chalk from "chalk";
import { sigilParams, type PersonaFrontmatter } from "@personaxis/core";
import { loadPersonaFile, type PersonaData } from "../load.js";

const SIG_NAME = "personaxis.sig.json";

export interface PersonaSignature {
  personaxis_sig: "v1";
  canonical_id: string | null;
  display_name: string | null;
  spec_version: string | null;
  content_sha256: string;
  sigil_seed: string;
  signed_at: string;
  source: string;
}

export function contentHash(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

export function buildSignature(data: PersonaData, raw: string, sourceName: string): PersonaSignature {
  const id = (data.identity ?? {}) as { canonical_id?: string; display_name?: string };
  const params = sigilParams(data as unknown as PersonaFrontmatter);
  return {
    personaxis_sig: "v1",
    canonical_id: id.canonical_id ?? null,
    display_name: id.display_name ?? data.metadata?.name ?? null,
    spec_version: data.spec_version ?? null,
    content_sha256: contentHash(raw),
    sigil_seed: (params.seed >>> 0).toString(16).padStart(8, "0"),
    signed_at: new Date().toISOString(),
    source: sourceName,
  };
}

export const signCommand = new Command("sign")
  .description(
    "Sign a persona: write a local integrity attestation (content hash + sigil) that `verify` and the hosted verifier check.",
  )
  .option("--persona <path>", "path to personaxis.md (default: resolve from cwd)")
  .option("--print", "print the signature to stdout instead of writing " + SIG_NAME)
  .action((opts: { persona?: string; print?: boolean }) => {
    const { data, raw, path } = loadPersonaFile(opts.persona);
    const sig = buildSignature(data, raw, basename(path));
    if (opts.print) {
      console.log(JSON.stringify(sig, null, 2));
      return;
    }
    const out = join(dirname(path), SIG_NAME);
    writeFileSync(out, JSON.stringify(sig, null, 2) + "\n", "utf-8");
    const label = sig.display_name ?? sig.canonical_id ?? basename(path);
    console.log(
      `${chalk.green("✓")} signed ${chalk.bold(label)} ` +
        chalk.dim(`(spec ${sig.spec_version ?? "?"}, sigil ${sig.sigil_seed})`),
    );
    console.log(`  ${chalk.dim("sha256")} ${sig.content_sha256}`);
    console.log(`  ${chalk.dim("→")} ${relative(process.cwd(), out)}`);
  });

export const verifyCommand = new Command("verify")
  .description(
    "Verify a persona against its signature (tamper-evidence). Exit 0 verified, 1 mismatch, 2 error.",
  )
  .option("--persona <path>", "path to personaxis.md (default: resolve from cwd)")
  .option("--sig <path>", "signature file (default: " + SIG_NAME + " next to the persona)")
  .action((opts: { persona?: string; sig?: string }) => {
    let loaded;
    try {
      loaded = loadPersonaFile(opts.persona);
    } catch (err) {
      console.error(chalk.red("verify error:"), (err as Error).message);
      process.exit(2);
    }
    const { data, raw, path } = loaded;
    const sigPath = opts.sig ?? join(dirname(path), SIG_NAME);
    if (!existsSync(sigPath)) {
      console.error(
        chalk.red("verify error:"),
        `no signature at ${relative(process.cwd(), sigPath)}. Run 'personaxis sign' first.`,
      );
      process.exit(2);
    }
    let sig: PersonaSignature;
    try {
      sig = JSON.parse(readFileSync(sigPath, "utf-8")) as PersonaSignature;
    } catch {
      console.error(
        chalk.red("verify error:"),
        `signature at ${relative(process.cwd(), sigPath)} is not valid JSON.`,
      );
      process.exit(2);
    }
    const actual = contentHash(raw);
    const id = (data.identity ?? {}) as { canonical_id?: string };
    const contentOk = actual === sig.content_sha256;
    const idOk = !sig.canonical_id || sig.canonical_id === (id.canonical_id ?? null);
    const label = sig.display_name ?? sig.canonical_id ?? basename(path);
    if (contentOk && idOk) {
      console.log(
        `${chalk.green("✓ VERIFIED")} ${chalk.bold(label)} ` + chalk.dim(`(signed ${sig.signed_at})`),
      );
      process.exit(0);
    }
    console.log(`${chalk.red("✗ TAMPERED")} ${chalk.bold(basename(path))}`);
    if (!contentOk) {
      console.log(`  ${chalk.dim("expected sha256")} ${sig.content_sha256}`);
      console.log(`  ${chalk.dim("actual   sha256")} ${actual}`);
    }
    if (!idOk) {
      console.log(`  ${chalk.dim("canonical_id")} ${id.canonical_id ?? "(none)"} != signed ${sig.canonical_id}`);
    }
    process.exit(1);
  });
