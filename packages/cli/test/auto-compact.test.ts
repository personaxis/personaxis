import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { maybeAutoCompact } from "../src/repl/turn.js";

// Hermetic: no model resolvable, so the auto-compact guard must no-op even when
// the meter is over the threshold (the real summarize path needs an llm and is
// exercised against a live model separately).
let saved: string | undefined;
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pxs-ac-"));
  saved = process.env.PERSONAXIS_HOME;
  process.env.PERSONAXIS_HOME = join(dir, "home");
});
afterEach(() => {
  if (saved === undefined) delete process.env.PERSONAXIS_HOME;
  else process.env.PERSONAXIS_HOME = saved;
});

function fakeCtx(pct: number) {
  const personaPath = join(dir, "personaxis.md");
  writeFileSync(personaPath, "---\nidentity: { canonical_id: t, display_name: T }\n---\n");
  const conversation = [
    { role: "user", content: "a" },
    { role: "assistant", content: "b" },
  ];
  const out: string[] = [];
  return {
    ctx: {
      handle: { personaPath, frontmatter: { identity: { canonical_id: "t" } }, statePath: join(dir, "state.json") },
      meter: { pct },
      conversation,
      out: (s: string) => out.push(s),
      sessionId: "s1",
    } as never,
    conversation,
    out,
  };
}

describe("maybeAutoCompact (V2-F3.A3)", () => {
  it("no-ops with no model even above threshold", async () => {
    const { ctx, conversation } = fakeCtx(0.99);
    await maybeAutoCompact(ctx, 0.85);
    expect(conversation).toHaveLength(2); // untouched
  });

  it("no-ops below threshold", async () => {
    const { ctx, conversation } = fakeCtx(0.1);
    await maybeAutoCompact(ctx, 0.85);
    expect(conversation).toHaveLength(2);
  });
});
