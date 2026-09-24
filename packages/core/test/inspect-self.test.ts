/**
 * E119: `inspect_self`, the persona looks at itself at the moment it is answering about itself.
 *
 * A tool defined is not a tool offered (`check_page` spent four days out of the catalogue), so these read what
 * `runnerFor` actually offers, and run the tool it offers, and read the text the model would get: the service
 * the persona delivers, which is exactly what it never named when asked what it can do (`inventory`, 0 of 6).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Kernel } from "../src/kernel/index.js";
import { localExecution } from "../src/ports/execution.js";
import { runnerFor } from "../src/run/runner-for.js";
import type { Policy } from "../src/sandbox.js";
import { TOOL_POINT } from "../src/tools/mounted.js";
import { inspectSelfTool } from "../src/tools/inspect-self.js";
import type { ToolSpec } from "../src/tools/registry.js";

/** The name as the model sees it, read off the tool itself. */
const INSPECT_SELF_TOOL = inspectSelfTool({ has: () => "", now: () => "" }).name;

let workspace: string;
let personaPath: string;

function write(path: string, text: string): void {
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, text);
}

beforeEach(() => {
	workspace = mkdtempSync(join(tmpdir(), "pxs-inspect-"));
	const folder = join(workspace, ".personaxis", "personas", "gamewright");
	personaPath = join(folder, "personaxis.md");
	write(personaPath, '---\nextensions:\n  skills:\n    - "./skills/game-feel"\n---\n');
	write(join(folder, "skills", "game-feel", "SKILL.md"), "---\nname: game-feel\ndescription: Make a game's actions feel responsive.\n---\n\nFix the core interaction first.\n");
	write(
		join(workspace, ".personaxis", "services", "game-build.json"),
		JSON.stringify({
			name: "Game build",
			description: "A small game built to order.",
			leadPersonaRef: "gamewright",
			steps: [{ position: 1, personaRef: "gamewright", name: "Build", instruction: "Build it.", produces: ["game.html"] }],
		}),
	);
});
afterEach(() => rmSync(workspace, { recursive: true, force: true }));

const llm = { endpoint: "http://model.invalid", model: "m", apiKey: "k" } as never;
const policy = (): Policy => ({ sandbox: "workspace-write", approval: "never", allow: [], deny: [], workspaceRoot: workspace });

function offered(frontmatter: Record<string, unknown>): readonly ToolSpec[] {
	const kernel = new Kernel();
	runnerFor({ personaPath, frontmatter, llm }, { kernel, policy: policy() });
	return kernel.extensions.of(TOOL_POINT);
}

describe("inspect_self is offered, and says what the persona has (E119)", () => {
	it("is in the catalogue a persona with something to look at is given", () => {
		expect(offered({ extensions: { skills: ["./skills/game-feel"] } }).map((spec) => spec.name)).toContain(INSPECT_SELF_TOOL);
	});

	it("names the service the persona delivers, which is what it never said when asked what it can do", async () => {
		const tool = offered({ extensions: { skills: ["./skills/game-feel"] } }).find((spec) => spec.name === INSPECT_SELF_TOOL)!;
		const out = await tool.execute({}, policy(), localExecution());
		expect(out).toContain("Services you deliver");
		expect(out).toContain("Game build");
		expect(out).toContain("game-feel");
		expect(out).toContain("How you are right now");
	});

	it("reads, writes nothing and asks nothing", () => {
		const tool = offered({ extensions: { skills: ["./skills/game-feel"] } }).find((spec) => spec.name === INSPECT_SELF_TOOL)!;
		expect(tool.isReadOnly).toBe(true);
		expect(tool.envelope).toEqual([]);
		expect(tool.gate({}, policy()).decision).toBe("allow");
	});

	it("is not offered to a persona with nothing to look at", () => {
		rmSync(join(workspace, ".personaxis", "services"), { recursive: true, force: true });
		expect(offered({}).map((spec) => spec.name)).not.toContain(INSPECT_SELF_TOOL);
	});
});
