import { describe, it, expect } from "vitest";
import { distillTurns, isInfraErrorReply, sessionBrief } from "../src/memory/consolidate.js";
import type { SessionTurn } from "../src/sessions.js";

const t = (role: SessionTurn["role"], content: string): SessionTurn => ({ role, content, ts: new Date().toISOString() });

describe("infra errors never become memory (V5.FIX.3)", () => {
  it("classifies provider/agent failures as infra, normal replies as lived experience", () => {
    for (const s of [
      'agent error: tool-calling HTTP 401: {"message":"no api key supplied"}',
      "(responder error: fetch failed)",
      "tool-calling HTTP 429: rate limited",
    ]) {
      expect(isInfraErrorReply(s)).toBe(true);
    }
    for (const s of ["¡Hola, Mara! ¿Cómo estás?", "Listo", "El plan es publicar mañana."]) {
      expect(isInfraErrorReply(s)).toBe(false);
    }
  });

  it("the session distillate skips an infra-error last reply", () => {
    const out = distillTurns(
      [t("user", "hola"), t("assistant", "agent error: tool-calling HTTP 401: no api key supplied")],
      "hola",
    );
    const event = out.find((d) => d.kind === "event");
    expect(event).toBeDefined();
    expect(event!.content).toContain('started with "hola"');
    expect(event!.content).not.toContain("agent error");
  });

  it("a healthy reply still closes the recap normally", () => {
    const out = distillTurns([t("user", "hola"), t("assistant", "¡Hola! ¿En qué te ayudo?")], "hola");
    const event = out.find((d) => d.kind === "event");
    expect(event!.content).toContain("ended:");
  });
});
