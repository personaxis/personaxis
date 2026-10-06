/**
 * Linking a machine: the URLs it resolves, the flow it runs, and where the
 * token ends up.
 *
 * The tests that matter here are the ones about what must NOT happen: the
 * verifier must not travel in the approval link, a downgraded scheme must not
 * be accepted quietly, and a description of a link must not be reported as a
 * link when the secret behind it is gone.
 */

import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
	mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	challengeFor,
	claimDeviceToken,
	createVerifier,
	startDeviceFlow,
	type DeviceFlowIO,
	type StartedFlow,
} from "../src/workspace/device-flow.js";
import {
	DEVICE_TOKEN_ENV,
	devicePath,
	credentialIsDamaged,
	forgetDevice,
	loadDevice,
	readRecord,
	rememberMachineId,
	saveDevice,
	type TokenStoreIO,
} from "../src/workspace/token-store.js";
import { appUrl, daemonSocketUrl, gatewayUrl } from "../src/workspace/urls.js";

describe("where the workspace lives", () => {
	it("defaults to the hosted workspace and its gateway", () => {
		expect(appUrl({} as NodeJS.ProcessEnv)).toBe("https://personaxis.com");
		expect(gatewayUrl({} as NodeJS.ProcessEnv)).toBe("wss://gw.personaxis.com");
		expect(daemonSocketUrl({} as NodeJS.ProcessEnv)).toBe("wss://gw.personaxis.com/v1/daemon");
	});

	it("derives a local gateway from a local app, rather than guessing production", () => {
		// A development daemon that silently dialled the public gateway would
		// report a local run into a real workspace.
		const env = { PERSONAXIS_BASE_URL: "http://localhost:3000" } as NodeJS.ProcessEnv;
		expect(gatewayUrl(env)).toBe("ws://localhost:3000");
	});

	it("lets the gateway be pinned on its own", () => {
		const env = {
			PERSONAXIS_BASE_URL: "https://acme.example",
			PERSONAXIS_GATEWAY_URL: "wss://gw.acme.example",
		} as NodeJS.ProcessEnv;
		expect(gatewayUrl(env)).toBe("wss://gw.acme.example");
	});

	it("refuses a scheme it would have to downgrade", () => {
		expect(() => gatewayUrl({ PERSONAXIS_GATEWAY_URL: "http://gw.example" } as NodeJS.ProcessEnv)).toThrow(
			/must use ws: or wss:/,
		);
		expect(() => appUrl({ PERSONAXIS_BASE_URL: "not a url" } as NodeJS.ProcessEnv)).toThrow(/is not a URL/);
	});
});

describe("the device flow", () => {
	const machine = { machine_name: "studio", os: "darwin 24", daemon_version: "0.16.1" };

	function io(fetchImpl: typeof fetch): DeviceFlowIO {
		let clock = 1_000_000;
		return {
			fetch: fetchImpl,
			now: () => clock,
			sleep: async (ms) => {
				clock += ms;
			},
			randomBytes: (n) => Buffer.alloc(n, 7),
		};
	}

	function jsonResponse(status: number, body: unknown): Response {
		return new Response(JSON.stringify(body), {
			status,
			headers: { "Content-Type": "application/json" },
		});
	}

	it("sends the hash and keeps the secret", async () => {
		const verifier = createVerifier({ randomBytes: (n) => Buffer.alloc(n, 3) } as DeviceFlowIO);
		expect(verifier).toHaveLength(43);
		expect(challengeFor(verifier)).not.toBe(verifier);
		expect(challengeFor(verifier)).toBe(challengeFor(verifier));
	});

	it("never puts the verifier in the approval link", async () => {
		// The link travels through a browser, a clipboard, sometimes a chat.
		// Whoever sees it can approve a machine they can see; they cannot walk
		// away with its credential.
		let sentBody = "";
		const flow = await startDeviceFlow(
			"https://app.example",
			machine,
			io(async (_url, init) => {
				sentBody = String((init as RequestInit).body);
				return jsonResponse(200, {
					verification_url: "https://app.example/link?challenge=abc",
					expires_in_seconds: 300,
					poll_interval_seconds: 2,
				});
			}),
		);

		expect(flow.verification_url).not.toContain(flow.verifier);
		expect(sentBody).not.toContain(flow.verifier);
		expect(JSON.parse(sentBody).challenge).toBe(challengeFor(flow.verifier));
	});

	it("waits through pending answers and returns the token once", async () => {
		let calls = 0;
		const flowIO = io(async () => {
			calls += 1;
			if (calls < 3) return jsonResponse(202, { status: "pending" });
			return jsonResponse(200, {
				token: "pxis_live",
				machine_id: "mach_1",
				space: { kind: "org", id: "org_1" },
				space_name: "Acme",
			});
		});

		const outcome = await claimDeviceToken("https://app.example", startedFlow(flowIO), flowIO);
		expect(outcome.status).toBe("approved");
		if (outcome.status === "approved") expect(outcome.value.token).toBe("pxis_live");
		expect(calls).toBe(3);
	});

	it("stops on a decline instead of polling on", async () => {
		const flowIO = io(async () => jsonResponse(403, { error: "declined" }));
		const outcome = await claimDeviceToken("https://app.example", startedFlow(flowIO), flowIO);
		expect(outcome.status).toBe("denied");
	});

	it("gives up when nobody approves, rather than waiting forever", async () => {
		const flowIO = io(async () => jsonResponse(202, {}));
		const outcome = await claimDeviceToken("https://app.example", startedFlow(flowIO), flowIO);
		expect(outcome.status).toBe("expired");
	});

	it("rides out a network blip", async () => {
		let calls = 0;
		const flowIO = io(async () => {
			calls += 1;
			if (calls === 1) throw new Error("ECONNRESET");
			return jsonResponse(200, {
				token: "pxis_live",
				machine_id: "mach_1",
				space: { kind: "user", id: "usr_1" },
				space_name: "Ana",
			});
		});
		const outcome = await claimDeviceToken("https://app.example", startedFlow(flowIO), flowIO);
		expect(outcome.status).toBe("approved");
	});

	it("treats an approval with no token as a failure, not a success", async () => {
		const flowIO = io(async () => jsonResponse(200, { machine_id: "mach_1" }));
		const outcome = await claimDeviceToken("https://app.example", startedFlow(flowIO), flowIO);
		expect(outcome.status).toBe("failed");
	});

	function startedFlow(flowIO: DeviceFlowIO): StartedFlow {
		const verifier = createVerifier(flowIO);
		return {
			verifier,
			challenge: challengeFor(verifier),
			verification_url: "https://app.example/link",
			expires_at: flowIO.now() + 60_000,
			poll_interval_ms: 1000,
		};
	}
});

