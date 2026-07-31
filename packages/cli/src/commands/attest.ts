/**
 * `personaxis attest`, the LOCAL behavioral credential (V3.3, tesis v3).
 *
 * `sign` attests the spec's bytes; `attest` attests the BEHAVIOR around them:
 * the same content signature PLUS the current drift report (global D and each
 * layer against the governance thresholds), the tamper-evident memory-chain
 * head, and the mutation count, with an expiry. `attest --check` re-derives all
 * of it and answers the v3 question, "is this persona still provably who it
 * declares, within its declared bounds?". Exit 0 live / 1 not live (tampered,
 * over thresholds, chain broken, expired) / 2 error. This is the engine seam
 * the hosted attestation service (Product 2) extends with cryptographic
 * signing, revocation, and a public verification endpoint (doc 10 v3).
 */

import { Command } from "commander";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, basename, relative } from "node:path";
import chalk from "chalk";
import {
  loadPersona,
  ensureState,
  extractEnvelopes,
  driftReport,
  readMaxStepDelta,
  readDriftThresholds,
  verifyMemoryChain,
  readMemory,
} from "@personaxis/core";
import { loadPersonaFile } from "../load.js";
import { validatePersona } from "../schema.js";
import { buildSignature, contentHash, type PersonaSignature } from "./sign.js";

const ATTEST_NAME = "personaxis.attest.json";

interface BehaviorSnapshot {
  drift_global: number;
  layers: Array<{ layer: string; drift: number; threshold?: number; exceeded: boolean }>;
  within_thresholds: boolean;
  chain_ok: boolean;
  chain_length: number;
  chain_head: string | null;
  mutations: number;
}

export interface PersonaAttestation {
  personaxis_attest: "v1";
  signature: PersonaSignature;
  behavior: BehaviorSnapshot;
  attested_at: string;
  expires_at: string;
}

/**
 * V4.1 (V6.9): the credential in the formats the agent stack already parses.
 *
 * W3C Verifiable Credential (Data Model 2.0): the attestation claims as a
 * `credentialSubject`, `validFrom`/`validUntil` from the local expiry. The LOCAL
 * mint is self-issued and carries a re-derivable integrity value (the same
 * sha-256 surface `attest --check` re-verifies); the hosted attestation service
 * replaces issuer + proof with a KMS-signed Data Integrity proof and a public
 * verification endpoint (doc 10, product 3).
 */
export function toVerifiableCredential(att: PersonaAttestation, label: string): Record<string, unknown> {
  return {
    "@context": ["https://www.w3.org/ns/credentials/v2", "https://personaxis.com/credentials/attestation/v1"],
    type: ["VerifiableCredential", "PersonaBehavioralAttestation"],
    issuer: "urn:personaxis:local-issuer",
    validFrom: att.attested_at,
    validUntil: att.expires_at,
    credentialSubject: {
      id: `urn:personaxis:persona:${att.signature.sigil_seed}`,
      name: label,
      specVersion: att.signature.spec_version ?? null,
      contentSha256: att.signature.content_sha256,
      behavior: {
        driftGlobal: att.behavior.drift_global,
        withinThresholds: att.behavior.within_thresholds,
        layers: att.behavior.layers,
        memoryChainIntact: att.behavior.chain_ok,
        memoryChainLength: att.behavior.chain_length,
        memoryChainHead: att.behavior.chain_head,
        mutations: att.behavior.mutations,
      },
    },
    proof: {
      type: "DataIntegrityProof",
      cryptosuite: "personaxis-local-rederivation-v1",
      created: att.attested_at,
      proofPurpose: "assertionMethod",
      verificationMethod: "personaxis attest --check",
      proofValue: contentHash(JSON.stringify({ signature: att.signature, behavior: att.behavior })),
    },
  };
}

/**
 * V4.1 (V6.9): the same claims as an A2A Agent Card extension (A2A v1.0
 * `AgentCapabilities.extensions[]` entry), so any host that parses signed Agent
 * Cards can carry the behavioral attestation without knowing personaxis.
 */
