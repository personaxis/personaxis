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

import { createContext, runInContext, Script } from "node:vm";

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

/** One `<script>` the page carries itself, and where in the file it starts. */
interface OwnScript {
	readonly body: string;
	/**
	 * E103: lines before this script's first line, so a fault can be reported at its line in the FILE.
	 *
	 * The script's own coordinates are useless to whoever has to fix it: told "line 24" of a body that starts
	 * on line 31, a persona edits line 24 of the page, which is a different line and usually the markup.
	 */
	readonly linesBefore: number;
}

/** Every `<script>` the page carries itself, without the ones that name a `src`. */
function ownScripts(html: string): OwnScript[] {
	const out: OwnScript[] = [];
	for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
		const body = m[2] ?? "";
		if (/\bsrc\s*=/i.test(m[1] ?? "") || body.trim().length === 0) continue;
		// Where the body starts: the opening tag is `<script` plus its attributes plus `>`, so its length is
		// known without searching for the body inside the match, which would find the wrong place for a script
		// whose text happens to repeat its own tag.
		const bodyStart = (m.index ?? 0) + "<script".length + (m[1] ?? "").length + 1;
		out.push({ body, linesBefore: (html.slice(0, bodyStart).match(/\n/g) ?? []).length });
	}
	return out;
}

/**
 * E103: the name each script runs under, so its faults can be found in the stack by an exact match.
 *
 * Without one, `node:vm` calls every script `evalmachine.<anonymous>`, which is also what any other vm in the
 * process is called, and a stack read by pattern would be reading somebody else's frames.
 */
const scriptName = (index: number): string => `personaxis-page-script-${index}`;

/**
 * Where a fault is, in the line numbers of the file, read from the error's own stack.
 *
 * V8 already knows this and puts it in the stack twice over: a syntax error's stack opens with the file, the
 * line, the offending source and a caret under the column, and a runtime error carries `file:line:column` in
 * every frame. `check_page` threw all of it away and returned the bare message, so a persona told its page did
 * not compile had a file it could only edit by search and replace and no idea which of its own edits broke it.
 * Measured on 2026-09-21 over the autonomy bench: on `fix-crash`, four of six runs across two models ended in
 * `stopped: max_steps` after editing and re-checking in a circle, and the one that finished said it was fixed
 * with the file still broken.
 */
function faultSite(error: unknown, scripts: readonly OwnScript[]): { line: number; column: number | null; source: string | null } | null {
	const stack = stackOf(error);
	if (!stack) return null;
	for (const [index, script] of scripts.entries()) {
		const name = scriptName(index).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		const at = new RegExp(`${name}:(\\d+)(?::(\\d+))?`).exec(stack);
		if (!at) continue;
		const inScript = Number(at[1]);
		if (!Number.isFinite(inScript) || inScript < 1) return null;
		const line = script.linesBefore + inScript;
		const column = at[2] === undefined ? null : Number(at[2]);
		// The source line comes from the script and not from the stack: the stack only carries it for syntax
		// errors, and it is the same line either way.
		const source = script.body.split(/\r?\n/)[inScript - 1] ?? null;
		return { line, column: Number.isFinite(column as number) ? column : null, source: source === null ? null : source.trim() };
	}
	return null;
}

/**
 * The stack of whatever was thrown, without asking whether it is an `Error`.
 *
 * It usually is not. A fault thrown while the page runs is built inside the vm context, so it carries THAT
 * realm's `Error` prototype and `e instanceof Error` is false out here, even though it has a message and a
 * stack. A syntax error is the exception, because the compiler throws it before the context exists. The first
 * version of this asked `instanceof` and so found the line for a page that does not compile and never for one
 * that dies while playing, which is the half that sends a persona hunting.
 */
function stackOf(error: unknown): string {
	if (typeof error !== "object" || error === null) return "";
	const stack = (error as { stack?: unknown }).stack;
	return typeof stack === "string" ? stack : "";
}

/** What was thrown, as a sentence, whatever realm built it. */
function messageOf(error: unknown): string {
	if (typeof error !== "object" || error === null) return String(error);
	const message = (error as { message?: unknown }).message;
	const name = (error as { name?: unknown }).name;
	if (typeof message !== "string") return String(error);
	return typeof name === "string" && name.length > 0 ? `${name}: ${message}` : message;
}

/** A fault, said with its place in the file when the stack knew one. */
function withSite(what: string, error: unknown, scripts: readonly OwnScript[]): string {
	const site = faultSite(error, scripts);
	const message = messageOf(error);
	if (site === null) return `${what}: ${message}`;
	const where = site.column === null ? `line ${site.line}` : `line ${site.line}, column ${site.column}`;
	// The line itself, quoted, because counting to line 24 of a file you cannot see is the work this saves.
	const quoted = site.source ? `, which reads \`${site.source.slice(0, 160)}\`` : "";
	return `${what}, at ${where} of the file${quoted}: ${message}`;
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
		for (const [index, script] of scripts.entries()) runInContext(script.body, vm, { timeout: 5000, filename: scriptName(index) });
	} catch (e) {
		return { ok: false, error: withSite("on load", e, scripts), frames: 0, drew: drew(), listens: listens() };
	}

	for (let i = 0; i < frames; i += 1) {
		clock += 16;
		for (const t of timers.filter((t) => t.at <= clock)) {
			try {
				t.fn();
			} catch (e) {
				return { ok: false, error: withSite(`after ${i} frames, in a timer`, e, scripts), frames: i, drew: drew(), listens: listens() };
			}
			if (t.every) t.at = clock + t.every;
			else timers.splice(timers.indexOf(t), 1);
		}
		for (const fn of raf.splice(0, raf.length)) {
			try {
				fn(clock);
			} catch (e) {
				return { ok: false, error: withSite(`after ${i} frames`, e, scripts), frames: i, drew: drew(), listens: listens() };
			}
		}
	}

	return { ok: true, error: null, frames, drew: drew(), listens: listens() };
}

/**
 * E132: whether a file's own scripts still compile, WITHOUT running them, said the way `check_page` says it.
 *
 * `write_file` and `edit_file` call this on the file as it now stands, so an edit that breaks the syntax says
 * so in its own result, in the step that broke it. Measured on 2026-09-24 (`e121c`): in the two long sessions
 * that ended with a broken game, the persona saw its check fail three steps later, named the missing comma
 * correctly, and closed the turn explaining it instead of fixing it.
 *
 * The same compiler as `runPage` (`node:vm`) and the same way of citing the line, so the two can never disagree
 * about whether a page compiles. A script that uses `import` or `export` is not judged: this compiler reads
 * classic scripts, and calling a module broken because of its first `import` would teach the persona to
 * ignore the warning. Null means nothing to report: it compiles, or it was not judged.
 */
export function syntaxFault(path: string, content: string): string | null {
	const lower = path.toLowerCase();
	const scripts: OwnScript[] = lower.endsWith(".html") || lower.endsWith(".htm")
		? ownScripts(content)
		: lower.endsWith(".js")
			? [{ body: content, linesBefore: 0 }]
			: [];
	for (const [index, script] of scripts.entries()) {
		if (/^\s*(import|export)\b/m.test(script.body)) continue;
		try {
			new Script(script.body, { filename: scriptName(index) });
		} catch (e) {
			return withSite(`${path} does not compile now`, e, scripts);
		}
	}
	return null;
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
