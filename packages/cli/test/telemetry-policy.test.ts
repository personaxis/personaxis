/**
 * Telemetry writes nothing that the layers did not agree to.
 *
 * The sink took its enabled flag from whatever config the caller handed it, which
 * meant "whatever `loadMergedConfig` spread on top", which meant a project file could
 * turn on a log of what somebody did on their own machine.
 *
 * So the check is here, at the write, rather than at each of the call sites. A caller
 * that forgot it would be a caller writing a log nobody agreed to, and there is no
 * version of that worth leaving to whoever adds the next span.
 */

import { existsSync, mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let home: string;
let project: string;

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "pxs-tele-home-"));
	project = mkdtempSync(join(tmpdir(), "pxs-tele-project-"));
	vi.spyOn(process, "cwd").mockReturnValue(project);
	process.env.PERSONAXIS_HOME = home;
	mkdirSync(join(project, ".personaxis"), { recursive: true });
});

afterEach(() => {
	vi.restoreAllMocks();
	delete process.env.PERSONAXIS_HOME;
	rmSync(home, { recursive: true, force: true });
	rmSync(project, { recursive: true, force: true });
});

const writeGlobal = (config: unknown) => {
	mkdirSync(home, { recursive: true });
	writeFileSync(join(home, "config.json"), JSON.stringify(config), "utf-8");
};
const writeProject = (config: unknown) =>
	writeFileSync(join(project, ".personaxis", "config.json"), JSON.stringify(config), "utf-8");

/** Whatever the sink wrote, if anything. */
function written(): string[] {
	const root = join(project, ".personaxis");
	return existsSync(root) ? readdirSync(root).filter((name) => name.includes("telemetry")) : [];
}

async function record() {
	const { recordSpan } = await import("../src/telemetry.js");
	recordSpan(join(project, ".personaxis", "personaxis.md"), { name: "turn", ms: 1 }, { enabled: true });
}

describe("what reaches the disk", () => {
	it("writes nothing when the home config said no", async () => {
		// Even though the caller passed `{ enabled: true }`, which is exactly the
		// situation: a project config turned it on and the merge handed that to the sink.
		writeGlobal({ telemetry: { enabled: false } });
		writeProject({ telemetry: { enabled: true } });

		await record();
		expect(written()).toEqual([]);
	});

	it("writes when both layers agreed", async () => {
		// The control. A sink that never wrote would pass the test above and be useless.
		writeGlobal({ telemetry: { enabled: true } });
		writeProject({ telemetry: { enabled: true } });

		await record();
		expect(written().length).toBeGreaterThan(0);
	});

	it("writes nothing when nobody enabled it anywhere", async () => {
		await record();
		expect(written()).toEqual([]);
	});
});
