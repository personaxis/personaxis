import { describe, it, expect } from "vitest";
import { LlmResponder, ReflectiveResponder } from "../src/index.js";

const input = { message: "hi", personaBody: "id", memory: [], state: {}, name: "T" };

function fetchReturning(impl: () => unknown): typeof fetch {
  return (async () => impl()) as unknown as typeof fetch;
}

function sseStream(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const ch of chunks) controller.enqueue(enc.encode(ch));
      controller.close();
    },
  });
}

describe("LlmResponder streaming (V2-F3.E23)", () => {
  it("streams deltas via onToken and returns the full text", async () => {
    const body = sseStream([
      'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"lo"}}]}\n\n',
      "data: [DONE]\n\n",
    ]);
    const r = new LlmResponder({
      endpoint: "http://x/v1",
      model: "m",
      fetchImpl: fetchReturning(() => ({ ok: true, status: 200, body })),
    });
    const tokens: string[] = [];
    const full = await r.respond({ ...input, onToken: (t) => tokens.push(t) });
    expect(tokens).toEqual(["Hel", "lo"]);
    expect(full).toBe("Hello");
  });

  it("buffers (no stream) when onToken is absent", async () => {
    const r = new LlmResponder({
      endpoint: "http://x/v1",
      model: "m",
      fetchImpl: fetchReturning(() => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: "buffered" } }] }) })),
    });
    expect(await r.respond(input)).toBe("buffered");
  });
});

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
