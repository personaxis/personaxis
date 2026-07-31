import { describe, it, expect, beforeAll } from "vitest";
import chalk from "chalk";
import { renderMarkdown, renderInlineMarkdown } from "../src/repl/render.js";

// Deterministic, color-agnostic: with styling disabled the markers are stripped.
beforeAll(() => {
  chalk.level = 0;
});

describe("renderMarkdown (E22 markdown render)", () => {
  it("strips inline markers", () => {
    expect(renderInlineMarkdown("**bold**")).toBe("bold");
    expect(renderInlineMarkdown("a `code` b")).toBe("a code b");
    expect(renderInlineMarkdown("_em_")).toBe("em");
    expect(renderInlineMarkdown("plain text")).toBe("plain text");
  });

  it("renders headers, bullets and numbered lists", () => {
    expect(renderMarkdown("# Title")).toBe("Title");
    expect(renderMarkdown("## Sub **x**")).toBe("Sub x");
    expect(renderMarkdown("- item")).toContain("• item");
    expect(renderMarkdown("1. first")).toContain("1. first");
  });

  it("drops code fences but keeps their content", () => {
    const out = renderMarkdown("```js\nconst x = 1;\n```");
    expect(out).not.toContain("```");
    expect(out).toContain("const x = 1;");
  });

  it("preserves multi-line structure", () => {
    expect(renderMarkdown("a\nb").split("\n")).toHaveLength(2);
  });
});
