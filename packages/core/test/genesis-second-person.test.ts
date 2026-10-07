/**
 * The compiled document speaks to the persona in the second person, so a self-concept written about it in
 * the third person ("Her claims are...") does not belong in it.
 *
 * Seen on 2026-10-03 (E176): the extractor wrote Clio's self-concept in the third person and the document
 * copied it under "Who you are". The extractor is told to write in the second person; when it does not,
 * the sentence is left out and the creation report says why, instead of reaching the model.
 */
import { describe, it, expect } from "vitest";
import { buildExtractionPrompt, seedFromExtraction, genesis, renderCreationReport, assemblePersonaDoc } from "../src/index.js";

function build(selfConcept: string, displayName = "Clio") {
  const { seed, evidence } = seedFromExtraction(
    { displayName, role: "maintainer", purpose: "Keep the CLI honest.", selfConcept },
    "brief",
  );
  return genesis([{ label: "brief", seed, evidence }]);
}

function doc(r: ReturnType<typeof build>): string {
  return assemblePersonaDoc({ persona: r.spec, target: { name: "Clio", isSubagent: false, resourceBase: "./.personaxis/" } });
}

describe("self-concept in the compiled document", () => {
  it("the extractor is asked for the second person", () => {
    expect(buildExtractionPrompt("x", "brief")).toMatch(/selfConcept[^\n]*second person/i);
  });

  for (const third of [
    "Her claims are always backed by a command she ran.",
    "She treats every number as a claim to verify.",
    "They never publish what they have not measured.",
    "Clio sees herself as the keeper of the record.",
  ]) {
    it(`leaves out a third-person self-concept: "${third.slice(0, 30)}..."`, () => {
      const r = build(third);
      expect(doc(r)).not.toContain(third);
      expect(renderCreationReport(r, [])).toMatch(/third person/i);
    });
  }

  it("keeps a second-person self-concept", () => {
    const r = build("You treat every number as a claim to verify.");
    expect(doc(r)).toContain("You treat every number as a claim to verify.");
  });

  for (const second of ["Theory without a command run is a guess to you.", "It matters to you that every claim is checked."]) {
    it(`keeps a sentence that only starts like a pronoun: "${second.slice(0, 30)}..."`, () => {
      expect(doc(build(second))).toContain(second);
    });
  }
});