export function toA2aExtension(att: PersonaAttestation, label: string): Record<string, unknown> {
  return {
    uri: "https://personaxis.com/ext/attestation/v1",
    description:
      "Personaxis behavioral attestation: this persona is provably who it declares, within its declared bounds (drift within thresholds, tamper-evident history).",
    required: false,
    params: {
      persona: label,
      specVersion: att.signature.spec_version ?? null,
      contentSha256: att.signature.content_sha256,
      driftGlobal: att.behavior.drift_global,
      withinThresholds: att.behavior.within_thresholds,
      memoryChainIntact: att.behavior.chain_ok,
      mutations: att.behavior.mutations,
      attestedAt: att.attested_at,
      expiresAt: att.expires_at,
      verification: "personaxis attest --check (local) or the hosted verification endpoint",
    },
  };
}

/** Mint the raw attestation object (exported for the format emitters + tests). */
export function buildAttestation(
  data: Record<string, unknown>,
  raw: string,
  path: string,
  ttlHours: number,
): PersonaAttestation {
  const attestedAt = new Date();
  return {
    personaxis_attest: "v1",
    signature: buildSignature(data, raw, basename(path)),
    behavior: snapshotBehavior(path),
    attested_at: attestedAt.toISOString(),
    expires_at: new Date(attestedAt.getTime() + ttlHours * 3_600_000).toISOString(),
  };
}

function snapshotBehavior(personaPath: string): BehaviorSnapshot {
  const handle = loadPersona(personaPath);
  const fm = handle.frontmatter as Record<string, unknown>;
  // A fresh persona without state.json attests at its canonical baseline (V6.9:
  // minting must not fail on a just-created persona).
  const st = ensureState(handle);
  const env = extractEnvelopes(handle.frontmatter);
  const report = driftReport({
    values: st.values,
    envelopes: env.envelopes,
    maxStepDelta: readMaxStepDelta(fm),
    thresholds: readDriftThresholds(fm),
    protectedFields: env.protectedFields,
  });
  const chain = verifyMemoryChain(handle.personaPath);
  const entries = readMemory(handle.personaPath);
  const last = entries[entries.length - 1] as { hash?: string } | undefined;
  return {
    drift_global: Number(report.global.toFixed(6)),
    layers: report.layers.map((l) => ({
      layer: l.layer,
      drift: Number(l.drift.toFixed(6)),
      ...(l.threshold !== undefined ? { threshold: l.threshold } : {}),
      exceeded: l.exceeded,
    })),
    within_thresholds: report.layers.every((l) => !l.exceeded),
    chain_ok: chain.ok,
    chain_length: entries.length,
    chain_head: last?.hash ?? null,
    mutations: st.mutation_log.length,
  };
}

