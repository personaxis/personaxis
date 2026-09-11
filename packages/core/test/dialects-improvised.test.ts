/**
 * What open models actually write when nothing applied their chat template.
 *
 * The five templated dialects all require a special token: `<tool_call>`, `[TOOL_CALLS]`,
 * `<|python_tag|>`, `<｜tool▁calls▁begin｜>`, `<invoke`. That token is inserted by the server
 * when it applies the model's template with a tools section, and it is what makes those
 * patterns safe to match.
 *
 * Measured 2026-09-10 against the HuggingFace router with one tool described in plain prose in
 * the system message and no `tools` field, which is what a simple integration does and what a
 * server missing that model's template does. **Four of four open models tried to call the tool
 * and zero of the five dialects matched any of them.** The strings below are what they
 * literally returned, kept verbatim so this suite is a recording and not an impression.
 */

import { describe, expect, it } from "vitest";

import { readDialect } from "../src/tools/dialects.js";

const OFFERED = ["get_charge"];

/** Verbatim, from `research/experiments/results/dialects-live.json`. */
const OBSERVED = {
	"gemma-3-4b-it": 'call_get_charge({"id": "ch_42"})',
	"Llama-3.1-8B": 'get_charge({"id": "ch_42"})',
	"Apertus-v1.5-8B": 'call get_charge with {"id": "ch_42"}',
	"granite-4.2-8b": '{"id": "ch_42"}',
};

describe("what four open models actually emitted", () => {
	for (const [model, text] of Object.entries(OBSERVED)) {
		if (model === "granite-4.2-8b") continue;
		it(`reads the call ${model} wrote`, () => {
			const reading = readDialect(text, OFFERED);
			expect(reading?.calls).toHaveLength(1);
			expect(reading?.calls[0]?.name).toBe("get_charge");
			expect(reading?.calls[0]?.args).toEqual({ id: "ch_42" });
		});
	}

	it("does NOT read the one that named no tool, because that name would be a guess", () => {
		// granite returned bare arguments. Reading it would mean choosing a tool for the
		// model, and a call whose name had to be guessed is a call nobody asked for.
		expect(readDialect(OBSERVED["granite-4.2-8b"], OFFERED)?.calls ?? []).toHaveLength(0);
	});
});

describe("the loose pattern stays safe", () => {
	it("drops a name that was not offered, and says which", () => {
		const reading = readDialect('delete_everything({"confirm": true})', OFFERED);
		expect(reading?.calls ?? []).toHaveLength(0);
		expect(reading?.unknown).toContain("delete_everything");
	});

	it("does not read prose that merely mentions the tool", () => {
		const text = "I would call get_charge for you, but I need the charge id first.";
		expect(readDialect(text, OFFERED)?.calls ?? []).toHaveLength(0);
	});

	it("does not invent empty arguments when the JSON is broken", () => {
		// Reading the name and passing {} would run the tool with nothing in it, which is
		// worse than not reading it at all.
		expect(readDialect('get_charge({"id": ch_42})', OFFERED)?.calls ?? []).toHaveLength(0);
	});

	it("does not fire on ordinary code in a reply", () => {
		const text = "Use `JSON.parse({...})` to read it, or call format with {} as the default.";
		const reading = readDialect(text, OFFERED);
		expect(reading?.calls ?? []).toHaveLength(0);
	});
});

describe("the templated dialects still win, because their marker is evidence", () => {
	it("reads hermes as hermes and not as improvised", () => {
		const text = '<tool_call>{"name": "get_charge", "arguments": {"id": "ch_42"}}</tool_call>';
		const reading = readDialect(text, OFFERED);
		expect(reading?.dialect).toBe("hermes");
		expect(reading?.calls).toHaveLength(1);
	});

	it("reads xml as xml", () => {
		const text = '<invoke name="get_charge"><parameter name="id">ch_42</parameter></invoke>';
		expect(readDialect(text, OFFERED)?.dialect).toBe("xml");
	});

	describe("the control of the control", () => {
		it("before this dialect existed, every observed string read as nothing", () => {
			// The five templated markers, applied to what the models actually wrote. All miss,
			// which is the measurement this whole suite exists to record.
			const MARKERS = [/<tool_call>/i, /\[TOOL_CALLS\]/, /<\|python_tag\|>/, /<｜tool▁calls▁begin｜>/, /<invoke\b/i];
			for (const text of Object.values(OBSERVED)) {
				expect(MARKERS.some((m) => m.test(text))).toBe(false);
			}
		});
	});
});
