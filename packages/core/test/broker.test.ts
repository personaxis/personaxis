/**
 * The agent never sees a secret, and the record never holds one.
 *
 * Not "the agent is told not to print secrets", which is a request, and not "the
 * transcript is redacted afterwards", which is a cleanup that arrives too late. The
 * credential is not in the agent's world: it holds a reference, the reference becomes
 * a value one line before the bytes leave, and everything coming back is scrubbed.
 *
 * The third rule is the one that gets skipped, and skipping it undoes the other two.
 * An agent that can send a header can send something that echoes the header back, so a
 * broker that substitutes and does not scrub has handed the secret to the model
 * through the tool's own output. Half of this file is about that.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	CredentialBroker,
	DEFAULT_POLICY,
	ForensicLog,
	ToolInterceptor,
	accept,
	secretRef,
} from "../src/index.js";
import { readFileTool } from "../src/tools/builtin/read-file.js";

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "pxs-broker-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const SECRET = "sk-live-9f3a2b1c8d7e6f5a4b3c2d1e";

describe("what a reference is", () => {
	it("names a slot and carries no value", () => {
		// Safe in a transcript, a record entry, a log, a screenshot.
		expect(secretRef("github")).toBe("{{secret:github}}");
		expect(secretRef("github")).not.toContain(SECRET);
	});

	it("is exchanged for the value only when asked", () => {
		const broker = new CredentialBroker({ github: SECRET });

		expect(broker.fill(`Bearer ${secretRef("github")}`).text).toBe(`Bearer ${SECRET}`);
	});

	it("reports a slot it does not hold instead of filling it with nothing", () => {
		// Both alternatives send a request. Leaving `{{secret:x}}` in place sends one
		// some servers log verbatim; an empty string sends one that reads as an
		// authentication bug for as long as it takes somebody to find the substitution.
		const broker = new CredentialBroker({ github: SECRET });
		const filled = broker.fill(`Bearer ${secretRef("stripe")}`);

		expect(filled.missing).toEqual(["stripe"]);
		expect(filled.text).toContain("{{secret:stripe}}");
	});

	it("names what it filled, which is safe to report", () => {
		const broker = new CredentialBroker({ github: SECRET });
		const filled = broker.fill(`${secretRef("github")} and ${secretRef("github")}`);

		expect(filled.used).toEqual(["github"]);
	});

	it("offers its slot names without offering values", () => {
		const broker = new CredentialBroker({ github: SECRET, stripe: "sk-test-2" });

		expect(broker.names()).toEqual(["github", "stripe"]);
		expect(JSON.stringify(broker.names())).not.toContain(SECRET);
	});

	it("ignores an empty slot rather than holding a blank credential", () => {
		expect(new CredentialBroker({ github: "" }).names()).toEqual([]);
	});
});

describe("scrubbing what comes back", () => {
	it("removes the value wherever it appears", () => {
		const broker = new CredentialBroker({ github: SECRET });

		expect(broker.scrub(`the header was ${SECRET}, twice: ${SECRET}`)).not.toContain(SECRET);
	});

	it("scrubs by value rather than by pattern", () => {
		// A pattern guesses what a secret looks like and is wrong in both directions.
		// The broker knows exactly what it holds, so this is exact: a short, ordinary
		// looking credential that no entropy rule would flag is still removed.
		const broker = new CredentialBroker({ token: "hunter2" });

		expect(broker.scrub("the password is hunter2")).toBe("the password is [redacted]");
	});

	it("removes the longest first, so a nested secret leaves no fragment", () => {
		// One credential containing another is not exotic: a connection string holds a
		// password. Scrubbing the short one first would leave the long one in pieces,
		// and the pieces are enough.
		const broker = new CredentialBroker({ short: "abc123", long: "postgres://u:abc123@host/db" });

		const scrubbed = broker.scrub("connect with postgres://u:abc123@host/db please");
		expect(scrubbed).not.toContain("abc123");
		expect(scrubbed).toBe("connect with [redacted] please");
	});

	it("leaves text that holds nothing of its own alone", () => {
		// The control. A scrubber that redacted everything would pass every test above.
		const broker = new CredentialBroker({ github: SECRET });

		expect(broker.scrub("an ordinary sentence")).toBe("an ordinary sentence");
		expect(broker.leaks("an ordinary sentence")).toBe(false);
	});

	it("says when text still holds something it knows", () => {
		const broker = new CredentialBroker({ github: SECRET });

		expect(broker.leaks(`x ${SECRET} y`)).toBe(true);
	});
});

describe("through the interceptor, which is the boundary", () => {
	function interceptorWith(broker?: CredentialBroker) {
		return new ToolInterceptor(
			{ ...DEFAULT_POLICY, workspaceRoot: dir, sandbox: "danger-full-access" },
			new ForensicLog(),
			undefined,
			null,
			undefined,
			broker,
		);
	}

	/**
	 * A tool that reports WHETHER it received the real value, without returning it.
	 *
	 * Returning the argument would be scrubbed on the way back, which is the broker
	 * working, and the assertion would then be unable to tell substitution from
	 * redaction. So the tool checks and answers yes or no.
	 */
	const reporting = {
		name: "check_header",
		description: "says whether it got the real credential",
		category: "meta" as const,
		parameters: { type: "object" as const, properties: {} },
			// Declared rather than defaulted: these two decide whether the loop may run
			// this tool alongside another, and a stub that omits them is a stub that does
			// not resemble the thing it stands for.
			isReadOnly: true,
			isConcurrencySafe: true,
		gate: () => ({
			decision: "allow" as const,
			reason: "",
			class: { writesFiles: false, network: false, destructive: false, escapesWorkspace: false },
		}),
		execute: async (args: Record<string, unknown>) =>
			args.header === `Bearer ${SECRET}` ? "received the real credential" : `received ${String(args.header)}`,
	};

	it("hands the tool the real value, not the reference", async () => {
		// The control that was missing, and it is the substitution itself: every other
		// test here proves `fill` works in isolation, that a missing slot is refused, and
		// that output is scrubbed. None of them proved the filled arguments are what the
		// tool actually runs with. Removing that line left them all green.
		const interceptor = interceptorWith(new CredentialBroker({ github: SECRET }));

		const outcome = await interceptor.run(reporting, {
			id: "c1",
			name: "check_header",
			args: { header: `Bearer ${secretRef("github")}` },
		});

		expect(accept(outcome.output, "clean").value).toBe("received the real credential");
	});

	it("hands the tool the reference when there is no broker at all", async () => {
		// The other half. Without a broker nothing is substituted, and the tool sees
		// exactly what the model wrote, which is what should happen.
		const interceptor = interceptorWith();

		const outcome = await interceptor.run(reporting, {
			id: "c1",
			name: "check_header",
			args: { header: `Bearer ${secretRef("github")}` },
		});

		expect(accept(outcome.output, "clean").value).toContain("{{secret:github}}");
	});

	it("refuses a call naming a credential this machine does not hold", async () => {
		// Refused, named, and never sent.
		const interceptor = interceptorWith(new CredentialBroker({ github: SECRET }));

		const outcome = await interceptor.run(readFileTool, {
			id: "c1",
			name: "read_file",
			args: { path: secretRef("stripe") },
		});

		expect(outcome.ok).toBe(false);
		expect(accept(outcome.output, "clean").value).toContain("stripe");
		expect(outcome.record.executed).toBe(false);
	});

	it("scrubs a secret out of what a tool returned", async () => {
		// The rule that gets skipped. The file holds the credential, the tool reads it,
		// and without the scrub the value lands in the model's context: substituted
		// carefully at one end and handed over at the other.
		writeFileSync(join(dir, "leaky.txt"), `the deploy key is ${SECRET}\n`, "utf-8");
		const interceptor = interceptorWith(new CredentialBroker({ github: SECRET }));

		const outcome = await interceptor.run(readFileTool, {
			id: "c1",
			name: "read_file",
			args: { path: "leaky.txt" },
		});

		const text = accept(outcome.output, "clean").value;
		expect(text).not.toContain(SECRET);
		expect(text).toContain("[redacted]");
	});

	it("leaves the same output alone when no broker is configured", async () => {
		// The control, and an honest statement of the limit: without a broker there is
		// nothing to scrub BY VALUE. The wire's own pattern redaction still runs before
		// anything leaves the machine; this layer is about the credentials we hold.
		writeFileSync(join(dir, "leaky.txt"), `the deploy key is ${SECRET}\n`, "utf-8");
		const interceptor = interceptorWith();

		const outcome = await interceptor.run(readFileTool, {
			id: "c1",
			name: "read_file",
			args: { path: "leaky.txt" },
		});

		expect(accept(outcome.output, "clean").value).toContain(SECRET);
	});

	it("keeps the reference in the record, not the value", async () => {
		// The property that makes an audit safe to read. The arguments the gate judged
		// and the record kept are the ones with the reference still in them.
		writeFileSync(join(dir, "notes.txt"), "ordinary", "utf-8");
		const forensic = new ForensicLog();
		const interceptor = new ToolInterceptor(
			{ ...DEFAULT_POLICY, workspaceRoot: dir, sandbox: "danger-full-access" },
			forensic,
			undefined,
			null,
			undefined,
			new CredentialBroker({ github: SECRET }),
		);

		await interceptor.run(readFileTool, { id: "c1", name: "read_file", args: { path: "notes.txt" } });

		expect(JSON.stringify(forensic.entries())).not.toContain(SECRET);
	});
});