export const attestCommand = new Command("attest")
  .description(
    "Mint (or --check) the local behavioral credential: spec signature + drift within thresholds + tamper-evident chain, with expiry. The hosted attestation service extends this seam.",
  )
  .option("--persona <path>", "path to personaxis.md (default: resolve from cwd)")
  .option("--ttl <hours>", "credential lifetime in hours", "24")
  .option("--print", "print the attestation to stdout instead of writing " + ATTEST_NAME)
  .option("--check", "validate the existing attestation (exit 0 live / 1 not live / 2 error)")
  .option(
    "--format <fmt>",
    "output format: json (default, the local file) | vc (W3C Verifiable Credential 2.0) | a2a (A2A Agent Card extension), vc/a2a print to stdout",
    "json",
  )
  .action((opts: { persona?: string; ttl?: string; print?: boolean; check?: boolean; format?: string }) => {
    let loaded;
    try {
      loaded = loadPersonaFile(opts.persona);
    } catch (err) {
      console.error(chalk.red("attest error:"), (err as Error).message);
      process.exit(2);
    }
    const { data, raw, path } = loaded;
    const label =
      ((data.identity ?? {}) as { display_name?: string }).display_name ?? basename(path);

    if (opts.check) {
      const attPath = join(dirname(path), ATTEST_NAME);
      if (!existsSync(attPath)) {
        console.error(
          chalk.red("attest error:"),
          `no attestation at ${relative(process.cwd(), attPath)}. Run 'personaxis attest' first.`,
        );
        process.exit(2);
      }
      let att: PersonaAttestation;
      try {
        att = JSON.parse(readFileSync(attPath, "utf-8")) as PersonaAttestation;
      } catch {
        console.error(chalk.red("attest error:"), `${relative(process.cwd(), attPath)} is not valid JSON.`);
        process.exit(2);
      }
      // Re-derive every claim NOW; the credential is only worth anything live.
      const now = snapshotBehavior(path);
      const sigOk = contentHash(raw) === att.signature.content_sha256;
      const fresh = Date.now() <= Date.parse(att.expires_at);
      const mark = (ok: boolean, label2: string, detail: string): void =>
        console.log(`  ${ok ? chalk.green("✓") : chalk.red("✗")} ${label2.padEnd(10)} ${detail}`);
      mark(sigOk, "signature", sigOk ? "content sha256 matches" : "spec bytes CHANGED since attestation");
      mark(
        now.within_thresholds,
        "drift",
        `D ${now.drift_global.toFixed(3)}` +
          (now.within_thresholds
            ? " within all thresholds"
            : `  over: ${now.layers.filter((l) => l.exceeded).map((l) => l.layer).join(", ")}`),
      );
      mark(now.chain_ok, "chain", now.chain_ok ? `intact (${now.chain_length} entries)` : "BROKEN");
      mark(fresh, "freshness", fresh ? `expires ${att.expires_at}` : `EXPIRED ${att.expires_at}, re-run 'personaxis attest'`);
      const live = sigOk && now.within_thresholds && now.chain_ok && fresh;
      console.log(
        live
          ? chalk.green(`⛨ ATTESTATION LIVE`) + `  ${chalk.bold(label)}`
          : chalk.bgRed.whiteBright(` ⛨ ATTESTATION NOT LIVE `) + `  ${chalk.bold(label)}`,
      );
      process.exit(live ? 0 : 1);
    }

    // Mint. A credential over an invalid persona would be worthless: validate first.
    const v = validatePersona(data as Record<string, unknown>);
    if (!v.valid) {
      console.error(chalk.red("attest error:"), `persona does not validate (${v.status}); fix it before attesting.`);
      process.exit(2);
    }
    const parsedTtl = Number(opts.ttl ?? "24");
    const ttlHours = Number.isFinite(parsedTtl) && parsedTtl >= 0 ? parsedTtl : 24;
    const att = buildAttestation(data as Record<string, unknown>, raw, path, ttlHours);
    // V4.1: interop formats always go to stdout (pipe them wherever the stack needs them).
    const fmt = (opts.format ?? "json").toLowerCase();
    if (fmt === "vc") {
      console.log(JSON.stringify(toVerifiableCredential(att, label), null, 2));
      return;
    }
    if (fmt === "a2a") {
      console.log(JSON.stringify(toA2aExtension(att, label), null, 2));
      return;
    }
    if (fmt !== "json") {
      console.error(chalk.red("attest error:"), `unknown --format "${opts.format}"; use json | vc | a2a.`);
      process.exit(2);
    }
    if (opts.print) {
      console.log(JSON.stringify(att, null, 2));
      return;
    }
    const out = join(dirname(path), ATTEST_NAME);
    writeFileSync(out, JSON.stringify(att, null, 2) + "\n", "utf-8");
    const b = att.behavior;
    console.log(
      `${chalk.green("✓")} attested ${chalk.bold(label)} ` +
        chalk.dim(`(spec ${att.signature.spec_version ?? "?"}, sigil ${att.signature.sigil_seed})`),
    );
    console.log(
      `  ${chalk.dim("drift")}  D ${b.drift_global.toFixed(3)} ${b.within_thresholds ? chalk.green("within thresholds") : chalk.red("OVER THRESHOLDS")}` +
        chalk.dim(`  ·  chain ${b.chain_ok ? "intact" : "BROKEN"} (${b.chain_length})  ·  mutations ${b.mutations}`),
    );
    console.log(`  ${chalk.dim("expires")} ${att.expires_at}`);
    console.log(`  ${chalk.dim("→")} ${relative(process.cwd(), out)}`);
    if (!b.within_thresholds || !b.chain_ok) {
      console.log(chalk.yellow("  ! minted with failing claims; 'attest --check' will report NOT LIVE until resolved."));
    }
  });
