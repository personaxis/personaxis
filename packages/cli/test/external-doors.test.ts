/**
 * E171: every door a retired REPL verb points at is a command the CLI really has.
 *
 * `command-surface.test.ts` checks that typing `/rewind` PRINTS `personaxis <door>`, and that passed for
 * months while two doors did not exist: `state rewind <n>` and `goal <text>`. This asks the built CLI
 * itself: the door's command path must answer `--help` with its own usage line, an argument the door
 * shows (`<n>`, `<text>`) must be one the command takes, and a flag it shows must be one it offers.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { EXTERNAL_DOOR } from "../src/repl/commands.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, "..", "dist", "index.js");

function help(path: string[]): string {
	const run = spawnSync(process.execPath, [CLI, ...path, "--help"], { encoding: "utf8", env: { ...process.env, PERSONAXIS_NO_UPDATE_CHECK: "1", NO_COLOR: "1" } });
	return run.status === 0 ? run.stdout : "";
}

/** `state rewind <n>` → path [state, rewind], wants an argument; `audit --tab Integrity` → path [audit], flag --tab. */
export function parseDoor(door: string): { path: string[]; wantsArg: boolean; flags: string[] } {
	const tokens = door.split(/\s+/).filter(Boolean);
	const path: string[] = [];
	for (const t of tokens) {
		if (t.startsWith("<") || t.startsWith("-")) break;
		path.push(t);
	}
	return { path, wantsArg: tokens.some((t) => t.startsWith("<")), flags: tokens.filter((t) => t.startsWith("--")) };
}

describe.skipIf(!existsSync(CLI))("the doors retired verbs point at (E171)", () => {
	for (const [verb, door] of Object.entries(EXTERNAL_DOOR)) {
		it(`/${verb} → personaxis ${door}`, () => {
			const { path, wantsArg, flags } = parseDoor(door);
			const text = help(path);
			const usage = text.split(/\r?\n/).find((l) => l.startsWith("Usage:")) ?? "";
			expect(usage, `\`personaxis ${path.join(" ")}\` is not a command`).toMatch(new RegExp(`^Usage: personaxis ${path.join(" ")}( |$)`));
			// `[options]` and `[command]` are in every usage line and are not an argument.
			const args = usage.replace(/\[(options|command)\]/g, "");
			if (wantsArg) expect(args, `\`personaxis ${path.join(" ")}\` takes no argument`).toMatch(/[<[][a-z.]+[\]>]/);
			for (const flag of flags) expect(text, `\`personaxis ${path.join(" ")}\` has no ${flag}`).toContain(flag);
		}, 30_000);
	}
});
