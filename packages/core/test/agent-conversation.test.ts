import { describe, it, expect } from "vitest";
import { PersonaAgent, type ChatMessage } from "../src/index.js";

/**
 * Regression guard for the multi-turn bug: a plain-text reply MUST be persisted into the
 * transcript (`lastMessages`), otherwise the next turn sees only the stacked user questions
 * and re-answers them all.
 */
function stubLlm(reply: string) {
  const fetchImpl = (async () =>
    new Response(JSON.stringify({ choices: [{ message: { content: reply } }], usage: { total_tokens: 10, prompt_tokens: 5 } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
  return { endpoint: "http://stub", model: "stub-model", fetchImpl };
}

describe("agent conversation continuity (regression)", () => {
  it("persists the assistant's prose reply into lastMessages", async () => {
    const agent = new PersonaAgent({ llm: stubLlm("ROJO") });
    const r = await agent.run("say ROJO");
    expect(r.summary).toBe("ROJO");
    const roles = (agent.lastMessages ?? []).map((m) => m.role);
    expect(roles).toContain("assistant");
    const assistant = (agent.lastMessages ?? []).filter((m) => m.role === "assistant");
    expect(assistant.at(-1)?.content).toBe("ROJO");
  });

  it("second turn carries the first exchange (no re-answering)", async () => {
    const a1 = new PersonaAgent({ llm: stubLlm("ROJO") });
    await a1.run("say ROJO");
    const prior = (a1.lastMessages ?? []).filter((m) => m.role !== "system") as ChatMessage[];

    // Next turn starts from the prior transcript (as the REPL does via ctx.conversation).
    const a2 = new PersonaAgent({ llm: stubLlm("AZUL"), priorMessages: prior });
    await a2.run("say AZUL");
    const convo = (a2.lastMessages ?? []).filter((m) => m.role !== "system");
    // user ROJO, assistant ROJO, user AZUL, assistant AZUL — alternating, first exchange intact.
    expect(convo.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"]);
    expect(convo[1].content).toBe("ROJO");
    expect(convo[3].content).toBe("AZUL");
  });
});
