import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv from "ajv";
import addFormats from "ajv-formats";
import { prepareMemoryEntry } from "@personaxis/core";

const here = dirname(fileURLToPath(import.meta.url));
const memorySchema = JSON.parse(readFileSync(join(here, "..", "schema", "memory.schema.json"), "utf-8"));

const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);
const validate = ajv.compile(memorySchema);

describe("v0.8 episodic-memory entry schema conformance", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pxs-mem-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("the runtime's prepared entry conforms to memory.schema.json", () => {
    const entry = prepareMemoryEntry(join(dir, "personaxis.md"), {
      content: "the user prefers strict typescript",
      source: "user",
      tags: ["episode", "user"],
    });
    expect(validate(entry)).toBe(true);
    expect(entry.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("rejects an entry with a bad source", () => {
    const ok = validate({
      ts: new Date().toISOString(),
      content: "x",
      source: "external", // not in the enum
      tags: [],
      prev_hash: "",
      hash: "a".repeat(64),
    });
    expect(ok).toBe(false);
  });
});
