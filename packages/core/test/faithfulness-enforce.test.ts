/**
 * When a model's document keeps failing the faithfulness check, the protected rules are the definition's
 * to enforce: a dropped bullet goes back verbatim under its label, an invented one comes out, the prose
 * stays. What cannot be put right that way (a protected section missing, a heading the reference lacks)
 * stays refused.
 */
import { describe, expect, it } from "vitest";

import { checkFaithfulness, enforceProtected } from "../src/index.js";

const reference = [
	"# You are Lens",
	"",
	"## What you always / never do",
	"",
	"**Always:**",
	"- Mark each finding blocking or nit.",
	"",
	"**Never:**",
	"- Approve a money change without a failure-path test.",
	"- Soften a finding.",
	"",
	"## Hard limits (never overridden)",
	"",
	"- No claim of subjective consciousness.",
].join("\n");

describe("enforceProtected", () => {
	it("puts a dropped rule back under its label, and keeps the model's prose", () => {
		const written = [
			"# You are Lens",
			"",
			"You review payment code the way the team asked.",
			"",
			"## What you always / never do",
			"",
			"**Always:**",
			"- Mark every finding as blocking or as a nit.",
			"",
			"**Never:**",
			"- Soften a finding.",
			"",
			"## Hard limits (never overridden)",
			"",
			"- No claim of subjective consciousness.",
		].join("\n");
		const report = checkFaithfulness(reference, written);
		expect(report.ok).toBe(false);

		const { document, restored, removed } = enforceProtected(reference, written, report);
		expect([restored, removed]).toEqual([1, 0]);
		expect(checkFaithfulness(reference, document).ok).toBe(true);
		expect(document).toContain("You review payment code the way the team asked.");
		const never = document.indexOf("**Never:**");
		expect(document.indexOf("- Approve a money change without a failure-path test.")).toBeGreaterThan(never);
		expect(document.indexOf("- Approve a money change without a failure-path test.")).toBeLessThan(document.indexOf("## Hard limits"));
	});

	it("takes out a rule the reference does not have", () => {
		const written = reference.replace("- No claim of subjective consciousness.", "- No claim of subjective consciousness.\n- Never work on Fridays.");
		const { document, removed } = enforceProtected(reference, written, checkFaithfulness(reference, written));
		expect(removed).toBe(1);
		expect(document).not.toContain("Fridays");
		expect(checkFaithfulness(reference, document).ok).toBe(true);
	});

	it("leaves refused what it cannot put right: a protected section the model never wrote", () => {
		const written = "# You are Lens\n\nHello.";
		const report = checkFaithfulness(reference, written);
		const { document, restored } = enforceProtected(reference, written, report);
		expect(restored).toBe(0);
		expect(checkFaithfulness(reference, document).ok).toBe(false);
	});
});
