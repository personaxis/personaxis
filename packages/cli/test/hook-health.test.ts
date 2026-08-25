/**
 * Whether the hook a host would run is one it can actually start.
 *
 * Written after a real day of it being false. A settings file from an older version
 * named the bare binary, the CLI was updated, nobody re-ran the installer, and the
 * host reported `command not found` as a NON-BLOCKING failure on every tool call. A
 * non-blocking failure means the call proceeds, so the session looked governed and was
 * not, and the only evidence was a line that reads like a warning.
 *
 * That is worse than having no hook at all, because no hook is honest about what it is
 * not doing. These pin the two shapes that produce it and, just as importantly, the
 * shape that must NOT be reported: a hook pointed at a daemon that is down is working
 * exactly as designed.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { claudeCodeAdapter, describeAilment, hookHealth } from "../src/workspace/host-adapter.js";

let root: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "pxs-hookhealth-"));
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

function settings(command: string): void {
	const path = claudeCodeAdapter.settingsPath(root);
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(
		path,
		JSON.stringify({
			hooks: {
				[claudeCodeAdapter.preToolUseEvent]: [
					{ hooks: [{ type: "command", command, timeout: 1830 }] },
				],
			},
		}),
	);
}

describe("a hook the host cannot start", () => {
	it("is reported, because the host lets the call through instead of failing", () => {
		// The exact command found in a real settings file, which had been silently
		// ungating every tool call for a day.
		settings('personaxis-hook --socket "\\\\.\\pipe\\personaxis-enforce-305c3fc0c253"');

		const findings = hookHealth(root);

		expect(findings).toHaveLength(1);
		expect(findings[0]!.ailment.kind).toBe("unrunnable");
	});

	it("says what to do about it, not just that it is wrong", () => {
		settings("personaxis-hook --endpoint personaxis-enforce-abc");

		expect(describeAilment(hookHealth(root)[0]!)).toMatch(/personaxis connect/);
		expect(describeAilment(hookHealth(root)[0]!)).toMatch(/ungated/);
	});

	it("reports a socket address written with backslashes", () => {
		// A shell collapses it before the hook sees it, so the hook dials an address
		// that does not exist and refuses everything for the wrong reason.
		settings('"C:\\node.exe" "C:\\hook.js" --socket "\\\\.\\pipe\\personaxis-enforce-abc"');

		expect(hookHealth(root)[0]!.ailment.kind).toBe("mangled_address");
	});
});

describe("what must not be reported", () => {
	it("says nothing about a correctly installed hook", () => {
		settings('"C:\\node.exe" "C:\\hook.js" --endpoint personaxis-enforce-abc');

		expect(hookHealth(root)).toEqual([]);
	});

	it("says nothing about somebody else's hook", () => {
		// A check that reported every hook in the file would be a check people turn
		// off, and it would be wrong: this is not ours to judge.
		settings("some-other-tool --do-a-thing");

		expect(hookHealth(root)).toEqual([]);
	});

	it("says nothing when there is no settings file at all", () => {
		// Not installed is not broken. A folder nobody connected has no hook and that
		// is the correct state for it.
		expect(hookHealth(root)).toEqual([]);
	});

	it("does not guess about a settings file it cannot parse", () => {
		const path = claudeCodeAdapter.settingsPath(root);
		mkdirSync(join(path, ".."), { recursive: true });
		writeFileSync(path, "{not json");

		// Claiming a hook is broken because the file would not parse is guessing, and
		// a check that guesses is one nobody believes the second time.
		expect(hookHealth(root)).toEqual([]);
	});
});
