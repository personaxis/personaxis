import { describe, it, expect } from "vitest";
import { LlmResponder, ReflectiveResponder } from "../src/index.js";

const input = { message: "hi", personaBody: "id", memory: [], state: {}, name: "T" };

function fetchReturning(impl: () => unknown): typeof fetch {
  return (async () => impl()) as unknown as typeof fetch;
}

describe("LlmResponder error handling", () => {
  it("returns guidance (not '…') on an empty reply", async () => {
    const r = new LlmResponder({
      endpoint: "http://x/v1",
      model: "m",
      fetchImpl: fetchReturning(() => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: "" } }] }) })),
    });
    const out = await r.respond(input);
    expect(out).toMatch(/empty reply/);
  });

  it("throws a clear error on a non-JSON body", async () => {
    const r = new LlmResponder({
      endpoint: "http://x/v1",
      model: "m",
      fetchImpl: fetchReturning(() => ({
        ok: true,
        status: 200,
        json: async () => {
          throw new Error("Unexpected token");
        },
      })),
    });
    await expect(r.respond(input)).rejects.toThrow(/non-JSON/);
  });

  it("returns the model content on success", async () => {
    const r = new LlmResponder({
      endpoint: "http://x/v1",
      model: "m",
      fetchImpl: fetchReturning(() => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: "  hello  " } }] }) })),
    });
    expect(await r.respond(input)).toBe("hello");
  });
});

describe("ReflectiveResponder (offline)", () => {
  it("acknowledges honestly and points to enabling a model", async () => {
    const out = await new ReflectiveResponder().respond(input);
    expect(out).toMatch(/PERSONAXIS_ENDPOINT/);
  });
});
