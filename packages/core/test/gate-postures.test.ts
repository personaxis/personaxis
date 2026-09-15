/**
 * What the compiled gate decides under every posture, written down BEFORE the gate was changed.
 *
 * E59, decided by David on 2026-09-11: the postures mean what `docs/architecture/sandbox.md`
 * documents and what Codex means by the same words, where the values come from. Before this, the
 * compiled policy refused every file write under `workspace-write`, because it classed each one as
 * reaching outside, and sent every read to a person under `on-request`. Both contradicted the
 * documentation, and `identity-axis.test.ts` had quietly worked around the first.
 *
 * The contract, one line each:
 *   - a known read of paths inside the workspace is allowed under every posture, unless it names a
 *     credential, which is not an ordinary read;
 *   - `read-only` refuses anything that writes, deletes or spends;
 *   - `workspace-write` lets a write or a delete stay inside the workspace and hands it to the
 *     approval axis, and refuses a write that leaves it or also reaches out;
 *   - `danger-full-access` asks nobody, after the deny list, the limits, egress and declared gates;
 *   - the approval axis: `untrusted` and `on-request` ask a person, `on-failure` and `never` allow;
 *   - the persona's own governed folders (`.personaxis/`, `.git/`) are never "inside" for a write,
 *     and since E63 no posture opens them, full access included; the one exception is a file
 *     tool writing a persona's `state.json`, which the identity axis reads and judges;
 *   - egress comes before every posture: a host off the allowlist is refused even with full access.
 *
 * What did NOT change, and the table pins it: a shell command the classification table does not
 * recognise (`npm install`) is still asked about under `on-request`, because an unrecognised call
 * is not a known read, and treating it as one would loosen what the table fails to see.
 *
 * Two expectations were corrected after the table was first written and before the gate passed
 * it, each because the expectation was wrong and not because the code disagreed:
 *   - `shellNetwork` was expected to pass under `danger-full-access`, with an empty egress
 *     allowlist; egress is refused before any posture, so the table now allowlists `example.com`
 *     and adds a call to a host that is not on it;
 *   - `deleteInside` was expected to be refused under `workspace-write`; the documented posture
 *     refuses a destructive command, not an ordinary delete inside, Codex's workspace-write lets
 *     one through, and a write inside can already empty a file, so refusing the delete protected
 *     nothing the write does not already expose.
 *
 * And one addition was tried and taken back: refusing network under `read-only`, because the
 * document says so. That sentence is about shell commands, which the tool gate still refuses; in
 * the compiled policy `network_egress` is also what every MCP tool declares, and
 * `capability-envelope.test.ts` pins that a read-only capability runs for a read-only persona.
 * `fetchAllowed` stays in the table to pin that a network read follows the approval axis.
 */

import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { actionClassesFor, callFacts, compile, evaluate, policyFromPersona } from "../src/index.js";

const root = resolve("/work/proj");
const inRoot = (p: string) => resolve(root, p);

type Verdict = "allow" | "gate" | "deny";
type Sandbox = "read-only" | "workspace-write" | "danger-full-access";
type Approval = "untrusted" | "on-request" | "on-failure" | "never";

