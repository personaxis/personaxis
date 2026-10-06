/**
 * A bridge renders; it does not decide.
 *
 * The Claude Code and Codex adapters exist to turn a persona into the document that
 * host reads. They are the reason a persona can work anywhere, and they are also the
 * most tempting place in the tree to put a shortcut: a host has its own permission
 * file, so writing our limits into it looks like enforcement and costs one line.
 *
 * It is not enforcement. A limit rendered into a host's settings is a request the host
 * may honour, ignore, or be argued out of, and the whole point of the gate is that a
 * refused call does not execute. Worse, it would be a *second* place a limit lives,
 * so the day one changes the two disagree and nobody finds out, because the one that
 * quietly wins is whichever the host happens to read.
 *
 * So this checks the boundary structurally rather than by intention. If somebody
 * imports the decision into a target, this goes red with the reason, which is a better
 * conversation than discovering it during an incident.
 */

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const TARGETS = join(HERE, "..", "src", "targets");

/** What a bridge must not reach for, and why each one is on the list. */
const FORBIDDEN: readonly { pattern: RegExp; because: string }[] = [
	{
		pattern: /\bevaluate\s*\(/,
		because: "evaluating a policy in a target makes a second decision point",
	},
	{
		pattern: /\brunGuards\s*\(/,
		because: "a target that ran the cascade would decide where it should only render",
	},
	{
		pattern: /enforcementHandler/,
		because: "the daemon decides; a target that called it would decide twice",
	},
	{
		pattern: /from\s+["'][^"']*enforcement\//,
		because: "importing enforcement into a target is how a limit gets two homes",
	},
];

function sources(): { name: string; text: string }[] {
	return readdirSync(TARGETS)
		.filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
		.map((name) => ({ name, text: readFileSync(join(TARGETS, name), "utf8") }));
}

describe("the bridges stay bridges", () => {
	it("has bridges to check, so a rename cannot make this vacuously pass", () => {
		// A structural test over a directory is one `mv` away from checking nothing at
		// all, and passing for that reason is worse than not existing.
		const names = sources().map((file) => file.name);

		expect(names).toContain("claude-code.ts");
		expect(names).toContain("codex.ts");
	});

	it("makes no enforcement decision in any of them", () => {
		const offences: string[] = [];
		for (const file of sources()) {
			for (const rule of FORBIDDEN) {
				if (rule.pattern.test(file.text)) {
					offences.push(`${file.name}: ${rule.because}`);
				}
			}
		}

		expect(offences).toEqual([]);
	});

	it("does not write our limits into a host's own permission file", () => {
		// A limit in a host's settings is a request that host may ignore. The hook is
		// what makes a refusal a refusal, and it is installed separately on purpose.
		for (const file of sources()) {
			expect(file.text).not.toMatch(/permissions\s*:\s*\{[\s\S]{0,200}deny/);
		}
	});
});
