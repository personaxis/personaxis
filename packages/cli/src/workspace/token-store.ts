/**
 * Where a machine keeps its device token.
 *
 * The token is a bearer credential: whoever holds it can open a socket as this
 * machine until it is revoked. So the secret and the description of it are kept
 * apart. The description (which workspace, which machine, when) lives in a file
 * the operator can read; the secret goes to the OS store where one is readable,
 * and to a 0600 file where none is.
 *
 * `keytar` is not used, here or anywhere in this CLI: it is archived, it is a
 * native addon, and it breaks single-binary builds. The shell-out store in
 * `credentials.ts` already owns that decision and this module reuses it rather
 * than opening a second one.
 *
 * Windows has no CLI that reads Credential Manager secrets, so there the token
 * lands in the file. `status` reports which of the two happened, because an
 * operator deciding whether that is acceptable needs to know it, and a tool
 * that quietly downgraded its own storage would be lying by omission.
 */

import {
	chmodSync,
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	rmSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { resolveCredential, storeCredential } from "../credentials.js";

/** The env-var name the secret is filed under, so `credential set` reaches it. */
export const DEVICE_TOKEN_ENV = "PERSONAXIS_DEVICE_TOKEN";

export type TokenStorage = "env" | "os" | "file";

/** What the machine knows about its own link, minus the secret. */
export interface DeviceRecord {
	/** The workspace this machine answers to, so a second one is visible. */
	app_url: string;
	machine_name: string;
	machine_id: string | null;
	/**
	 * The workspace this machine was linked to: an organisation or one person.
	 *
	 * Stored as the prefixed key (`org:<id>` or `usr:<id>`) because that is what the
	 * gateway and the policies compare against, and because a bare id cannot say which
	 * of the two it is. Null on a machine linked before this field existed.
	 */
	space: string | null;
	linked_at: string;
	/** Where the secret went. Never the secret itself. */
	storage: TokenStorage;
}

export interface StoredDevice {
	record: DeviceRecord;
	token: string;
	storage: TokenStorage;
}

/** Injected so tests never touch a real home directory or a real keychain. */
export interface TokenStoreIO {
	home: () => string;
	env: NodeJS.ProcessEnv;
	readSecret: (name: string) => string | undefined;
	writeSecret: (name: string, value: string) => void;
	now: () => Date;
}

const defaultIO: TokenStoreIO = {
	home: homedir,
	env: process.env,
	readSecret: resolveCredential,
	writeSecret: storeCredential,
	now: () => new Date(),
};

export function devicePath(io: TokenStoreIO = defaultIO): string {
	return join(io.home(), ".personaxis", "device.json");
}

/**
 * Saves a token and its description.
 *
 * The OS store is tried first and the file is the fallback, never both: a
 * secret in two places is a secret that has to be revoked in two places.
 */
export function saveDevice(
	input: { token: string; record: Omit<DeviceRecord, "storage" | "linked_at"> },
	io: TokenStoreIO = defaultIO,
): DeviceRecord {
	let storage: TokenStorage = "file";
	try {
		io.writeSecret(DEVICE_TOKEN_ENV, input.token);
		storage = "os";
	} catch {
		// Unsupported platform or a store that refused. The file below is the
		// declared fallback, not a surprise, and `status` names it.
		storage = "file";
	}

	const record: DeviceRecord = {
		...input.record,
		storage,
		linked_at: io.now().toISOString(),
	};

	const path = devicePath(io);
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	const payload = storage === "file" ? { ...record, token: input.token } : record;

	// Written beside and renamed over, never in place.
	//
	// A rename inside one directory is atomic: a crash leaves the old file or the
	// new one and never half of either. Writing in place leaves a truncated file if
	// the process dies mid-write or two `connect`s race, and a truncated credential
	// does not read as damaged. It reads as NEVER LINKED, so the next `connect` asks
	// to be approved again and the workspace gains a second machine for the same
	// computer. Five of them accumulated that way before anybody counted.
	//
	// The mode is set on the temporary file, before the rename, so the secret is
	// never briefly readable under a looser one.
	const staging = `${path}.new`;
	try {
		writeFileSync(staging, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
		chmodSync(staging, 0o600);
		renameSync(staging, path);
	} catch (error) {
		// Nothing half-written is left behind to be read as a link that is not one.
		try {
			if (existsSync(staging)) unlinkSync(staging);
		} catch {
			/* the write already failed; this is tidying, not the error */
		}
		throw error;
	}

	return record;
}

/**
 * Loads the token, environment first.
 *
 * The environment wins so a CI runner or a container can hold a token without a
 * home directory, which is also how the rest of this CLI resolves credentials.
 */
export function loadDevice(io: TokenStoreIO = defaultIO): StoredDevice | null {
	const record = readRecord(io);

	const fromEnv = io.env[DEVICE_TOKEN_ENV];
	if (fromEnv) {
		return {
			token: fromEnv,
			storage: "env",
			record: record ?? unlinkedRecord(io),
		};
	}

	if (!record) return null;

	if (record.storage === "os") {
		const secret = io.readSecret(DEVICE_TOKEN_ENV);
		// A description without its secret is a half-link. Reporting it as
		// linked would produce a socket that fails to authorise with no
		// explanation the operator can act on.
		if (!secret) return null;
		return { token: secret, storage: "os", record };
	}

	const onDisk = readRaw(io) as (DeviceRecord & { token?: string }) | null;
	if (!onDisk?.token) return null;
	return { token: onDisk.token, storage: "file", record };
}

/** The description alone, for a status line that must not read the secret. */
export function readRecord(io: TokenStoreIO = defaultIO): DeviceRecord | null {
	const raw = readRaw(io);
	if (!raw) return null;
	const { app_url, machine_name, storage } = raw as Partial<DeviceRecord>;
	if (typeof app_url !== "string" || typeof machine_name !== "string") return null;
	return {
		app_url,
		machine_name,
		machine_id: typeof raw.machine_id === "string" ? raw.machine_id : null,
		// `organization_id` is what this field was called before a workspace could belong
		// to a person. Read for the machines already linked under the old name: the
		// alternative is telling somebody their working machine is unlinked.
		space:
			typeof raw.space === "string"
				? raw.space
				: typeof raw.organization_id === "string"
					? `org:${raw.organization_id}`
					: null,
		linked_at: typeof raw.linked_at === "string" ? raw.linked_at : "",
		storage: storage === "os" || storage === "file" || storage === "env" ? storage : "file",
	};
}

/** Records the machine id the gateway assigned, without touching the secret. */
export function rememberMachineId(machineId: string, io: TokenStoreIO = defaultIO): void {
	const raw = readRaw(io);
	if (!raw) return;
	const path = devicePath(io);
	writeFileSync(path, `${JSON.stringify({ ...raw, machine_id: machineId }, null, 2)}\n`, {
		mode: 0o600,
	});
	chmodSync(path, 0o600);
}

/**
 * Forgets the link locally.
 *
 * Local only, and the caller says so: deleting the file does not revoke
 * anything server-side, and a `logout` that implied it had would leave a live
 * token on a machine the operator believes is disconnected.
 */
export function forgetDevice(io: TokenStoreIO = defaultIO): { removed: boolean } {
	const path = devicePath(io);
	if (!existsSync(path)) return { removed: false };
	rmSync(path);
	try {
		// Overwritten rather than deleted: no shell-out store here has a delete
		// that is portable, and an empty value fails the `if (!secret)` check in
		// `loadDevice` the same way a missing one does.
		defaultIOWriteEmpty(io);
	} catch {
		/* the file was the only copy */
	}
	return { removed: true };
}

function defaultIOWriteEmpty(io: TokenStoreIO): void {
	io.writeSecret(DEVICE_TOKEN_ENV, "");
}

function readRaw(io: TokenStoreIO): Record<string, unknown> | null {
	const path = devicePath(io);
	if (!existsSync(path)) return null;
	try {
		const parsed = JSON.parse(readFileSync(path, "utf-8")) as unknown;
		return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : null;
	} catch {
		// A corrupt file reads as no link. Throwing here would make a stray
		// character enough to stop a machine connecting at all.
		return null;
	}
}

/**
 * Whether there is a credential here that cannot be read.
 *
 * Absent and damaged are different facts and they were the same answer, which is
 * how this machine ended up with five rows in one workspace. A file that fails to
 * parse reads as "never linked", so `connect` asks to be approved again, a second
 * machine is created for the same computer, and the first one sits there holding a
 * token nobody will ever use.
 *
 * Reported rather than repaired. Deleting it and linking again would be the same
 * silent path with an extra step, and the operator would still not know they now
 * have two. This is what lets `connect` stop and say so.
 */
export function credentialIsDamaged(io: TokenStoreIO = defaultIO): boolean {
	const path = devicePath(io);
	if (!existsSync(path)) return false;

	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(path, "utf-8"));
	} catch {
		return true;
	}
	if (typeof parsed !== "object" || parsed === null) return true;

	// A record naming file storage and carrying no token is the same half-written
	// state, reached the other way: the write got far enough to be valid JSON.
	const record = parsed as Record<string, unknown>;
	return record.storage === "file" && typeof record.token !== "string";
}

function unlinkedRecord(io: TokenStoreIO): DeviceRecord {
	return {
		app_url: io.env.PERSONAXIS_BASE_URL ?? "",
		machine_name: "",
		machine_id: null,
		space: null,
		linked_at: "",
		storage: "env",
	};
}
