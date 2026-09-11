/**
 * The postures through the daemon, the way a host's hook reaches them (E59).
 *
 * `gate-postures.test.ts` in core pins what the compiled policy decides. This pins that the
 * daemon hands it the facts it needs, from the directory the operator consented to, and that
 * opening writes inside the project did not open the persona's own files: before E59 every write
 * under `workspace-write` was refused, and that refusal was, by accident, what kept a host from
 * rewriting `.personaxis/`. The accident is gone, so the protection has to hold on its own.
 */

import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { policyFromPersona } from "@personaxis/core";

import { enforcementHandler, type GateRequest } from "../src/workspace/enforcement-service.js";
import { PolicyCache } from "../src/workspace/policy-cache.js";
import { consentedRootFor } from "../src/workspace/scope-guard.js";

const parent = resolve("/work");
const root = resolve(parent, "proj");
const at = (p: string) => resolve(root, p);

function daemon(
	permissions: { sandbox: string; approval: string },
	options: { scope?: string[]; openGate?: (request: GateRequest) => Promise<"approved" | "denied"> } = {},
) {
	const cache = new PolicyCache();
	cache.put(policyFromPersona({ permissions }, { personaVersionId: "pv_1" }));
	return enforcementHandler({
		cache,
		scope: options.scope ?? [root],
		personaVersionFor: () => "pv_1",
		...(options.openGate ? { openGate: options.openGate } : {}),
	});
}

const read = (file: string, cwd = root) => ({ tool_name: "Read", args_text: JSON.stringify({ file_path: file }), cwd });
const write = (file: string, cwd = root) => ({
	tool_name: "Write",
	args_text: JSON.stringify({ file_path: file, content: "x" }),
	cwd,
});

describe("the default posture through the daemon, workspace-write and on-request", () => {
	const standard = { sandbox: "workspace-write", approval: "on-request" };

	it("lets a read inside the project run without asking anyone", async () => {
		// Before E59 this went to a person, and with no workspace to ask it was refused.
		const reply = await daemon(standard)(read(at("src/index.ts")));
		expect(reply).toMatchObject({ verdict: "allow", rule: "read:inside-workspace" });
	});

	it("asks about a write inside the project, with the posture as the reason", async () => {
		const asked: GateRequest[] = [];
		const reply = await daemon(standard, {
			openGate: async (request) => {
				asked.push(request);
				return "approved";
			},
		})(write(at("docs/refunds.md")));
		expect(reply.verdict).toBe("allow");
		expect(asked).toHaveLength(1);
		expect(asked[0]!.reason).toContain("approval posture is on-request");
	});
});

describe("the trusted posture through the daemon, workspace-write and on-failure", () => {
	const trusted = { sandbox: "workspace-write", approval: "on-failure" };

	it("lets a write inside the project run", async () => {
		expect((await daemon(trusted)(write(at("docs/refunds.md")))).verdict).toBe("allow");
	});

	it("refuses a write to the persona that governs the host", async () => {
		const reply = await daemon(trusted)(write(at(".personaxis/personaxis.md")));
		// Refused by its own rule since E63, before the posture is even asked.
		expect(reply).toMatchObject({ verdict: "deny", rule: "protected_path" });
	});

	it("refuses a write that would run code on the next git command", async () => {
		expect((await daemon(trusted)(write(at(".git/hooks/pre-commit")))).verdict).toBe("deny");
		expect((await daemon(trusted)(write(at(".git/config")))).verdict).toBe("deny");
	});

	it("refuses a write outside the directory the operator consented to", async () => {
		expect((await daemon(trusted)(write(resolve(parent, "other-client/notes.md")))).verdict).toBe("deny");
	});

	it("measures inside from the consented directory, not from where the host happens to stand", async () => {
		// The host works in `src`, and a sibling folder is still the project.
		expect((await daemon(trusted)(write(at("docs/refunds.md"), at("src")))).verdict).toBe("allow");
	});

	it("refuses a destructive or outside shell delete, PowerShell included, and lets an ordinary one run (E62)", async () => {
		// Measured on 2026-09-11: before this all three refusals below ran under on-failure.
		const shell = (tool: string, command: string) => ({ tool_name: tool, args_text: JSON.stringify({ command }), cwd: root });
		expect((await daemon(trusted)(shell("Bash", "rm -rf build"))).verdict).toBe("deny");
		expect((await daemon(trusted)(shell("Bash", "rm ../other-client/contract.md"))).verdict).toBe("deny");
		expect((await daemon(trusted)(shell("PowerShell", 'Remove-Item -Recurse -Force "C:\\Users"'))).verdict).toBe("deny");
		expect((await daemon(trusted)(shell("Bash", "rm docs/old.md"))).verdict).toBe("allow");
	});

	it("takes the narrower workspace when the consents are nested", async () => {
		const nested = { scope: [parent, root] };
		// Consented to /work too, but the host works in /work/proj, so /work/other is outside.
		expect((await daemon(trusted, nested)(write(resolve(parent, "other/notes.md")))).verdict).toBe("deny");
		expect(consentedRootFor(at("src"), [parent, root])).toBe(root);
	});
});

describe("full access through the daemon (E63)", () => {
	const yolo = { sandbox: "danger-full-access", approval: "never" };

	it("still refuses a write into the persona governing the host, its memory, or .git", async () => {
		// Before E63 all three ran: under full access only the identity axis looked at .personaxis,
		// and it only reads the state file.
		for (const file of [".personaxis/personaxis.md", ".personaxis/memory.md", ".git/config"]) {
			const reply = await daemon(yolo)(write(at(file)));
			expect(reply, file).toMatchObject({ verdict: "deny", rule: "protected_path" });
		}
	});

	it("lets a file tool write the state, which is the identity axis's to judge", async () => {
		expect((await daemon(yolo)(write(at(".personaxis/state.json")))).verdict).toBe("allow");
	});

	it("refuses the same state write by shell, which nothing reads", async () => {
		const shell = { tool_name: "Bash", args_text: JSON.stringify({ command: "echo '{}' > .personaxis/state.json" }), cwd: root };
		expect((await daemon(yolo)(shell)).verdict).toBe("deny");
	});

	it("still writes an ordinary file of the project", async () => {
		expect((await daemon(yolo)(write(at("docs/refunds.md")))).verdict).toBe("allow");
	});
});

describe("where the workspace is", () => {
	it("is nowhere when the call is not in a consented directory", () => {
		expect(consentedRootFor(resolve("/elsewhere"), [root])).toBeUndefined();
	});

	it("does not take a directory whose name only starts the same", () => {
		expect(consentedRootFor(resolve("/work/proj-other"), [root])).toBeUndefined();
	});
});