const CALLS: Record<string, { tool: string; args: Record<string, unknown> }> = {
	readInside: { tool: "read_file", args: { path: "src/payments/refunds.ts" } },
	readOutside: { tool: "read_file", args: { path: "../other-client/contract.md" } },
	readThroughTheMiddle: { tool: "read_file", args: { path: "docs/../../other-client/contract.md" } },
	readSecretInside: { tool: "read_file", args: { path: ".env" } },
	listInside: { tool: "list_dir", args: { path: "." } },
	memorySearch: { tool: "memory_search", args: { query: "refund limits" } },
	// E72: a persona loading its own skill is reading. It was asked about under `on-request`.
	loadSkill: { tool: "use_skill", args: { name: "game-feel" } },
	writeInside: { tool: "write_file", args: { path: "docs/refunds.md", content: "# Refunds" } },
	writeOutside: { tool: "write_file", args: { path: "../elsewhere/notes.md", content: "x" } },
	writeThroughTheMiddle: { tool: "write_file", args: { path: "docs/../../elsewhere/notes.md", content: "x" } },
	writeOwnPersona: { tool: "write_file", args: { path: ".personaxis/personaxis.md", content: "---\n" } },
	writeGitHook: { tool: "write_file", args: { path: ".git/hooks/pre-commit", content: "#!/bin/sh" } },
	writeGitConfig: { tool: "write_file", args: { path: ".git/config", content: "[core]\n\tfsmonitor = x" } },
	hostRead: { tool: "Read", args: { file_path: inRoot("src/payments/refunds.ts") } },
	hostWrite: { tool: "Write", args: { file_path: inRoot("docs/refunds.md"), content: "# Refunds" } },
	hostEdit: { tool: "Edit", args: { file_path: inRoot("docs/refunds.md"), old_string: "a", new_string: "b" } },
	shellUnrecognised: { tool: "run_command", args: { command: "npm install left-pad" } },
	shellNetwork: { tool: "run_command", args: { command: "curl https://example.com/upload" } },
	shellNetworkElsewhere: { tool: "run_command", args: { command: "curl https://collector.example.net/x" } },
	fetchAllowed: { tool: "web_fetch", args: { url: "https://example.com/docs" } },
	deleteInside: { tool: "delete_file", args: { path: "docs/old.md" } },
	// Names a path inside and sends it out: the path is inside, the call is not. Added when the
	// negative control showed nothing in the table would notice if "reaches out" stopped counting.
	uploadInside: { tool: "connector.drive.upload", args: { path: "docs/report.pdf" } },
	// E62: shell deletes, judged the way the documented posture judges them, and PowerShell, which
	// classified as nothing before. `C:\Users` is outside on Windows and a plain name elsewhere, and
	// the destructive flag refuses it on both.
	shellDestructive: { tool: "Bash", args: { command: "rm -rf build" } },
	shellDeleteOutside: { tool: "Bash", args: { command: "rm ../other-client/contract.md" } },
	shellDeleteInside: { tool: "Bash", args: { command: "rm docs/old.md" } },
	psRemoveRecurse: { tool: "PowerShell", args: { command: "Remove-Item -Recurse -Force \"C:\\Users\"" } },
	psWebRequest: { tool: "PowerShell", args: { command: "Invoke-WebRequest https://example.com/x -Method Post" } },
	psSetContent: { tool: "PowerShell", args: { command: "Set-Content notes.md hi" } },
	shellMail: { tool: "PowerShell", args: { command: "Send-MailMessage -To finance@example.com -Subject refunds" } },
	// E63: the state file named by a file tool is the one write into .personaxis that full access
	// lets through, because the identity axis reads it. By shell nothing reads it, so it is refused.
	writeOwnState: { tool: "write_file", args: { path: ".personaxis/state.json", content: "{}" } },
	shellWriteOwnState: { tool: "Bash", args: { command: "echo '{}' > .personaxis/state.json" } },
	shellRemoveGit: { tool: "Bash", args: { command: "rm -rf .git" } },
};

/** The table: what each call gets, by sandbox, then by approval. */
function expected(name: string, sandbox: Sandbox, approval: Approval): Verdict {
	const asks: Verdict = approval === "untrusted" || approval === "on-request" ? "gate" : "allow";
	const knownReadInside = ["readInside", "listInside", "memorySearch", "loadSkill", "hostRead"];
	const followsApproval = ["readOutside", "readThroughTheMiddle", "readSecretInside", "shellUnrecognised", "fetchAllowed"];
	const staysInside = ["writeInside", "hostWrite", "hostEdit", "deleteInside", "shellDeleteInside"];
	// No posture opens these, full access included (E63).
	const governed = ["writeOwnPersona", "writeGitHook", "writeGitConfig", "shellWriteOwnState", "shellRemoveGit"];
	const leavesOrReaches = [
		"writeOutside",
		"writeThroughTheMiddle",
		"writeOwnState",
		"shellNetwork",
		"uploadInside",
		"shellDestructive",
		"shellDeleteOutside",
		"psRemoveRecurse",
		"psWebRequest",
		"psSetContent",
		"shellMail",
	];

	// Egress is not a matter of posture, and neither are the governed folders.
	if (name === "shellNetworkElsewhere") return "deny";
	if (governed.includes(name)) return "deny";
	if (knownReadInside.includes(name)) return "allow";
	if (sandbox === "danger-full-access") return "allow";
	// Not refused by any sandbox: a read that leaves the workspace, a read of a secret, a call the
	// table does not recognise, and a fetch to an allowlisted host go to the approval axis.
	if (followsApproval.includes(name)) return asks;
	if (sandbox === "read-only") return "deny";
	// workspace-write from here on.
	if (staysInside.includes(name)) return asks;
	if (leavesOrReaches.includes(name)) return "deny";
	throw new Error(`no expectation for ${name}`);
}

