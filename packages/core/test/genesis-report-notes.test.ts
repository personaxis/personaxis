/**
 * What `create` worked around is a warning in the creation report, never a passed gate.
 *
 * Until 2026-10-03 every fallback note (no model, a failed web search) was pushed into the gates as
 * a pass, so the repository's own Gamewright report printed a provider's 401 under a ✅.
 */
import { describe, expect, it } from "vitest";

import { buildSpecObject } from "../src/genesis/spec-builder.js";
import { renderCreationReport } from "../src/genesis/report.js";
import type { GenesisResult } from "../src/genesis/types.js";

const result = (): GenesisResult => {
	const seed = { displayName: "Tester", purpose: "test" };
	return { spec: buildSpecObject(seed as never), document: "", seed, ledger: { items: [] } } as unknown as GenesisResult;
};
const NOTE = "no model provider available for prompt; heuristic baseline used (labeled defaults)";

describe("notes in the creation report", () => {
	it("are listed as worked around, with a warning mark", () => {
		const r = renderCreationReport(result(), [{ name: "validate", pass: true, detail: "PASS" }], [NOTE]);
		expect(r).toContain("## Worked around");
		expect(r).toContain(`- ⚠️ ${NOTE}`);
		expect(r).not.toMatch(new RegExp(`✅[^\\n]*${NOTE.slice(0, 20)}`));
	});

	it("leave no section behind when nothing was worked around", () => {
		expect(renderCreationReport(result(), [])).not.toContain("## Worked around");
	});
});
