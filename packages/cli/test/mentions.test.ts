import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expandFileMentions } from "../src/repl/mentions.js";

describe("expandFileMentions (V2-F3.A5 @files)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pxs-mentions-"));
  });

  it("inlines an existing @file's content", () => {
    writeFileSync(join(dir, "notes.txt"), "hello from file");
    const out = expandFileMentions("summarize @notes.txt", dir);
    expect(out).toContain("summarize @notes.txt");
    expect(out).toContain('<file path="notes.txt">');
    expect(out).toContain("hello from file");
  });

  it("leaves a non-file @mention (persona slug) untouched", () => {
    const out = expandFileMentions("hey @cmo what's up", dir);
    expect(out).toBe("hey @cmo what's up");
  });

  it("truncates a file over the byte cap", () => {
    writeFileSync(join(dir, "big.txt"), "x".repeat(50));
    const out = expandFileMentions("see @big.txt", dir, 10);
    expect(out).toContain("(truncated)");
  });

  it("expands each file once even if mentioned twice", () => {
    writeFileSync(join(dir, "a.txt"), "AAA");
    const out = expandFileMentions("@a.txt vs @a.txt", dir);
    expect(out.match(/<file path="a.txt">/g)?.length).toBe(1);
  });
});