function decide(name: string, sandbox: Sandbox, approval: Approval): Verdict {
	const { tool, args } = CALLS[name]!;
	const argsText = JSON.stringify(args);
	const policy = compile(
		policyFromPersona({ permissions: { sandbox, approval } }, { personaVersionId: "table", egressAllowlist: ["example.com"] }),
	);
	const facts = callFacts(tool, argsText, root);
	return evaluate(policy, {
		tool,
		args_text: argsText,
		action_classes: actionClassesFor(tool, argsText),
		known_read: facts.knownRead,
		within_workspace: facts.withinWorkspace,
		names_outside: facts.namesOutside,
		destructive: facts.destructive,
		touches_protected: facts.touchesProtected,
	}).verdict;
}

const SANDBOXES: Sandbox[] = ["read-only", "workspace-write", "danger-full-access"];
const APPROVALS: Approval[] = ["untrusted", "on-request", "on-failure", "never"];

describe("the compiled gate, posture by posture (E59)", () => {
	for (const sandbox of SANDBOXES) {
		for (const approval of APPROVALS) {
			it(`${sandbox} + ${approval}`, () => {
				const got = Object.fromEntries(Object.keys(CALLS).map((name) => [name, decide(name, sandbox, approval)]));
				const want = Object.fromEntries(Object.keys(CALLS).map((name) => [name, expected(name, sandbox, approval)]));
				expect(got).toEqual(want);
			});
		}
	}
});

