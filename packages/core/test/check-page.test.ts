/**
 * Running a page instead of reading it.
 *
 * Measured on 2026-09-11: a persona's own review step said "no discrepancies were found" about a
 * game that painted a road and then died five seconds in with `ReferenceError: vehicleSpeed is not
 * defined`, the moment the first car spawned. Reading was all it could do.
 */

import { describe, expect, it } from "vitest";

import { runPage } from "../src/web/run-page.js";

const page = (script: string) => `<!doctype html><canvas id="s"></canvas><script>${script}</script>`;

/** A loop that survives: it draws every frame and reads the clock in seconds. */
const GOOD = page(`
	const ctx = document.getElementById("s").getContext("2d");
	let x = 0;
	addEventListener("keydown", () => { x += 1; });
	let last = performance.now();
	requestAnimationFrame(function frame(now) {
		const dt = (now - last) / 1000; last = now;
		x += 10 * dt;
		ctx.fillRect(x, 0, 4, 4);
		requestAnimationFrame(frame);
	});
`);

describe("running a page the persona wrote", () => {
	it("says a working page runs, and what it listens for", () => {
		const r = runPage(GOOD, { frames: 120 });
		expect(r.ok).toBe(true);
		expect(r.error).toBeNull();
		expect(r.frames).toBe(120);
		expect(r.drew).toBeGreaterThan(100);
		expect(r.listens).toContain("keydown");
	});

	it("catches the fault that only happens once the clock has moved, with its frame", () => {
		// The real shape of the bug: a name misspelled on a branch nothing takes on frame one.
		const late = page(`
			const ctx = document.getElementById("s").getContext("2d");
			const state = { things: [], speed: 3, t: 0 };
			requestAnimationFrame(function frame(now) {
				state.t = now;
				if (state.t > 1000) state.things.push({ x: 0 });
				for (const thing of state.things) thing.x -= speed;
				ctx.fillRect(0, 0, 4, 4);
				requestAnimationFrame(frame);
			});
		`);
		const r = runPage(late, { frames: 300 });
		expect(r.ok).toBe(false);
		expect(r.error).toContain("speed is not defined");
		expect(r.error).toMatch(/after \d+ frames/);
		// It got far enough to have drawn, which is why a screenshot of frame one proves nothing.
		expect(r.drew).toBeGreaterThan(0);
	});

	it("catches one that throws on load, before any frame", () => {
		const r = runPage(page("missingFunction();"), { frames: 60 });
		expect(r.ok).toBe(false);
		expect(r.error).toContain("on load");
		expect(r.frames).toBe(0);
	});

	it("says so when there is no script of its own to run", () => {
		const r = runPage('<!doctype html><script src="game.js"></script>', { frames: 60 });
		expect(r.ok).toBe(false);
		expect(r.error).toContain("no script of its own");
	});

	it("gives the page no way off this machine", () => {
		// The page was written by a model. Nothing in its world reaches the filesystem or the network.
		const r = runPage(page("window.escaped = [typeof require, typeof process, typeof fetch].join(',');"), { frames: 1 });
		expect(r.ok).toBe(true);
		const probe = runPage(page("require('node:fs');"), { frames: 1 });
		expect(probe.ok).toBe(false);
		expect(probe.error).toContain("on load");
	});

	it("runs a page that bakes a sprite into an image, which a browser runs fine", () => {
		// Found on 2026-09-14 in a game a model wrote: an offscreen canvas turned into an image on load
		// "crashed" here with `toDataURL is not a function`, and would have sent the persona chasing a
		// fault no browser has.
		const baking = page(`
			const sprite = document.createElement("canvas");
			sprite.getContext("2d").fillRect(0, 0, 8, 8);
			const image = new Image();
			image.src = sprite.toDataURL("image/png");
			sprite.toBlob(() => {});
			const ctx = document.getElementById("s").getContext("2d");
			requestAnimationFrame(function frame() { ctx.fillRect(0, 0, 1, 1); requestAnimationFrame(frame); });
		`);
		const r = runPage(baking, { frames: 60 });
		expect(r.error).toBeNull();
		expect(r.ok).toBe(true);
	});

	/**
	 * E103: a fault comes back with its line in the FILE, because a fault with no place cannot be fixed.
	 *
	 * Measured on 2026-09-21 over the autonomy bench. On `fix-crash`, a persona broke its own page with an edit
	 * and was told `on load: SyntaxError: Unexpected token ':'` and nothing else. It had a file it could only
	 * change by search and replace and no way to know which of its own edits broke it, so it guessed: four of
	 * six runs across two models ended in `stopped: max_steps` after editing and re-checking in a circle, and
	 * the one that finished announced the page fixed with the syntax error still in it. V8 knew the line all
	 * along and `check_page` dropped it.
	 */
	describe("where the fault is (E103)", () => {
		/** Markup above the script, so the line in the script and the line in the file are different numbers. */
		const withPreamble = (script: string) =>
			`<!doctype html>\n<html>\n<head><title>a game</title></head>\n<body>\n<canvas id="s"></canvas>\n<script>\n${script}\n</script>\n</body>\n</html>\n`;

		it("gives the line of the file, not the line of the script, for a page that does not compile", () => {
			// The shape a bad edit leaves: an object closed early, and the properties under it orphaned.
			const broken = withPreamble('const state = {\n  x: 0\n};\n  y: 200,\n  z: 0\n};\nconsole.log("never");');
			const r = runPage(broken, { frames: 60 });

			expect(r.ok).toBe(false);
			expect(r.error).toContain("SyntaxError");
			// The line the parse gives up on, which is V8's and not ours: `y: 200,` still reads as a label, so
			// it is `z: 0` underneath that cannot, line 5 of the script and line 11 of the file. What matters is
			// that the number is the file's, and the script starts six lines down.
			expect(r.error).toContain("line 11");
			expect(r.error).toContain("z: 0");
			expect(broken.split("\n")[10]).toContain("z: 0");
		});

		it("gives the line of a fault that only happens once the game is running", () => {
			const late = withPreamble(
				'const ctx = document.getElementById("s").getContext("2d");\nlet frames = 0;\nrequestAnimationFrame(function frame() {\n  frames += 1;\n  if (frames > 10) missingSpeed.x = 1;\n  ctx.fillRect(0, 0, 1, 1);\n  requestAnimationFrame(frame);\n});',
			);
			const r = runPage(late, { frames: 60 });

			expect(r.ok).toBe(false);
			expect(r.error).toContain("missingSpeed is not defined");
			expect(r.error).toContain("line 11");
			expect(late.split("\n")[10]).toContain("missingSpeed");
		});

		it("still says what broke when the stack knows no line", () => {
			// A value thrown that is not an Error carries no stack, and the fault still has to be reported.
			const r = runPage(page('throw "no stack on a string";'), { frames: 60 });

			expect(r.ok).toBe(false);
			expect(r.error).toContain("on load");
			expect(r.error).toContain("no stack on a string");
			expect(r.error).not.toContain("line ");
		});

		it("counts from the script that threw when a page carries more than one", () => {
			const two = `<!doctype html>\n<canvas id="s"></canvas>\n<script>\nwindow.first = 1;\n</script>\n<script>\nwindow.second = 2;\nmissingInTheSecond();\n</script>\n`;
			const r = runPage(two, { frames: 60 });

			expect(r.ok).toBe(false);
			expect(r.error).toContain("line 8");
			expect(two.split("\n")[7]).toContain("missingInTheSecond");
		});
	});

	it("runs a page that waits for the document, rather than reporting a page that never starts", () => {
		const waiting = page(`
			document.addEventListener("DOMContentLoaded", () => {
				const ctx = document.getElementById("s").getContext("2d");
				requestAnimationFrame(function frame() { ctx.fillRect(0, 0, 1, 1); requestAnimationFrame(frame); });
			});
		`);
		const r = runPage(waiting, { frames: 60 });
		expect(r.ok).toBe(true);
		expect(r.drew).toBeGreaterThan(0);
	});
});
