/**
 * E113: the compiled identity names the services the persona delivers.
 *
 * Measured on 2026-09-22. `personaxis.md` was 12.155 characters and did not contain the word
 * "service" once; neither did the 5.439 of the compiled `PERSONA.md`. The only place in the
 * engine that resolved which services belonged to a persona was the runtime work map, so the
 * link ran one way: the service declared `leadPersonaRef: "gamewright"` and she declared
 * nothing. Asked what she could do, she described exactly what her service does, in her own
 * words, and never called it by its name: 6 of 6 with one model, 4 of 6 with the other.
 *
 * Raised by David, in his words: "debe reconocer o ser consciente de que está a cargo de un AI
 * service y conocer el nombre". He was right and the bench check was not the thing to argue
 * with.
 *
 * Derived at compile time from the services that name her as lead, so a persona file gains no
 * field and no existing persona changes. A step she does inside somebody else's service is
 * work she takes part in, not something she delivers, so it stays in the map and out of here.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { run } from "@personaxis/core";

import { loadPersonaFile } from "../src/load.js";
import { writeStarterPersona } from "../src/starter.js";
import { liveCompiledDocument } from "../src/compiled-document.js";

let base: string;
let savedCwd: string;

beforeEach(() => {
	base = mkdtempSync(join(tmpdir(), "pxs-services-"));
	savedCwd = process.cwd();
});

afterEach(() => {
	process.chdir(savedCwd);
	rmSync(base, { recursive: true, force: true });
});

interface ServiceStep {
	readonly position: number;
	readonly personaRef: string;
	readonly name: string;
	readonly instruction: string;
	readonly produces: readonly string[];
}

/** A service definition on disk, in the shape the engine reads. */
function writeService(
	repo: string,
	address: string,
	definition: { name: string; description?: string; leadPersonaRef: string; steps: readonly ServiceStep[] },
): void {
	mkdirSync(join(repo, ".personaxis", "services"), { recursive: true });
	writeFileSync(join(repo, ".personaxis", "services", `${address}.json`), JSON.stringify(definition, null, 1));
}

const step = (personaRef: string, name: string, produces: readonly string[], position = 1): ServiceStep => ({
	position,
	personaRef,
	name,
	instruction: `Do ${name}.`,
	produces,
});

const specOf = (path: string) => loadPersonaFile(path).data as Record<string, unknown>;

describe("the compiled identity names what the persona delivers (E113)", () => {
	it("names the service she leads, what it is, and what a run of it leaves", () => {
		const repo = join(base, "repo");
		const path = writeStarterPersona(repo, "Wright", "gamewright");
		writeService(repo, "game-build", {
			name: "Game build",
			description: "A design document and a playable prototype that agree with each other.",
			leadPersonaRef: "gamewright",
			steps: [step("gamewright", "Design the game", ["GAME.md"]), step("gamewright", "Build it", ["game.html"], 2)],
		});

		const doc = liveCompiledDocument(path, specOf(path));

		expect(doc).toContain("## What you deliver");
		expect(doc).toContain("Game build");
		expect(doc).toContain("game-build");
		expect(doc).toContain("A design document and a playable prototype that agree with each other");
		expect(doc).toContain("GAME.md, game.html");
		// The tool is named here for the same reason the map's sections name theirs: a promise
		// with no tool in it is a sentence, not an action (E103).
		expect(doc).toContain("run_service");
	});

	it("a persona with no services compiles exactly as it did before", () => {
		const repo = join(base, "repo");
		const path = writeStarterPersona(repo, "Wright", "gamewright");
		const doc = liveCompiledDocument(path, specOf(path));

		expect(doc).not.toContain("What you deliver");
		expect(doc).not.toContain("run_service");
	});

	it("a service she only does a STEP of is not something she delivers", () => {
		const repo = join(base, "repo");
		const path = writeStarterPersona(repo, "Wright", "gamewright");
		writeStarterPersona(repo, "Ren", "renderer");
		writeService(repo, "art-pass", {
			name: "Art pass",
			leadPersonaRef: "renderer",
			steps: [step("renderer", "Draw it", ["art.png"]), step("gamewright", "Say if it fits", ["notes.md"], 2)],
		});

		const doc = liveCompiledDocument(path, specOf(path));
		expect(doc).not.toContain("What you deliver");

		// And it is still hers to take part in: the map shows both, which is the distinction.
		const map = run.workMapFor(path, { workspaceRoot: repo });
		expect(map.services.map((s) => s.address)).toEqual(["art-pass"]);
		expect(map.services[0]?.leads).toBe(false);
	});

	it("the document does not depend on which directory you compile from", () => {
		const repo = join(base, "repo");
		const path = writeStarterPersona(repo, "Wright", "gamewright");
		writeService(repo, "game-build", {
			name: "Game build",
			leadPersonaRef: "gamewright",
			steps: [step("gamewright", "Design the game", ["GAME.md"])],
		});

		process.chdir(repo);
		const fromInside = liveCompiledDocument(path, specOf(path));
		process.chdir(base);
		const fromOutside = liveCompiledDocument(path, specOf(path));

		expect(fromOutside).toBe(fromInside);
		expect(fromInside).toContain("Game build");
	});

	it("a service that stops naming her as lead leaves the document on the next compile", () => {
		const repo = join(base, "repo");
		const path = writeStarterPersona(repo, "Wright", "gamewright");
		const definition = {
			name: "Game build",
			leadPersonaRef: "gamewright",
			steps: [step("gamewright", "Design the game", ["GAME.md"])],
		};
		writeService(repo, "game-build", definition);
		expect(liveCompiledDocument(path, specOf(path))).toContain("Game build");

		writeService(repo, "game-build", { ...definition, leadPersonaRef: "someone-else" });
		const after = liveCompiledDocument(path, specOf(path));
		expect(after).not.toContain("What you deliver");
		// Nothing in her own file changed: the link is derived, so it is corrected by recompiling.
		expect(readFileSync(path, "utf-8")).not.toContain("service");
	});
});