describe("what the gate knows about a call before it decides", () => {
	const facts = (tool: string, args: unknown, cwd?: string) => callFacts(tool, JSON.stringify(args), root, cwd);

	it("keeps a write to the persona's own files out of 'inside', even though they are in the folder", () => {
		expect(facts("write_file", { path: ".personaxis/state.json" }).withinWorkspace).toBe(false);
		// Reading them is fine: the persona reads its own document every turn.
		expect(facts("read_file", { path: ".personaxis/personaxis.md" }).withinWorkspace).toBe(true);
	});

	it("protects the governed folders at any depth and in any case", () => {
		// A nested project's persona is another persona, and a submodule's .git runs code too.
		expect(facts("write_file", { path: "packages/app/.personaxis/personaxis.md" }).withinWorkspace).toBe(false);
		expect(facts("write_file", { path: "vendor/lib/.git/config" }).withinWorkspace).toBe(false);
		expect(facts("Write", { file_path: inRoot(".Personaxis/state.json") }).withinWorkspace).toBe(false);
		// And a folder whose name only starts with two dots, inside one of them, is still inside it.
		expect(facts("write_file", { path: ".personaxis/..notes" }).withinWorkspace).toBe(false);
		// While an ordinary folder with a similar name is not governed.
		expect(facts("write_file", { path: "docs/personaxis-notes.md" }).withinWorkspace).toBe(true);
		expect(facts("write_file", { path: ".github/workflows/ci.yml" }).withinWorkspace).toBe(true);
	});

	it("never calls a path that climbs 'inside', even when it comes back", () => {
		expect(facts("read_file", { path: "src/../src/index.ts" }).withinWorkspace).toBe(false);
		expect(facts("write_file", { path: "src/../src/index.ts" }).withinWorkspace).toBe(false);
	});

	it("resolves a relative path from where the call was made, and measures it against the root", () => {
		const below = inRoot("src");
		expect(facts("write_file", { path: "notes.md" }, below).withinWorkspace).toBe(true);
		// The case that made climbing a refusal: from a folder below the root, a path can name the
		// root's own parents on the way down and land outside it.
		const parts = root.split(/[\\/]/).filter(Boolean);
		const back = `../../${parts.slice(-2).join("/")}/y`;
		expect(facts("write_file", { path: back }, below).withinWorkspace).toBe(false);
		// A cwd outside the root puts every relative path outside with it.
		expect(facts("write_file", { path: "notes.md" }, resolve("/elsewhere")).withinWorkspace).toBe(false);
	});

	it("counts a cwd argument as a place the call names", () => {
		expect(facts("write_file", { path: "notes.md", cwd: "/etc" }).withinWorkspace).toBe(false);
	});

	it("reads a Glob pattern as a path, and a brace as more than one", () => {
		expect(facts("Glob", { pattern: "src/**/*.ts" }).withinWorkspace).toBe(true);
		expect(facts("Glob", { pattern: "../**" }).withinWorkspace).toBe(false);
		expect(facts("Glob", { pattern: "{/etc,src}/*" }).withinWorkspace).toBe(false);
	});

	it("does not change the classes, which the identity axis reads to find a write to the state", () => {
		expect(actionClassesFor("write_file", JSON.stringify({ path: ".personaxis/state.json" }))).toContain("external_write");
		expect(actionClassesFor("Write", JSON.stringify({ file_path: inRoot("docs/x.md") }))).toContain("external_write");
	});

	it("knows nothing when it has no root, and then nothing is inside", () => {
		expect(callFacts("write_file", JSON.stringify({ path: "docs/x.md" }))).toEqual({ knownRead: false, withinWorkspace: false, namesOutside: false, destructive: false, touchesProtected: false });
		expect(callFacts("read_file", JSON.stringify({ path: "docs/x.md" })).withinWorkspace).toBe(false);
	});

	it("knows nothing about arguments it cannot read, and then nothing is inside", () => {
		expect(callFacts("write_file", "not json at all", root).withinWorkspace).toBe(false);
		expect(facts("write_file", ["docs/x.md"]).withinWorkspace).toBe(false);
		expect(facts("write_file", { path: 42 }).withinWorkspace).toBe(false);
	});

	it("treats a write that names no path as not inside, because it could go anywhere", () => {
		expect(facts("write_file", { content: "x" }).withinWorkspace).toBe(false);
	});

	it("treats a shell command as not inside, whatever it names, PowerShell included", () => {
		expect(facts("run_command", { command: "echo hi > notes.md" }).withinWorkspace).toBe(false);
		expect(facts("PowerShell", { command: "Set-Content notes.md hi" }).withinWorkspace).toBe(false);
	});

	it("reads where a shell command acts and how hard (E62)", () => {
		expect(facts("Bash", { command: "rm -rf build" })).toMatchObject({ destructive: true, namesOutside: false });
		expect(facts("Bash", { command: "rm docs/old.md" })).toMatchObject({ destructive: false, namesOutside: false });
		expect(facts("Bash", { command: "rm ../other/x.md" }).namesOutside).toBe(true);
		// A path that climbs and comes back still climbs: from a shell below the root it can land elsewhere.
		expect(facts("Bash", { command: "rm src/../src/x.ts" }).namesOutside).toBe(true);
		// A quote in front of a path used to hide it from the scan.
		expect(facts("Bash", { command: 'rm -f "/etc/hosts"' })).toMatchObject({ destructive: true, namesOutside: true });
		// Codex's shell takes the command as an array.
		expect(facts("shell", { command: ["bash", "-lc", "rm -r /tmp/x"] })).toMatchObject({ destructive: true, namesOutside: true });
		// PowerShell and cmd spell a tree delete their own way.
		expect(facts("PowerShell", { command: "Remove-Item -Recurse .\\build" }).destructive).toBe(true);
		expect(facts("PowerShell", { command: "rd /s /q build" }).destructive).toBe(true);
		expect(facts("PowerShell", { command: "Remove-Item notes.md" }).destructive).toBe(false);
	});

	it("knows when a call names a governed folder, and the one exception (E63)", () => {
		expect(facts("Write", { file_path: inRoot(".personaxis/personaxis.md") }).touchesProtected).toBe(true);
		expect(facts("write_file", { path: "vendor/lib/.git/config" }).touchesProtected).toBe(true);
		// The state file, named by a file tool, is the identity axis's to judge.
		expect(facts("Write", { file_path: inRoot(".personaxis/state.json") }).touchesProtected).toBe(false);
		expect(facts("write_file", { path: ".personaxis/personas/scribe/state.json" }).touchesProtected).toBe(false);
		// A state.json that is not a persona's is not the exception.
		expect(facts("write_file", { path: ".git/state.json" }).touchesProtected).toBe(true);
		// By shell, the text is matched, with no exception, however the path is written.
		expect(facts("Bash", { command: "echo x > .personaxis/state.json" }).touchesProtected).toBe(true);
		expect(facts("PowerShell", { command: 'Set-Content -Path ".git\\hooks\\pre-commit" -Value x' }).touchesProtected).toBe(true);
		expect(facts("Bash", { command: "cp hook ./.git/hooks/pre-commit" }).touchesProtected).toBe(true);
		// And a lookalike is not the folder.
		expect(facts("Bash", { command: "echo x >> .gitignore" }).touchesProtected).toBe(false);
		expect(facts("Bash", { command: "git commit -m wip" }).touchesProtected).toBe(false);
		expect(facts("write_file", { path: ".github/workflows/ci.yml" }).touchesProtected).toBe(false);
	});

	it("classifies PowerShell, which earned no class at all before (E62)", () => {
		const classes = (command: string) => actionClassesFor("PowerShell", JSON.stringify({ command }));
		expect(classes("Remove-Item -Recurse -Force build")).toContain("file_delete");
		expect(classes("Invoke-WebRequest https://example.com")).toEqual(expect.arrayContaining(["network_egress", "external_write"]));
		expect(classes("iwr example.com")).toContain("network_egress");
		expect(classes("Set-Content notes.md hi")).toContain("external_write");
		expect(classes("Send-MailMessage -To a@example.com")).toContain("email_send");
		expect(actionClassesFor("pwsh", JSON.stringify({ command: "rm -rf build" }))).toContain("file_delete");
		// And a read stays a read.
		expect(classes("Get-Content notes.md")).toEqual([]);
	});

	it("does not call an unrecognised tool a read", () => {
		expect(facts("frobnicate", { path: "src/a.ts" }).knownRead).toBe(false);
	});
});

