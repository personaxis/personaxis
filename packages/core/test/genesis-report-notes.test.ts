/**
 * The creation report: what was worked around is a warning, never a passed gate; and every field says
 * where it came from, with the inferred ones listed first.
 *
 * Until 2026-10-03 every fallback note (no model, a failed web search) was pushed into the gates as a
 * pass, so the repository's own Gamewright report printed a provider's 401 under a ✅.
 */
import { describe, expect, it } from "vitest";

import { numberSources, renderCreationReport, type AuthoredPersona } from "../src/index.js";

const sources = numberSources([{ kind: "brief", label: "the brief", text: "A terse code reviewer." }]);
const authored: AuthoredPersona = {
	spec: { metadata: { name: "lens", created: "2026-10-07" }, improvement_policy: { mode: "suggesting" } },
	stages: [
		{
			stage: "identity",
			reasoning: "The brief names a terse code reviewer.",
			attempts: 2,
			provenance: [
				{ path: "identity.role_identity", source: "S1", quote: "A terse code reviewer." },
				{ path: "identity.system_identity.allowed_domains", inferred: "a reviewer works on pull requests" },
			],
		},
	],
};
const NOTE = "the web search returned nothing usable; nothing was researched";

describe("the creation report", () => {
	it("lists what was worked around with a warning mark, never under a passed gate", () => {
		const r = renderCreationReport(authored, sources, [{ name: "validate", pass: true, detail: "PASS" }], { notes: [NOTE] });
		expect(r).toContain("## Worked around");
		expect(r).toContain(`- ⚠️ ${NOTE}`);
		expect(r).not.toMatch(new RegExp(`✅[^\\n]*${NOTE.slice(0, 20)}`));
	});

	it("leaves no section behind when nothing was worked around", () => {
		expect(renderCreationReport(authored, sources, [])).not.toContain("## Worked around");
	});

	it("names the sources, lists the inferred fields first, and shows each field's origin", () => {
		const r = renderCreationReport(authored, sources, [], { model: "command-a-03-2025" });
		expect(r).toContain("with command-a-03-2025");
		expect(r).toContain("- **S1** (brief) the brief");
		expect(r.indexOf("## Inferred, not stated by a source (1)")).toBeLessThan(r.indexOf("## Each stage"));
		expect(r).toContain("`identity.system_identity.allowed_domains`: a reviewer works on pull requests");
		expect(r).toContain('S1: "A terse code reviewer."');
		expect(r).toContain("### identity (needed 1 repair)");
		expect(r).not.toContain("## Interview");
	});

	it("lists every interview question, answered or skipped, with the part it informed", () => {
		const r = renderCreationReport(authored, sources, [], {
			interview: [
				{ question: { id: "q1", stage: "self_regulation", question: "What must it never approve?", why: "no limits stated" }, answer: "A change that logs secrets." },
				{ question: { id: "q2", stage: "persona", question: "How should it sound?", why: "no voice stated" } },
			],
		});
		expect(r).toContain("## Interview (1 answered, 1 skipped)");
		expect(r).toContain("- answered [self_regulation] What must it never approve?\n  A change that logs secrets.");
		expect(r).toContain("- skipped [persona] How should it sound?");
	});
});
