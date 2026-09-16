/**
 * E99: what a sub-task that worked and said nothing hands back to its parent.
 *
 * Measured on 2026-09-16 in the four colleague runs of `E87`: three sub-tasks closed answered after four steps
 * with no answer at all, and everything they had done was invisible to the asker, because the only thing that
 * crosses a delegation is the answer.
 */
import { describe, expect, it } from "vitest";

import { wordlessReport } from "../src/run/wordless.js";

const check = (what: string, passed: boolean) => ({ what, how: "ran it for 10 seconds of frames", passed });

describe("what a wordless sub-task reports (E99)", () => {
	it("says nothing when the sub-task actually answered", () => {
		expect(wordlessReport({ answer: "here is the review", calls: [{ tool: "read_file", verdict: "allowed" }] })).toBeUndefined();
	});

	it("says nothing when the sub-task did nothing, because that sentence already exists", () => {
		// A report saying no work happened, in place of "the sub-task produced no answer", would be two ways of
		// saying one thing and neither of them shorter.
		expect(wordlessReport({ answer: "" })).toBeUndefined();
		expect(wordlessReport({ answer: "   ", calls: [] })).toBeUndefined();
	});

	it("names the tools whose calls the gate allowed, and not the ones it refused", () => {
		const said = wordlessReport({
			answer: "",
			calls: [
				{ tool: "list_dir", verdict: "allowed" },
				{ tool: "check_page", verdict: "denied" },
				{ tool: "read_file", verdict: "allowed" },
			],
		});

		expect(said).toContain("list_dir");
		expect(said).toContain("read_file");
		expect(said).not.toContain("check_page");
	});

	it("does not repeat a tool it used ten times", () => {
		const said = wordlessReport({ answer: "", calls: Array.from({ length: 10 }, () => ({ tool: "read_file", verdict: "allowed" })) });

		expect(said?.match(/read_file/g)).toHaveLength(1);
	});

	it("carries what was left and what running it proved, failure included", () => {
		const said = wordlessReport({
			answer: "",
			delivered: { checks: [check("/w/game.html", false), check("/w/ok.html", true)], unverified: [] },
		});

		expect(said).toContain("game.html: ran it for 10 seconds of frames, and it FAILED");
		expect(said).toContain("ok.html: ran it for 10 seconds of frames, and it worked");
	});

	it("names what nothing could check, because an absence nobody names reads as verified", () => {
		const said = wordlessReport({ answer: "", delivered: { checks: [], unverified: ["/w/REVIEW.md"] } });

		expect(said).toContain("REVIEW.md: left, and nothing could check it automatically");
	});

	it("says plainly that no answer was written, so the parent is not told a summary it never got", () => {
		const said = wordlessReport({ answer: "", calls: [{ tool: "read_file", verdict: "allowed" }] });

		expect(said).toContain("finished without writing an answer");
	});
});
