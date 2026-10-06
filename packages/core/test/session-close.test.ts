/**
 * E89: the five decisions a session close makes, which nothing watched until now.
 *
 * Measured on 2026-09-16: the close lived in the terminal, appeared in four places in `src` and in no test at
 * all. So a persona consolidated its memory in a conversation and consolidated nothing through a service step
 * or an editor, and no test would have noticed either way.
 *
 * What these pin is that every step does what the DOCUMENT says, and nothing else.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { closeSessionMemory } from "../src/memory/close.js";
import { readLiveMemory } from "../src/memory.js";
import { readAutobiographical } from "../src/memory-kinds.js";
import { appendTurn, ensureSession } from "../src/sessions.js";

let dir: string;
let personaPath: string;

/** A persona that declares exactly the memory block each case is about. */
function persona(memory: string): Record<string, unknown> {
	writeFileSync(personaPath, `---\napiVersion: personaxis/v1\nkind: Persona\n${memory}---\n# Boss\n\nruns the shop\n`);
	return memoryOf(memory);
}

/** The frontmatter as the caller would hand it over, without re-reading the file. */
function memoryOf(memory: string): Record<string, unknown> {
	const types: Record<string, boolean> = {};
	for (const kind of ["episodic", "semantic", "autobiographical"]) types[kind] = memory.includes(`${kind}: true`);
	const policy: Record<string, unknown> = {};
	if (memory.includes("default: ephemeral")) policy.write_policy = { default: "ephemeral" };
	if (memory.includes("mode: assisted")) policy.consolidation_policy = { mode: "assisted" };
	if (memory.includes("mode: manual")) policy.consolidation_policy = { mode: "manual" };
	return { memory: { types, ...policy } };
}

function conversation(id = "s1"): void {
	ensureSession(personaPath, { id, kind: "root", participants: ["(root)"], name: "kickoff", created: "2026-09-16", persona: "" });
	appendTurn(personaPath, id, { role: "user", content: "my name is Mara" });
	appendTurn(personaPath, id, { role: "assistant", content: "good to meet you" });
}

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "pxs-e89-"));
	personaPath = join(dir, ".personaxis", "personaxis.md");
	mkdirSync(join(dir, ".personaxis"), { recursive: true });
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("closing a session, whatever the surface (E89)", () => {
	it("distils what was said, and says how much", () => {
		const fm = persona("memory:\n  types:\n    episodic: true\n");
		conversation();

		const closed = closeSessionMemory(personaPath, "s1", fm);

		expect(closed.distilled).toBeGreaterThan(0);
		expect(readLiveMemory(personaPath).every((entry) => entry.tags.includes("from:s1"))).toBe(true);
	});

	it("distils nothing when the persona keeps no episodic memory, and says why", () => {
		const fm = persona("memory:\n  types:\n    semantic: true\n");
		conversation();

		const closed = closeSessionMemory(personaPath, "s1", fm);

		expect(closed.distilled).toBe(0);
		expect(closed.why).toContain("episodic");
		expect(readLiveMemory(personaPath)).toEqual([]);
	});

	it("distils nothing when the write policy is ephemeral, which is a promise and not a setting", () => {
		const fm = persona("memory:\n  types:\n    episodic: true\n  write_policy:\n    default: ephemeral\n");
		conversation();

		const closed = closeSessionMemory(personaPath, "s1", fm);

		expect(closed.distilled).toBe(0);
		expect(closed.why).toContain("ephemeral");
		expect(readLiveMemory(personaPath)).toEqual([]);
	});

	it("writes the first-conversation milestone once, and never again", () => {
		const fm = persona("memory:\n  types:\n    episodic: true\n    autobiographical: true\n");
		conversation();

		expect(closeSessionMemory(personaPath, "s1", fm).milestone).toBe(true);
		expect(closeSessionMemory(personaPath, "s1", fm).milestone).toBe(false);
		expect(readAutobiographical(personaPath).filter((e) => e.tags.includes("first-conversation"))).toHaveLength(1);
	});

	it("proposes rather than folds when the persona asked to be assisted", () => {
		// `assisted` already means proposed in the loop. A close that folded anyway would override a declared
		// preference from a surface the persona never named.
		const fm = persona("memory:\n  types:\n    episodic: true\n    semantic: true\n  consolidation_policy:\n    mode: assisted\n");
		conversation();

		expect(closeSessionMemory(personaPath, "s1", fm).semantic).toBe("proposed");
	});

	it("folds when the persona declared auto, and leaves it alone under manual", () => {
		const auto = persona("memory:\n  types:\n    episodic: true\n    semantic: true\n");
		conversation();
		expect(closeSessionMemory(personaPath, "s1", auto).semantic).toBe("consolidated");

		const manual = persona("memory:\n  types:\n    episodic: true\n    semantic: true\n  consolidation_policy:\n    mode: manual\n");
		expect(closeSessionMemory(personaPath, "s1", manual).semantic).toBe("skipped");
	});

	it("does not duplicate when the same session is closed twice", () => {
		const fm = persona("memory:\n  types:\n    episodic: true\n");
		conversation();

		const first = closeSessionMemory(personaPath, "s1", fm).distilled;
		expect(first).toBeGreaterThan(0);
		expect(closeSessionMemory(personaPath, "s1", fm).distilled).toBe(0);
	});
});
