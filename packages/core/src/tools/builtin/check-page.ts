/**
 * `check_page`: run a web page this persona wrote and report what broke.
 *
 * A review that can only READ a page approves any page whose text looks right. Measured on
 * 2026-09-11: a persona's own review step said "no discrepancies were found" about a game that
 * painted a road and then died five seconds in on a misspelled variable. See `web/run-page.ts` for
 * what running it does and does not cover.
 *
 * Read-only on purpose: it reads the file through the same guard as `read_file` and writes nothing.
 * The page's own scripts run isolated, with no filesystem, no network and no way back to this
 * machine.
 */
import { renderPageRun, runPage } from "../../web/run-page.js";
import { defineTool } from "../define.js";
import { readGate } from "../gates.js";

/** Frames per second a browser drives, for turning the seconds asked for into frames. */
const FPS = 60;

export const checkPageTool = defineTool({
	name: "check_page",
	category: "fs",
	isReadOnly: true,
	isConcurrencySafe: true,
	description:
		"Run an HTML page you wrote and report whether it crashes. Use it on any page that has to work, before saying it does: it runs the page's own scripts for a few seconds of frames and returns the error and the frame it happened on. It does not lay out, style or paint anything, so it says nothing about how the page looks.",
	parameters: {
		type: "object",
		additionalProperties: false,
		required: ["path"],
		properties: {
			path: { type: "string", description: "The HTML file, relative to the workspace root." },
			seconds: { type: "number", description: "How long to run it, 1 to 30 (default 10)." },
		},
	},
	gate: (args, policy) => readGate(args.path, policy),
	execute: async (args, policy, execution) => {
		const r = await execution.readFile(args.path, policy);
		if (!r.ok) return `error: ${r.error}`;
		const seconds = Math.min(Math.max(typeof args.seconds === "number" ? args.seconds : 10, 1), 30);
		return renderPageRun(r.path, runPage(r.content ?? "", { frames: seconds * FPS }), seconds);
	},
});