describe("where the token is kept", () => {
	let home: string;
	let store: Record<string, string>;

	function storeIO(overrides: Partial<TokenStoreIO> = {}): TokenStoreIO {
		return {
			home: () => home,
			env: {} as NodeJS.ProcessEnv,
			readSecret: (name) => store[name],
			writeSecret: (name, value) => {
				store[name] = value;
			},
			now: () => new Date("2026-08-01T00:00:00.000Z"),
			...overrides,
		};
	}

	beforeEach(() => {
		home = mkdtempSync(join(tmpdir(), "pxs-device-"));
		store = {};
	});
	afterEach(() => rmSync(home, { recursive: true, force: true }));

	const record = {
		app_url: "https://app.example",
		machine_name: "studio",
		machine_id: "mach_1",
		space: "org:org_1",
	};

	it("puts the secret in the OS store and keeps it out of the file", () => {
		const io = storeIO();
		const saved = saveDevice({ token: "pxis_secret", record }, io);

		expect(saved.storage).toBe("os");
		expect(store[DEVICE_TOKEN_ENV]).toBe("pxis_secret");
		expect(readFileSync(devicePath(io), "utf-8")).not.toContain("pxis_secret");
		expect(loadDevice(io)?.token).toBe("pxis_secret");
	});

	it("falls back to a 0600 file where no store will take it, and says so", () => {
		const io = storeIO({
			writeSecret: () => {
				throw new Error("no store on this platform");
			},
		});
		const saved = saveDevice({ token: "pxis_secret", record }, io);

		expect(saved.storage).toBe("file");
		expect(loadDevice(io)?.token).toBe("pxis_secret");
		if (process.platform !== "win32") {
			expect(statSync(devicePath(io)).mode & 0o777).toBe(0o600);
		}
	});

	it("reports a description without its secret as no link at all", () => {
		// Otherwise the daemon would open a socket with nothing to authenticate
		// with and the operator would get a 401 they cannot explain.
		const io = storeIO();
		saveDevice({ token: "pxis_secret", record }, io);
		delete store[DEVICE_TOKEN_ENV];

		expect(readRecord(io)).not.toBeNull();
		expect(loadDevice(io)).toBeNull();
	});

	it("lets the environment carry a token with no file at all", () => {
		const io = storeIO({ env: { [DEVICE_TOKEN_ENV]: "pxis_env" } as NodeJS.ProcessEnv });
		expect(loadDevice(io)?.token).toBe("pxis_env");
		expect(loadDevice(io)?.storage).toBe("env");
	});

	it("reads a corrupt file as no link rather than throwing", () => {
		const io = storeIO();
		mkdirSync(join(home, ".personaxis"), { recursive: true });
		writeFileSync(devicePath(io), "{ not json");
		expect(loadDevice(io)).toBeNull();
		expect(readRecord(io)).toBeNull();
	});

	it("remembers the machine id without touching the secret", () => {
		const io = storeIO({
			writeSecret: () => {
				throw new Error("file fallback");
			},
		});
		saveDevice({ token: "pxis_secret", record: { ...record, machine_id: null } }, io);
		rememberMachineId("mach_9", io);

		expect(readRecord(io)?.machine_id).toBe("mach_9");
		expect(loadDevice(io)?.token).toBe("pxis_secret");
	});

	it("forgets locally, and forgetting twice is not an error", () => {
		const io = storeIO();
		saveDevice({ token: "pxis_secret", record }, io);

		expect(forgetDevice(io).removed).toBe(true);
		expect(loadDevice(io)).toBeNull();
		expect(forgetDevice(io).removed).toBe(false);
	});
});

