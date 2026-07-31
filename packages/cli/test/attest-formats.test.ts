/**
 * V4.1 / V6.9: the behavioral credential in the stack's own formats. The VC is
 * a well-formed W3C Verifiable Credential 2.0 envelope; the A2A output is a
 * well-formed AgentCapabilities.extensions[] entry. Both carry the SAME claims
 * the local attest file holds (single source: buildAttestation).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeStarterPersona } from "../src/starter.js";
import { loadPersonaFile } from "../src/load.js";
import { buildAttestation, toVerifiableCredential, toA2aExtension } from "../src/commands/attest.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pxs-attest-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function mint() {
  const path = writeStarterPersona(dir, "Vega");
  const { data, raw } = loadPersonaFile(path);
  return { att: buildAttestation(data as Record<string, unknown>, raw, path, 24), path };
}

describe("attest --format vc (W3C Verifiable Credential 2.0)", () => {
  it("emits a well-formed VC carrying the attestation claims", () => {
    const { att } = mint();
    const vc = toVerifiableCredential(att, "Vega") as Record<string, any>;
    expect(vc["@context"][0]).toBe("https://www.w3.org/ns/credentials/v2");
    expect(vc.type).toContain("VerifiableCredential");
    expect(vc.type).toContain("PersonaBehavioralAttestation");
    expect(vc.validFrom).toBe(att.attested_at);
    expect(vc.validUntil).toBe(att.expires_at);
    const subj = vc.credentialSubject;
    expect(subj.contentSha256).toBe(att.signature.content_sha256);
    expect(subj.behavior.withinThresholds).toBe(att.behavior.within_thresholds);
    expect(subj.behavior.memoryChainIntact).toBe(att.behavior.chain_ok);
    expect(vc.proof.type).toBe("DataIntegrityProof");
    expect(typeof vc.proof.proofValue).toBe("string");
  });
});

describe("attest --format a2a (Agent Card extension)", () => {
  it("emits a well-formed AgentCapabilities.extensions entry", () => {
    const { att } = mint();
    const ext = toA2aExtension(att, "Vega") as Record<string, any>;
    expect(ext.uri).toBe("https://personaxis.com/ext/attestation/v1");
    expect(ext.required).toBe(false);
    expect(ext.params.contentSha256).toBe(att.signature.content_sha256);
    expect(ext.params.withinThresholds).toBe(att.behavior.within_thresholds);
    expect(ext.params.expiresAt).toBe(att.expires_at);
    expect(typeof ext.description).toBe("string");
  });
});
