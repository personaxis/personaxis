/**
 * E128: every path that creates a persona writes affect bands as a way of working and a shade of tone.
 *
 * Genesis is one path; `init`'s scaffolds and the starter persona are others, and on 2026-09-23 they
 * carried copies of the old prose, "a negative undertone colors your read of things" among it. David
 * decided the persona's evolution is to calibrate how it works and to say so (plan, section 13.8), so
 * the property is checked on what each path actually writes, not on one table: a behaviour part and a
 * tone part in every line, three distinct lines per coordinate, and no line describing a feeling.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";
import matter from "gray-matter";

import { buildCustomAgentTemplate, buildMarketingGuru } from "../src/commands/init.js";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const FEELINGS = /\b(feel|feels|feeling|sad|happy|angry|anxious|undertone|upset|joy|gloom)\b/i;

type Bands = { low: string; moderate: string; high: string };
/** Every affect coordinate's bands in a persona document. */
function affectBands(doc: string): Array<[string, Bands]> {
	const affect = (matter(doc).data as { affect?: { baseline?: Record<string, Record<string, { expression?: Bands }>> } }).affect;
	const out: Array<[string, Bands]> = [];
	for (const [group, coords] of Object.entries(affect?.baseline ?? {})) {
		for (const [name, coord] of Object.entries(coords ?? {})) {
			if (coord && typeof coord === "object" && coord.expression && typeof coord.expression === "object") out.push([`${group}.${name}`, coord.expression]);
		}
	}
	return out;
}

const DOCUMENTS: Array<[string, string]> = [
	["starter persona", readFileSync(join(HERE, "..", "templates", "starter_persona.md"), "utf8")],
	["init: marketing guru", buildMarketingGuru("Marketing Guru", "marketing-guru")],
	["init: custom agent", buildCustomAgentTemplate("Helper", "helper", "software engineer", "ship features", "Direct", "make the team faster")],
];

describe("affect bands, on every path that creates a persona (E128)", () => {
	for (const [name, doc] of DOCUMENTS) {
		const bands = affectBands(doc);

		it(`${name}: has affect bands to check`, () => {
			expect(bands.length).toBeGreaterThan(0);
		});

		for (const [coordinate, lines] of bands) {
			it(`${name} · ${coordinate}: a way of working, then a tone, never a feeling`, () => {
				const all = [lines.low, lines.moderate, lines.high];
				expect(new Set(all).size).toBe(3);
				for (const line of all) {
					expect(line.split(";").length, line).toBeGreaterThanOrEqual(2);
					expect(line).not.toMatch(FEELINGS);
				}
			});
		}
	}
});