describe("a machine linked before a workspace could belong to a person", () => {
	it("reads its old organization_id rather than reporting itself unlinked", () => {
		// The field was called `organization_id` until a workspace could also be one
		// person's. A machine linked under the old name is still linked, and telling
		// its operator otherwise would send them to re-run `personaxis connect` on a
		// machine that is working.
		const home = mkdtempSync(join(tmpdir(), "pxis-legacy-"));
		try {
			const io: TokenStoreIO = {
				home: () => home,
				env: {} as NodeJS.ProcessEnv,
				readSecret: () => undefined,
				writeSecret: () => {},
				now: () => new Date("2026-08-01T00:00:00.000Z"),
			};

			mkdirSync(join(home, ".personaxis"), { recursive: true });
			writeFileSync(
				devicePath(io),
				JSON.stringify({
					app_url: "https://app.example",
					machine_name: "studio",
					machine_id: "mach_1",
					organization_id: "org_1",
					linked_at: "2026-08-01T00:00:00.000Z",
					storage: "file",
				}),
			);

			expect(readRecord(io)?.space).toBe("org:org_1");
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});
});

/**
 * The five machines.
 *
 * One computer ended up with five rows in one workspace, and the link flow was not
 * at fault. The credential was written in place, so a process dying mid-write or
 * two `connect`s racing left truncated JSON; truncated JSON failed to parse; a file
 * that fails to parse read as NEVER LINKED; and `connect` quietly asked to be
 * approved again. Each round left the previous machine holding a token nobody would
 * ever use, and nothing said why the operator was being asked twice.
 *
 * Two halves, and the second is the one that matters: writing atomically stops it
 * happening, and refusing to treat damage as absence stops it happening SILENTLY.
 */
describe("a credential that was interrupted", () => {
	let home: string;

	const io = (): TokenStoreIO => ({
		home: () => home,
		env: {} as NodeJS.ProcessEnv,
		// No OS store, which is this machine and every Windows one: the secret goes
		// in the file, which is the case the truncation bites.
		readSecret: () => undefined,
		writeSecret: () => {
			throw new Error("no store here");
		},
		now: () => new Date("2026-08-01T00:00:00.000Z"),
	});

	const record = {
		app_url: "https://app.example",
		machine_name: "studio",
		machine_id: "mach_1",
		space: "org:org_1",
	};

	beforeEach(() => {
		home = mkdtempSync(join(tmpdir(), "pxs-damaged-"));
	});
	afterEach(() => rmSync(home, { recursive: true, force: true }));

	it("lands by rename, so a reader sees the old file or the new one", () => {
		const store = io();
		saveDevice({ token: "pxis_secret", record }, store);

		expect(existsSync(`${devicePath(store)}.new`)).toBe(false);
		expect(JSON.parse(readFileSync(devicePath(store), "utf-8")).token).toBe("pxis_secret");
	});

	it("is recognised as damaged rather than missing", () => {
		const store = io();
		saveDevice({ token: "pxis_secret", record }, store);
		writeFileSync(devicePath(store), '{"app_url": "http://loc');

		expect(credentialIsDamaged(store)).toBe(true);
		// The ordinary reader still says no link, which is what `status` needs.
		expect(loadDevice(store)).toBeNull();
	});

	it("counts a record that names a file and carries no token", () => {
		// The same half-written state reached the other way: the write got far enough
		// to be valid JSON and stopped before the secret.
		const store = io();
		mkdirSync(join(home, ".personaxis"), { recursive: true });
		writeFileSync(devicePath(store), JSON.stringify({ ...record, storage: "file" }));

		expect(credentialIsDamaged(store)).toBe(true);
	});

	it("says nothing is damaged when there is nothing there", () => {
		// Absent is the ordinary state of a machine nobody linked, and it must not
		// send anybody looking for a file to repair.
		expect(credentialIsDamaged(io())).toBe(false);
	});

	it("says nothing is damaged about a good one", () => {
		const store = io();
		saveDevice({ token: "pxis_secret", record }, store);

		expect(credentialIsDamaged(store)).toBe(false);
	});
});