describe("what the gate tells a person", () => {
	it("says the posture asked, not a class the call does not have", () => {
		const policy = compile(policyFromPersona({ permissions: { sandbox: "workspace-write", approval: "on-request" } }, { personaVersionId: "why" }));
		const argsText = JSON.stringify({ command: "npm install left-pad" });
		const decision = evaluate(policy, { tool: "run_command", args_text: argsText, action_classes: actionClassesFor("run_command", argsText) });
		expect(decision.verdict).toBe("gate");
		if (decision.verdict === "gate") {
			expect(decision.reason).toContain("approval posture is on-request");
			expect(decision.reason).not.toContain("external_write");
		}
	});

	it("names the class when a declared gate is what asked", () => {
		const policy = compile(
			policyFromPersona(
				{ permissions: { sandbox: "danger-full-access", approval: "never" } },
				{
					personaVersionId: "why",
					gateRules: [{ action_class: "file_delete", required_approvals: 1, route: {}, timeout_seconds: 60 }],
				},
			),
		);
		const argsText = JSON.stringify({ command: "rm notes.md" });
		const decision = evaluate(policy, { tool: "run_command", args_text: argsText, action_classes: actionClassesFor("run_command", argsText) });
		expect(decision).toMatchObject({ verdict: "gate", reason: "this persona's policy asks a person before anything in file_delete" });
	});
});

describe("the control of the control", () => {
	it("without the facts, the gate falls back to what it did before: nothing is inside", () => {
		// A caller that does not pass the facts (an older daemon, a test) gets the conservative
		// answer, not the new permission: a write under workspace-write is refused.
		const policy = compile(policyFromPersona({ permissions: { sandbox: "workspace-write", approval: "never" } }, { personaVersionId: "old" }));
		const argsText = JSON.stringify({ path: "docs/refunds.md", content: "x" });
		expect(evaluate(policy, { tool: "write_file", args_text: argsText, action_classes: actionClassesFor("write_file", argsText) }).verdict).toBe("deny");
	});

	it("without the facts, a read under on-request still goes to a person", () => {
		const policy = compile(policyFromPersona({ permissions: { sandbox: "workspace-write", approval: "on-request" } }, { personaVersionId: "old" }));
		const argsText = JSON.stringify({ path: "docs/refunds.md" });
		expect(evaluate(policy, { tool: "read_file", args_text: argsText, action_classes: [] }).verdict).toBe("gate");
	});
});
