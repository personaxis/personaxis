/**
 * What Genesis writes into a persona is in the source, or it is left out and the report says so.
 *
 * Measured 2026-10-07 rebuilding Clio on command-a-03-2025 from a brief that quotes nothing she says: the
 * extractor returned a voice exemplar announcing a command that does not exist ("`personaxis extract` now
 * includes a new flag `--verbose`") and claiming "I have tested this", and the compiled document taught it
 * as her voice. The same run returned trait names in CamelCase, which became `attentiontodetail`, and the
 * document opened "Who you are" with the builder's own "Created via personaxis create on <date>".
 */
import { describe, it, expect } from "vitest";
import { extractSeed, genesis, renderCreationReport, assemblePersonaDoc, type StructuredCaller } from "../src/index.js";

const BRIEF =
  "Clio maintains the personaxis CLI. She reviews each change against the tests and the docs, never claims a result she has not run, and when asked whether something works she answers: \"I ran the suite; 1305 of 1305 pass. I did not check Windows.\"";

const INVENTED = "The command `personaxis extract` now includes a new flag `--verbose`. I have tested this.";
const QUOTED = "I ran the suite; 1305 of 1305 pass. I did not check Windows.";

function caller(extra: Record<string, unknown>): StructuredCaller {
  return async () => ({ displayName: "Clio", role: "maintainer", purpose: "Keep the CLI honest.", ...extra });
}

async function build(extra: Record<string, unknown>) {
  const { seed, evidence } = await extractSeed(BRIEF, "prompt", caller(extra));
  return genesis([{ label: "prompt", seed, evidence }]);
}

function doc(r: Awaited<ReturnType<typeof build>>): string {
  return assemblePersonaDoc({ persona: r.spec, target: { name: "Clio", isSubagent: false, resourceBase: "./.personaxis/" } });
}

describe("voice exemplars", () => {
  it("leaves out an exemplar the material does not contain, and says so in the report", async () => {
    const r = await build({ voiceExemplars: [{ persona: INVENTED }] });
    expect((r.spec.persona as { voice_exemplars?: unknown[] }).voice_exemplars).toBeUndefined();
    expect(doc(r)).not.toContain("personaxis extract");
    expect(renderCreationReport(r, [])).toMatch(/not in the material/i);
  });

  it("keeps an exemplar the material quotes", async () => {
    const r = await build({ voiceExemplars: [{ persona: QUOTED }, { persona: INVENTED }] });
    const kept = (r.spec.persona as { voice_exemplars?: Array<{ persona: string }> }).voice_exemplars ?? [];
    expect(kept.map((e) => e.persona)).toEqual([QUOTED]);
  });
});

describe("names", () => {
  it("splits a CamelCase trait name into words", async () => {
    const r = await build({ traits: [{ name: "AttentionToDetail", mean: 0.8, evidence: "reviews each change" }] });
    const traits = (r.spec.personality as { traits: Record<string, unknown> }).traits;
    expect(traits.attention_to_detail).toBeDefined();
    expect(traits.attentiontodetail).toBeUndefined();
  });
});

describe("origin", () => {
  it("is not filled with the date of creation when the source gives none", async () => {
    const r = await build({});
    const narrative = (r.spec.identity as { narrative_identity?: { origin?: string } }).narrative_identity;
    expect(narrative?.origin).toBeUndefined();
    expect(doc(r)).not.toMatch(/Created via personaxis create/);
  });

  it("keeps an origin the source gives", async () => {
    const r = await build({ origin: "Started as the validator for the persona.md spec." });
    expect(doc(r)).toContain("Started as the validator for the persona.md spec.");
  });
});
