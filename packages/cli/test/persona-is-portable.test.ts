/**
 * R6: a persona's definition may not depend on our platform.
 *
 * Section 10 of the object-model ADR of 2026-08-21 states it as a property of the
 * model rather than an implementation detail: **the portable unit is the persona, not
 * the workspace.** Its consequence is written for every future decision, and this file
 * is the thing that holds somebody to it:
 *
 *   "nothing that only works inside our platform may enter the definition of a
 *    persona. What lives in the spec has to be loadable in a host that is not ours,
 *    and what does not meet that belongs to the workspace and not to the persona."
 *
 * Two halves, because the rule has two halves.
 *
 * The COMPILED artifact is what a foreign host actually reads, so the strong assertion
 * is about that: what Claude Code, Codex or Cursor receives must stand on its own, with
 * nothing in it that only resolves against us. That is behaviour, and it is what
 * "loadable in a host that is not ours" means when it stops being a sentence.
 *
 * The SCHEMA is the weaker half and the earlier one: a field that only means something
 * inside a multi-tenant platform has already broken the rule at the point it was
 * declared, whether or not any compiler passes it on.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { compileClaudeCode, compileClaudeCodeAgent } from "../src/targets/claude-code.js";
import { compileCodexAgent } from "../src/targets/codex.js";
import { compileCursor } from "../src/targets/cursor.js";
import type { PersonaData } from "../src/load.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCHEMA = join(HERE, "..", "..", "spec", "schema", "persona.schema.json");

/**
 * A persona carrying every platform-shaped value we could put in one.
 *
 * Deliberately filled in rather than left empty: a test whose fixture omits the field
 * it is about proves that an absent value does not appear in the output, which is true
 * of every string in the language.
 */
const TENANT = "tenant_01H8XKCJ";
const persona: PersonaData = {
	metadata: {
		name: "watcher",
		version: "1.0.0",
		description: "Watches a repository and reports.",
		created: "2026-09-09",
		owner_tenant_id: TENANT,
		tags: ["ops"],
		license: "private",
	},
	// Filled out rather than sketched, and the control at the bottom of this file is
	// why: with a two-key identity the compiler emitted 61 characters, so every
	// `not.toContain` above was passing on a document that barely existed.
	identity: {
		display_name: "The Watcher",
		canonical_id: "watcher",
		system_identity: {
			purpose: "Watch a repository and report what changed.",
			allowed_domains: ["engineering"],
			prohibited_domains: ["finance"],
		},
		role_identity: { primary_role: "observer" },
		narrative_identity: { self_concept: "A careful reader of diffs." },
	},
	character: {
		virtues: { rigour: { description: "checks before saying", priority: 1 } },
		prohibited_behaviors: ["guessing at a number"],
	},
	personality: { traits: { openness: 0.6 } },
	self_regulation: { hard_limits: ["never edits history"] },
} as unknown as PersonaData;

const FOREIGN_HOSTS: [string, () => string][] = [
	["claude-code", () => compileClaudeCode(persona)],
	["claude-code agent", () => compileClaudeCodeAgent(persona, "watcher")],
	["codex agent", () => compileCodexAgent(persona, "watcher")],
	["cursor", () => compileCursor(persona)],
];

describe("what a host that is not ours receives", () => {
	it.each(FOREIGN_HOSTS)("carries no tenant of ours: %s", (_host, compile) => {
		// The clearest case: an identifier that is meaningless anywhere but inside a
		// multi-tenant platform. A host reading it has nothing to resolve it against,
		// and a persona that needed it resolved would not be portable.
		expect(compile()).not.toContain(TENANT);
	});

	it.each(FOREIGN_HOSTS)("needs nothing fetched from us to be read: %s", (_host, compile) => {
		const out = compile();

		// No endpoint of ours, no account key, no registry call. What a foreign host
		// gets is a document it can read with nothing but itself.
		expect(out).not.toMatch(/https?:\/\/[^\s)"']*personaxis\.com/i);
		expect(out).not.toContain("PERSONAXIS_API_KEY");
		expect(out).not.toMatch(/\/api\/v1\//);
	});

	it("still carries the identity, or the assertions above pass on an empty file", () => {
		// The control on the three above: `not.toContain` is satisfied by a compiler
		// that emits nothing at all, and a portability test that passes on silence is
		// the shape of green that means nothing.
		const out = compileClaudeCode(persona);

		expect(out).toContain("The Watcher");
		expect(out.length).toBeGreaterThan(200);
	});
});

/**
 * Words that only mean something inside a platform like ours.
 *
 * Narrow on purpose. `workspace` is not here because the spec uses it for the sandbox
 * posture `workspace-write`, which is a directory boundary every agent runtime has and
 * has nothing to do with our object model; a rule that flagged it would be teaching
 * people to wave this one through.
 */
const PLATFORM_WORDS = ["tenant", "subscription", "billing", "seat_count", "dashboard"];

/**
 * The one field that breaks the rule today, named rather than quietly allowed.
 *
 * `metadata.owner_tenant_id` is a tenant id in a document that is meant to load
 * anywhere. Measured on 2026-09-09: **nothing reads its value** in either repository.
 * It is declared in the schema with no description at all, mirrored in the CLI's
 * `PersonaMetadata` type, listed in the SaaS visualiser's field catalogue, and written
 * as an empty string by our own template.
 *
 * It is not removed here because removing it is BREAKING and that is not a decision a
 * test makes: `metadata` declares `additionalProperties: false`, so every persona ever
 * created from our template, which ships the key, would stop validating the day it
 * disappears. What that costs is a spec version and a codemod, which is David's call.
 *
 * The exemption exists so the rule is enforced everywhere else in the meantime, and so
 * the day somebody adds a second one, this list is where they have to write why.
 */
const NAMED_EXEMPTIONS = ["owner_tenant_id"];

describe("what the spec itself declares", () => {
	const schema = readFileSync(SCHEMA, "utf8");

	it.each(PLATFORM_WORDS)("declares no field named after our platform: %s", (word) => {
		const offenders = [...schema.matchAll(new RegExp(`"([a-z0-9_]*${word}[a-z0-9_]*)"\\s*:`, "gi"))]
			.map((match) => match[1] as string)
			.filter((field) => !NAMED_EXEMPTIONS.includes(field));

		expect([...new Set(offenders)]).toEqual([]);
	});

	it("watches something, so its silence is not an empty sweep", () => {
		// The control of the control: the sweep has to be able to FIND the thing it is
		// excusing, or a typo in the regex would read exactly like a clean schema.
		expect(schema).toContain("owner_tenant_id");
		expect(new RegExp('"([a-z0-9_]*tenant[a-z0-9_]*)"\\s*:', "i").test(schema)).toBe(true);
	});
});
