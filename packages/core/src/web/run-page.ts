/**
 * Running a web page the persona just wrote, so it can see that it crashed.
 *
 * ## Why this exists
 *
 * Measured on 2026-09-11. A persona was asked for a game as one HTML file, wrote it, and then ran
 * its own review step: "every control is in the code", "the win and lose conditions exist", "no
 * discrepancies were found". Opened in a browser the game painted a road and a cat and died five
 * seconds later with `ReferenceError: vehicleSpeed is not defined`, the moment the first car
 * spawned. The review was not lying on purpose: it had READ the file, and reading is all it could
 * do. A review that cannot run what it reviews approves anything whose text looks right.
 *
 * So the persona gets to run it. Ten seconds of frames against a minimal DOM, and whatever threw
 * comes back with its message and the frame it happened on. That is the class of fault that kills
 * these pages, a name misspelled inside the loop, invisible to any amount of reading.
 *
 * ## What it is not
 *
 * Not a browser, and it does not pretend to be one. Nothing is laid out, nothing is styled, nothing
 * is painted: the canvas counts the calls and draws nothing. It answers one question, does this page
 * run, and a page that runs clean here can still look wrong to a person. Whoever reads the result
 * gets told that.
 *
 * ## Running somebody else's code
 *
 * The page was written by a model, so it runs in `node:vm` with a context built here and nothing
 * else in it: no `require`, no `import`, no `process`, no `fetch`, no filesystem. There is no path
 * from the page to this machine. It cannot run forever either: the frames are counted, and each
 * script gets a wall-clock limit on load.
 */

import { createContext, runInContext } from "node:vm";

export interface PageRun {
	/** It ran every frame asked for without throwing. */
	ok: boolean;
	/** What threw, with the frame it threw on, or null. */
	error: string | null;
	/** Frames actually run. Short of what was asked means it stopped there. */
	frames: number;
	/** How many drawing calls the page made. Zero is normal for a page that uses DOM elements. */
	drew: number;
	/** The kinds of event it listens for, which is how it would hear a player. */
	listens: string[];
}

/** Every `<script>` the page carries itself, without the ones that name a `src`. */
function ownScripts(html: string): string[] {
	return [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)]
		.filter((m) => !/\bsrc\s*=/i.test(m[1] ?? ""))
		.map((m) => m[2] ?? "")
		.filter((body) => body.trim().length > 0);
}

/** An element that accepts everything, does nothing, and remembers who listens. */
function fakeElement(listeners: Array<{ type: string; fn: () => void }>): Record<string, unknown> {
	const el: Record<string, unknown> = {
		style: {},
		dataset: {},
		classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
		width: 480,
		height: 320,
		textContent: "",
		innerHTML: "",
		children: [] as unknown[],
		addEventListener: (type: string, fn: () => void) => listeners.push({ type, fn }),
		removeEventListener() {},
		appendChild(child: unknown) {
			(el.children as unknown[]).push(child);
			return child;
		},
		removeChild() {},
		remove() {},
		setAttribute() {},
		getAttribute: () => null,
		getBoundingClientRect: () => ({ left: 0, top: 0, width: 480, height: 320, right: 480, bottom: 320 }),
		// What a real canvas exports. Without these, a page that draws a sprite onto an offscreen canvas and
		// turns it into an image "crashed on load" here while running fine in a browser, and the persona would
		// be told to fix a fault that does not exist. Found on 2026-09-14 in a game a model wrote.
		toDataURL: () => "data:image/png;base64,",
		toBlob(callback: unknown) {
			if (typeof callback === "function") (callback as (blob: null) => void)(null);
		},
		focus() {},
		querySelector: () => fakeElement(listeners),
		querySelectorAll: () => [],
	};
	return el;
}

/** A 2D context that counts what it is asked for and paints nothing. */
function fakeContext(painted: Record<string, number>): Record<string, unknown> {
	const noop = (name: string) => () => {
		painted[name] = (painted[name] ?? 0) + 1;
	};
	const ctx: Record<string, unknown> = {
		canvas: { width: 480, height: 320 },
		fillStyle: "",
		strokeStyle: "",
		lineWidth: 1,
		font: "",
		textAlign: "",
		textBaseline: "",
		globalAlpha: 1,
		measureText: () => ({ width: 10 }),
		createLinearGradient: () => ({ addColorStop() {} }),
		createRadialGradient: () => ({ addColorStop() {} }),
		createPattern: () => null,
		getImageData: () => ({ data: new Uint8ClampedArray(4) }),
		putImageData() {},
		drawImage: noop("drawImage"),
	};
	for (const name of [
		"fillRect", "strokeRect", "clearRect", "beginPath", "closePath", "moveTo", "lineTo", "arc",
		"arcTo", "rect", "ellipse", "fill", "stroke", "save", "restore", "translate", "rotate",
		"scale", "setTransform", "resetTransform", "fillText", "strokeText", "clip", "setLineDash",
		"quadraticCurveTo", "bezierCurveTo", "roundRect",
	]) {
		ctx[name] = noop(name);
	}
	return ctx;
}

/** How many frames ten seconds is, at the rate a browser drives one. */
const DEFAULT_FRAMES = 600;

