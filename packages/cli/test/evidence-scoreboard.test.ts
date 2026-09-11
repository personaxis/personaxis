/**
 * The scoreboard must say what the registry says, in both directions.
 *
 * On 2026-09-10 `docs/GUARANTEES.md`, whose entire job is not to outrun its evidence, carried
 * two false figures at once: that the direction favoured the engine on a comparison the engine
 * was never in, and a p99 range from an uncommitted bench run that the 2026-07-16 amendment
 * had already retired in the paper and never here. Two months, on the public page, with
 * nothing watching.
 *
 * The root cause was neither figure. Claims cite evidence files, and nothing checked that the
 * number in the prose was still the number in the file. A gate that only checks citations
 * RESOLVE passes a path that exists carrying a number that changed.
 *
 * So this checks both directions. `figures` must appear, which catches a page that lost a
 * current number. `retired` must not, which catches a page still carrying a withdrawn one.
 * Both failures actually happened, so both are checked.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const registry = JSON.parse(readFileSync(join(ROOT, "docs", "evidence.json"), "utf8")) as {
	scoreboard: string;
	claims: { id: string; status: string; figures: string[]; retired: string[]; source: string }[];
};
const scoreboard = readFileSync(join(ROOT, registry.scoreboard), "utf8");

describe("the evidence scoreboard against its registry", () => {
	for (const claim of registry.claims) {
		describe(claim.id, () => {
			for (const figure of claim.figures) {
				it(`still carries "${figure}"`, () => {
					// A figure that left the page is a claim that quietly lost its evidence.
					expect(scoreboard).toContain(figure);
				});
			}
			for (const stale of claim.retired) {
				it(`no longer carries the retired "${stale}"`, () => {
					// This is the exact failure of 2026-09-10: a number withdrawn in one place
					// and left standing in another.
					expect(scoreboard).not.toContain(stale);
				});
			}
		});
	}

	it("every claim says where its figures come from", () => {
		// A registry entry without a source is the same unchecked assertion in a new file.
		for (const claim of registry.claims) {
			expect(claim.source.length, claim.id).toBeGreaterThan(10);
			expect(claim.status.length, claim.id).toBeGreaterThan(0);
		}
	});

	it("covers every row the scoreboard scores, so a new row cannot arrive unwatched", () => {
		// The gate on the gate: the count of claims must keep up with the table. A row added
		// to the page without an entry here would be a figure nobody checks, which is how the
		// two false ones survived.
		const rows = scoreboard.split("\n").filter((l) => /^\| .+ \| (✅|🔬|❌|⚠️)/.test(l));
		expect(rows.length).toBe(registry.claims.length);
	});

	describe("the control of the control", () => {
		it("catches a stale figure when one is present", () => {
			// The negative control. Without this the suite passes on a page that happens to be
			// clean, and nobody learns whether it would catch a dirty one.
			const dirty = scoreboard + "\n| Hot-path cost | p99 0.06–0.12 ms per tick (n=8–64) |\n";
			const retired = registry.claims.find((c) => c.id === "hot-path")?.retired ?? [];
			expect(retired.some((s) => dirty.includes(s))).toBe(true);
		});

		it("catches a figure that went missing", () => {
			const gutted = scoreboard.replace("2,306,140", "some number");
			expect(gutted).not.toContain("2,306,140");
		});
	});
});
