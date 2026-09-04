/**
 * E21: the tool subset belongs to the session, not to the turn.
 *
 * Subsetting per task is the obvious reading and it collides with E5. Providers cache a
 * PREFIX, the tool declarations sit inside it, and a catalogue that changes between
 * turns invalidates everything behind it: a few hundred prompt tokens saved against a
 * full cache write of the whole prefix is a loss dressed as an optimisation.
 *
 * So the property under test is not "the subset is small". It is that the subset DOES
 * NOT MOVE between turns once the session picked one, and that a session which picked
 * badly can still end its turns and still ask for what it lacks.
 */
import { describe, it, expect } from "vitest";
import { PersonaAgent, type ActiveSkill, type Policy } from "../src/index.js";

function policy(over: Partial<Policy> = {}): Policy {
  return { sandbox: "danger-full-access", approval: "never", allow: [], deny: [], workspaceRoot: process.cwd(), ...over };
}

const SKILLS: ActiveSkill[] = [
  { name: "writing", capabilities: ["draft", "prose"], allowedTools: ["write_file", "edit_file"] },
  { name: "inspection", capabilities: ["inspect", "audit"], allowedTools: ["read_file", "list_dir"] },
];

/** Captures the tool names offered on every request, then finishes. */
function capturingFetch(offered: string[][]): typeof fetch {
  return (async (url: string, init: { body: string }) => {
    if (String(url).endsWith("/models")) return { ok: true, status: 200, json: async () => ({ data: [] }) };
    offered.push((JSON.parse(init.body).tools ?? []).map((t: { function: { name: string } }) => t.function.name));
    return {
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ message: { content: "", tool_calls: [{ id: "c1", type: "function", function: { name: "finish", arguments: JSON.stringify({ summary: "done" }) } }] } }],
      }),
    };
  }) as unknown as typeof fetch;
}

const runWith = async (opts: Record<string, unknown>, task: string): Promise<string[]> => {
  const offered: string[][] = [];
  await new PersonaAgent({
    llm: { endpoint: "http://x/v1", model: "m", fetchImpl: capturingFetch(offered) },
    policy: policy(),
    ...opts,
  }).run(task);
  return offered[0] ?? [];
};

describe("a pinned subset does not move between turns (E21)", () => {
  it("without pinning, two different tasks are offered different catalogues", async () => {
    // The control for everything below: if per-task selection did not actually vary,
    // pinning would be proving nothing.
    const writing = await runWith({ skills: SKILLS }, "draft the release prose");
    const inspecting = await runWith({ skills: SKILLS }, "audit and inspect the config");
    expect(writing).not.toEqual(inspecting);
    expect(writing).toContain("write_file");
    expect(inspecting).toContain("read_file");
  });

  it("with a pinned subset, the SAME catalogue is offered whatever the task is", async () => {
    const pinned = { toolNames: ["read_file", "list_dir"] };
    const a = await runWith(pinned, "draft the release prose");
    const b = await runWith(pinned, "audit and inspect the config");
    expect(a).toEqual(b);
    expect(a).toContain("read_file");
    expect(a).not.toContain("write_file");
  });

  it("pinning wins over the skills, which are what would otherwise move it", async () => {
    const offered = await runWith({ skills: SKILLS, toolNames: ["read_file"] }, "draft the release prose");
    // The writing skill matches this task and would have brought write_file along.
    expect(offered).not.toContain("write_file");
    expect(offered).toContain("read_file");
  });

  it("a pinned session can still END a turn and still ASK for what it lacks", async () => {
    // Both are added on top rather than required in the list: a caller that forgets
    // them would otherwise pin a session that cannot finish or cannot recover.
    const offered = await runWith({ toolNames: ["read_file"] }, "read something");
    expect(offered).toContain("finish");
    expect(offered).toContain("find_tools");
  });

  it("an empty pin is a real choice, not the absence of one", async () => {
    // `[]` means "nothing but the escape hatches", and must not be read as "unset".
    const offered = await runWith({ toolNames: [] }, "read something");
    expect(offered.sort()).toEqual(["find_tools", "finish"]);
  });

});