/**
 * Runs a page's own scripts for `frames` frames of 16 ms and says whether it survived.
 *
 * The clock advances, which is the whole point: a fault that only happens once something has
 * spawned, or once a timer has fired, does not show on frame one.
 */
export function runPage(html: string, opts: { frames?: number } = {}): PageRun {
	const frames = Math.min(Math.max(opts.frames ?? DEFAULT_FRAMES, 1), 5000);
	const scripts = ownScripts(html);
	if (scripts.length === 0) return { ok: false, error: "this page carries no script of its own", frames: 0, drew: 0, listens: [] };

	const listeners: Array<{ type: string; fn: () => void }> = [];
	const painted: Record<string, number> = {};
	const raf: Array<(t: number) => void> = [];
	const timers: Array<{ at: number; fn: () => void; every?: number }> = [];
	let clock = 0;

	const context = fakeContext(painted);
	const element = () => Object.assign(fakeElement(listeners), { getContext: () => context });
	const hear = (type: string, fn: () => void): void => {
		listeners.push({ type, fn });
		// A page that waits for the document never starts unless somebody tells it the document is here.
		if (type === "DOMContentLoaded" || type === "load") timers.push({ at: clock, fn });
	};

	const document = {
		getElementById: () => element(),
		querySelector: () => element(),
		querySelectorAll: () => [],
		createElement: () => element(),
		createTextNode: () => ({}),
		addEventListener: hear,
		removeEventListener() {},
		body: element(),
		documentElement: element(),
		readyState: "complete",
	};

	const sandbox: Record<string, unknown> = {
		document,
		console: { log() {}, warn() {}, error() {}, info() {}, debug() {} },
		requestAnimationFrame: (fn: (t: number) => void) => raf.push(fn),
		cancelAnimationFrame() {},
		setTimeout: (fn: () => void, ms = 0) => timers.push({ at: clock + ms, fn }),
		clearTimeout() {},
		setInterval: (fn: () => void, ms = 16) => timers.push({ at: clock + ms, fn, every: Math.max(ms, 1) }),
		clearInterval() {},
		addEventListener: hear,
		removeEventListener() {},
		performance: { now: () => clock },
		Math,
		JSON,
		localStorage: { getItem: () => null, setItem() {}, removeItem() {}, clear() {} },
		navigator: { userAgent: "headless", maxTouchPoints: 0 },
		Image: class {
			set src(_v: string) {}
			addEventListener() {}
		},
		Audio: class {
			play() {
				return Promise.resolve();
			}
			pause() {}
			addEventListener() {}
		},
		AudioContext: class {
			createOscillator() {
				return { connect() {}, start() {}, stop() {}, frequency: { value: 0, setValueAtTime() {} }, type: "" };
			}
			createGain() {
				return { connect() {}, gain: { value: 0, setValueAtTime() {}, exponentialRampToValueAtTime() {}, linearRampToValueAtTime() {} } };
			}
			get destination() {
				return {};
			}
			get currentTime() {
				return clock / 1000;
			}
		},
		alert() {},
		innerWidth: 1024,
		innerHeight: 768,
		devicePixelRatio: 1,
	};
	sandbox.window = sandbox;
	sandbox.globalThis = sandbox;
	sandbox.webkitAudioContext = sandbox.AudioContext;

	const drew = (): number => Object.values(painted).reduce((a, b) => a + b, 0);
	const listens = (): string[] => [...new Set(listeners.map((l) => l.type))];

	const vm = createContext(sandbox);
	try {
		for (const body of scripts) runInContext(body, vm, { timeout: 5000 });
	} catch (e) {
		return { ok: false, error: `on load: ${e instanceof Error ? e.message : String(e)}`, frames: 0, drew: drew(), listens: listens() };
	}

	for (let i = 0; i < frames; i += 1) {
		clock += 16;
		for (const t of timers.filter((t) => t.at <= clock)) {
			try {
				t.fn();
			} catch (e) {
				return { ok: false, error: `after ${i} frames, in a timer: ${e instanceof Error ? e.message : String(e)}`, frames: i, drew: drew(), listens: listens() };
			}
			if (t.every) t.at = clock + t.every;
			else timers.splice(timers.indexOf(t), 1);
		}
		for (const fn of raf.splice(0, raf.length)) {
			try {
				fn(clock);
			} catch (e) {
				return { ok: false, error: `after ${i} frames: ${e instanceof Error ? e.message : String(e)}`, frames: i, drew: drew(), listens: listens() };
			}
		}
	}

	return { ok: true, error: null, frames, drew: drew(), listens: listens() };
}

/** The result as the model reads it: the verdict, then what it does not cover. */
export function renderPageRun(path: string, run: PageRun, seconds: number): string {
	if (!run.ok) {
		return [
			`${path} does NOT run: ${run.error}`,
			"",
			"That is a real fault a player would hit. Fix it in the page, then check it again.",
		].join("\n");
	}
	return [
		`${path} ran ${seconds} seconds of frames without throwing.`,
		`It listens for: ${run.listens.length ? run.listens.join(", ") : "nothing, so a player cannot reach it"}. Drawing calls: ${run.drew}.`,
		"",
		"This says the page does not crash. It says nothing about how it looks, whether it is laid out, or whether it is any fun: nothing here is styled or painted, and no input was sent.",
	].join("\n");
}
