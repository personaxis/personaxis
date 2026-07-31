import { describe, it, expect } from "vitest";
import { renderStatusline } from "../src/statusline.js";

describe("renderStatusline (V2-F3.D20)", () => {
  it("fills {key} placeholders from vars", () => {
    const out = renderStatusline("{persona} · {model} · drift {drift}", {
      persona: "Clio",
      model: "command-a",
      drift: 0.12,
    });
    expect(out).toBe("Clio · command-a · drift 0.12");
  });

  it("renders a missing key as empty", () => {
    expect(renderStatusline("{persona}{missing}", { persona: "X" })).toBe("X");
  });

  it("leaves non-placeholder text intact", () => {
    expect(renderStatusline("no placeholders here", {})).toBe("no placeholders here");
  });
});
