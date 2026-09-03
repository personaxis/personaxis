/**
 * Which layer wins, and the one setting where "nearest" is the wrong answer.
 *
 * `config-layers.ts` in the engine has held the ranks and the two rules since FR.5 with
 * no caller, while `loadMergedConfig` spread project over global: the ordinary rule,
 * implemented by accident, right for a model name and wrong for a decision about the
 * person using the machine.
 *
 * The case that matters is one somebody actually hits. You turn telemetry off in your
 * home config. You clone a repository whose `.personaxis/config.json` turns it on.
 * Under "nearest wins" the repository wins, and a choice you made about your own
 * machine is undone by a file you downloaded. Under the policy rule the off stays off,
 * and the project can still turn it off for itself.
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let home: string;
let project: string;

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "pxs-home-"));
	project = mkdtempSync(join(tmpdir(), "pxs-project-"));
	vi.spyOn(process, "cwd").mockReturnValue(project);
	process.env.PERSONAXIS_HOME = home;
});

afterEach(() => {
	vi.restoreAllMocks();
	delete process.env.PERSONAXIS_HOME;
	rmSync(home, { recursive: true, force: true });
	rmSync(project, { recursive: true, force: true });
});

/**
 * The GLOBAL config, which lives directly in the home directory.
 *
 * `PERSONAXIS_HOME` already names the `.personaxis` folder rather than its parent.
 * Written the other way at first, so the three assertions that depend on the home
 * layer were reading the REAL config of whoever ran the suite: two failed, one would
 * have passed or failed depending on the machine, which is worse.
 */
function writeGlobal(config: unknown): void {
	mkdirSync(home, { recursive: true });
	writeFileSync(join(home, "config.json"), JSON.stringify(config), "utf-8");
}

/** The PROJECT config, which lives under `.personaxis/` in the working directory. */
function writeProject(config: unknown): void {
	mkdirSync(join(project, ".personaxis"), { recursive: true });
	writeFileSync(join(project, ".personaxis", "config.json"), JSON.stringify(config), "utf-8");
}

/** Imported per test, because the module reads the layers when it is asked, not when loaded. */
async function resolve() {
	return import("../src/config-layers.js");
}

describe("telemetry, which is a policy decision", () => {
	it("stays off when the home config turned it off, whatever the project says", async () => {
		// The whole reason this rule exists.
		writeGlobal({ telemetry: { enabled: false } });
		writeProject({ telemetry: { enabled: true } });

		const { telemetryEnabled } = await resolve();
		expect(telemetryEnabled().value).toBe(false);
	});

	it("lets a project turn it off when the home config had it on", async () => {
		// The rule is one-way: a lower layer may tighten and never loosen. A project
		// that wants no log of its own work gets one.
		writeGlobal({ telemetry: { enabled: true } });
		writeProject({ telemetry: { enabled: false } });

		const { telemetryEnabled } = await resolve();
		expect(telemetryEnabled().value).toBe(false);
	});

	it("is on when both layers agree it should be", async () => {
		// The control. A rule that resolved to off no matter what would be a setting
		// that does not exist, which passes every test above.
		writeGlobal({ telemetry: { enabled: true } });
		writeProject({ telemetry: { enabled: true } });

		const { telemetryEnabled } = await resolve();
		expect(telemetryEnabled().value).toBe(true);
	});

	it("is on when only the home config asked for it", async () => {
		writeGlobal({ telemetry: { enabled: true } });

		const { telemetryEnabled } = await resolve();
		const resolved = telemetryEnabled();
		expect(resolved.value).toBe(true);
		expect(resolved.source).toBe("global");
	});

	it("is off when nobody said anything, and says who decided", async () => {
		// Off is the documented default and the only defensible one for a setting that
		// writes a log of what somebody did. Attributed rather than left blank: a caller
		// asking who decided always gets an answer.
		const { telemetryEnabled } = await resolve();
		const resolved = telemetryEnabled();

		expect(resolved.value).toBe(false);
		expect(resolved.source).toBe("managed");
	});
});

describe("an ordinary setting, where nearest does win", () => {
	it("takes the project's value over the home one", async () => {
		writeGlobal({ statusline: "from home" });
		writeProject({ statusline: "from project" });

		const { settingFrom } = await resolve();
		expect(settingFrom((config) => config.statusline)).toEqual({
			value: "from project",
			source: "project",
		});
	});

	it("falls back to the home value, and says so", async () => {
		// The attribution is the point. Somebody asking why a value is in effect is
		// usually asking because it is not the one they set.
		writeGlobal({ statusline: "from home" });

		const { settingFrom } = await resolve();
		expect(settingFrom((config) => config.statusline)).toEqual({
			value: "from home",
			source: "global",
		});
	});

	it("answers nothing when no layer defines it", async () => {
		const { settingFrom } = await resolve();
		expect(settingFrom((config) => config.statusline)).toBeUndefined();
	});
});
