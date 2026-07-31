import { describe, it, expect } from "vitest";
import { buildCard, renderCardText } from "../src/commands/card.js";

const data = {
  spec_version: "1.1.0",
  identity: { display_name: "Clio", canonical_id: "clio", role_identity: { primary_role: "CLI toolchain" } },
};

describe("persona card (V2-F4.3c)", () => {
  it("builds a card with stats and a deterministic sigil seed", () => {
    const raw = "hello persona spec";
    const card = buildCard(data, raw, "/nope/personaxis.md");
    expect(card.name).toBe("Clio");
    expect(card.role).toBe("CLI toolchain");
    expect(card.specVersion).toBe("1.1.0");
    expect(card.sigilSeed).toMatch(/^[0-9a-f]{8}$/);
    expect(card.glyph.length).toBeGreaterThan(0);
    expect(card.contentSha256).toHaveLength(64);
    // deterministic: same spec → same seed
    expect(buildCard(data, raw, "/nope/personaxis.md").sigilSeed).toBe(card.sigilSeed);
  });

  it("renders a text card containing the name and stats", () => {
    const card = buildCard(data, "x", "/nope/personaxis.md");
    const text = renderCardText(card);
    expect(text).toContain("Clio");
    expect(text).toContain("spec 1.1.0");
    expect(text).toContain("personaxis");
  });
});
