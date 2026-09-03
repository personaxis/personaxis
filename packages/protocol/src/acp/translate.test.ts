/**
 * The translation, exhaustively, plus the guard that catches the protocol moving.
 *
 * Every one of our seven stop reasons has a test here, because `A1` asks for that
 * and because the translation is where a foreign vocabulary becomes ours: a
 * mistake at this desk is written into the record and stays true-looking.
 */

import { createRequire } from "node:module";
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { ACP_STOP_REASONS, failureOf, isAcpStopReason, productOf } from "./translate.js";

const NOTHING = { text: "", steps: 0 };

describe("the five words ACP can say", () => {
	it("end_turn with something said is an answer", () => {
		const product = productOf("end_turn", { text: "done", steps: 2 });
		expect(product.stopReason).toBe("answered");
		expect(product.answer).toBe("done");
		expect(product.steps).toBe(2);
	});

	it("end_turn with nothing said is empty, and the reason comes from the content", () => {
		// The point of the pair: one word on the wire, two facts in the record.
		expect(productOf("end_turn", NOTHING).stopReason).toBe("empty");
		expect(productOf("end_turn", { text: "x", steps: 0 }).stopReason).toBe("answered");
	});

	it("both of the agent's ceilings are budget, and it keeps what it had", () => {
		for (const word of ["max_tokens", "max_turn_requests"]) {
			const product = productOf(word, { text: "half an answer", steps: 1 });
			expect(product.stopReason, word).toBe("budget");
			expect(product.answer, word).toBe("half an answer");
		}
	});

	it("refusal is refused", () => {
		expect(productOf("refusal", { text: "I won't", steps: 0 }).stopReason).toBe("refused");
	});
});

describe("cancelled, which is the ambiguous one", () => {
	it("becomes whichever of ours made us cancel", () => {
		for (const cause of ["interrupted", "stopped", "budget", "refused"] as const) {
			const product = productOf("cancelled", { text: "", steps: 0, cancelCause: cause });
			expect(product.stopReason, cause).toBe(cause);
		}
	});

	it("with no cause recorded, blames nobody's rule and nobody's ceiling", () => {
		// An agent may report `cancelled` for a cancel we did not send. Calling that
		// a budget would claim a ceiling was reached, and calling it `stopped` would
		// credit a rule that never fired. Both invent a fact; `interrupted` at worst
		// misattributes an act nobody else claimed.
		expect(productOf("cancelled", NOTHING).stopReason).toBe("interrupted");
	});
});

describe("a word this build does not know", () => {
	it("is failed with the word carried through, never guessed into one of ours", () => {
		const product = productOf("out_of_cheese", { text: "partial", steps: 3 });
		expect(product.stopReason).toBe("failed");
		expect(product.failure?.code).toBe("unrecognised_acp_stop");
		expect(product.failure?.message).toContain("out_of_cheese");
		// The half answer is dropped: a report is not a reply.
		expect(product.answer).toBe("");
		// The steps still happened, whatever the ending was called.
		expect(product.steps).toBe(3);
	});
});

describe("a turn that broke rather than ended", () => {
	it("is failed, and drops the answer for the same reason", () => {
		const product = failureOf("acp_transport", "socket closed", { text: "half", steps: 1 });
		expect(product.stopReason).toBe("failed");
		expect(product.failure).toEqual({ code: "acp_transport", message: "socket closed" });
		expect(product.answer).toBe("");
	});
});

describe("cost", () => {
	it("is not the translator's to report, because ACP only reports session totals", () => {
		// Every spend figure ACP sends is cumulative for the session, so a turn's
		// share is a subtraction the translator cannot do: it is handed one turn and
		// there is no second number in it. The provider owns the session and does the
		// arithmetic. What matters here is that nothing invents a figure on the way.
		expect(productOf("end_turn", { text: "a", steps: 1 }).cost).toBeUndefined();
		expect(failureOf("acp_transport", "gone", NOTHING).cost).toBeUndefined();
	});
});

describe("all seven of ours are reachable through the five of theirs", () => {
	it("covers the vocabulary with nothing left over", () => {
		const reached = new Set([
			productOf("end_turn", { text: "a", steps: 0 }).stopReason,
			productOf("end_turn", NOTHING).stopReason,
			productOf("max_tokens", NOTHING).stopReason,
			productOf("refusal", NOTHING).stopReason,
			productOf("cancelled", { ...NOTHING, cancelCause: "interrupted" }).stopReason,
			productOf("cancelled", { ...NOTHING, cancelCause: "stopped" }).stopReason,
			failureOf("acp_transport", "gone", NOTHING).stopReason,
		]);

		expect([...reached].sort()).toEqual([
			"answered",
			"budget",
			"empty",
			"failed",
			"interrupted",
			"refused",
			"stopped",
		]);
	});
});

describe("the guard against the protocol moving underneath us", () => {
	it("our five are exactly the schema's five", () => {
		// The translation is a total function over this list. If a version bump adds
		// a sixth word, every turn ending that way would come back `failed` with an
		// unrecognised code, which is safe but wrong. This is how we find out on the
		// day it happens rather than from a customer.
		const require = createRequire(import.meta.url);
		const path = require.resolve("@agentclientprotocol/sdk/schema/schema.json");
		const schema = JSON.parse(readFileSync(path, "utf8")) as {
			$defs?: Record<string, { oneOf?: { const?: string }[] }>;
			definitions?: Record<string, { oneOf?: { const?: string }[] }>;
		};
		const defs = schema.$defs ?? schema.definitions ?? {};
		const shipped = (defs["StopReason"]?.oneOf ?? [])
			.map((variant) => variant.const)
			.filter((word): word is string => typeof word === "string");

		expect(shipped.length, "the schema should define stop reasons").toBeGreaterThan(0);
		expect([...shipped].sort()).toEqual([...ACP_STOP_REASONS].sort());
	});

	it("recognises exactly those five and nothing else", () => {
		for (const word of ACP_STOP_REASONS) expect(isAcpStopReason(word), word).toBe(true);
		expect(isAcpStopReason("end_of_turn")).toBe(false);
		expect(isAcpStopReason("")).toBe(false);
	});
});
