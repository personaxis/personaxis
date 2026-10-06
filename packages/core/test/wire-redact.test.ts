// A secret that reaches the record has to be rotated, and the record still
// holds the old one forever, because the chain cannot be edited. So these lean
// hard on the false-negative side: over-redacting costs readability, and
// under-redacting costs a credential.

import { describe, expect, it } from "vitest";

import { REDACTED, redactDeep, redactSecrets, redactSecretsVerbose } from "../src/wire/redact.js";

describe("what a persona actually leaks", () => {
	it("removes a bearer token from a curl the model wrote", () => {
		const out = redactSecrets(
			'curl -H "Authorization: Bearer sk-ant-api03-AbCdEf123456789" https://api.example.com',
		);
		expect(out).not.toContain("sk-ant-api03");
		expect(out).toContain(REDACTED);
		// The shape of the command survives, so the trace still says what ran.
		expect(out).toContain("curl");
		expect(out).toContain("https://api.example.com");
	});

	it("removes a database password from a connection string", () => {
		// How a password reaches a log without anyone typing the word.
		const out = redactSecrets("postgresql://app:s3cr3tP4ss@db.example.com:5432/prod");
		expect(out).not.toContain("s3cr3tP4ss");
		expect(out).toContain("postgresql://app:");
		expect(out).toContain("db.example.com");
	});

	it("removes the values from a .env a tool happened to read", () => {
		const out = redactSecrets(
			["DATABASE_URL=postgres://u:p@h/db", "STRIPE_SECRET_KEY=sk_live_51abcdefghijklmnop", "PORT=3000"].join(
				"\n",
			),
		);
		expect(out).not.toContain("sk_live_51abcdefghijklmnop");
		// A non-secret keeps its value: a redactor that blanked everything would
		// be turned off within a week.
		expect(out).toContain("PORT=3000");
	});

	it.each([
		["ghp_abcdefghijklmnopqrstuvwxyz1234", "github token"],
		["xoxb-1234567890-abcdefghij", "slack token"],
		["AKIAIOSFODNN7EXAMPLE", "aws access key"],
		["npm_abcdefghijklmnopqrstuvwxyz12", "npm token"],
		["AIzaSyA1234567890abcdefghijklmnop", "google api key"],
	])("removes %s (%s)", (secret) => {
		expect(redactSecrets(`the key is ${secret} ok`)).not.toContain(secret);
	});

	it("removes a JWT", () => {
		const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r";
		expect(redactSecrets(`cookie: session=${jwt}`)).not.toContain(jwt);
	});

	it("removes a private key block whole", () => {
		const pem = "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\n-----END RSA PRIVATE KEY-----";
		const out = redactSecrets(`found key:\n${pem}\ndone`);
		expect(out).not.toContain("MIIEowIBAAKCAQEA");
		expect(out).toContain("done");
	});
});

describe("staying readable", () => {
	it("leaves ordinary output alone", () => {
		const text = "Read 34 files, wrote 2, and the tests passed in 4.2s.";
		expect(redactSecrets(text)).toBe(text);
	});

	it("does not redact prose that merely mentions a token", () => {
		const text = "The token bucket refills every second.";
		expect(redactSecrets(text)).toBe(text);
	});

	it("does not mangle a path that looks like base64", () => {
		const text = "wrote dist/assets/index-a1b2c3d4.js";
		expect(redactSecrets(text)).toBe(text);
	});
});

describe("saying what happened", () => {
	it("reports which rule matched, by name", () => {
		const result = redactSecretsVerbose('Authorization: Bearer abc123def456ghi789');
		expect(result.matched).toContain("authorization-header");
	});

	it("reports nothing when nothing matched", () => {
		expect(redactSecretsVerbose("all clear").matched).toEqual([]);
	});

	it("finds every secret in a string, not just the first", () => {
		// A global regex reused across calls carries lastIndex and skips every
		// other match. This is the test that catches that.
		const out = redactSecrets("a=ghp_aaaaaaaaaaaaaaaaaaaaaaaa b=ghp_bbbbbbbbbbbbbbbbbbbbbbbb");
		expect(out).not.toContain("ghp_a");
		expect(out).not.toContain("ghp_b");
	});

	it("is stable across calls", () => {
		const input = "token=ghp_abcdefghijklmnopqrstuvwx";
		expect(redactSecrets(input)).toBe(redactSecrets(input));
	});
});

describe("structures, which is how tool arguments arrive", () => {
	it("redacts a leaf without flattening the shape", () => {
		const out = redactDeep({ url: "https://api.example.com", headers: { authorization: "Bearer abc123" } });
		expect(out).toEqual({
			url: "https://api.example.com",
			headers: { authorization: REDACTED },
		});
	});

	it("redacts by key name even when the value looks harmless", () => {
		// "hunter2" matches no pattern, and it is still a password.
		expect(redactDeep({ password: "hunter2" })).toEqual({ password: REDACTED });
	});

	it("walks arrays", () => {
		const out = redactDeep(["safe", "ghp_abcdefghijklmnopqrstuvwx"]) as string[];
		expect(out[0]).toBe("safe");
		expect(out[1]).toBe(REDACTED);
	});

	it("leaves non-strings as they are", () => {
		expect(redactDeep({ count: 3, ok: true, nothing: null })).toEqual({
			count: 3,
			ok: true,
			nothing: null,
		});
	});

	it("fails closed on something too deep to walk", () => {
		// Tool arguments come from a model and can be pathological. Replacing
		// past the limit is the safe direction.
		let deep: unknown = "ghp_abcdefghijklmnopqrstuvwx";
		for (let i = 0; i < 20; i++) deep = { nested: deep };
		expect(JSON.stringify(redactDeep(deep))).not.toContain("ghp_");
	});

	it("does not throw on a cyclic structure", () => {
		// It cannot be serialised, and dropping the event is worse than a
		// truncated preview.
		const cyclic: Record<string, unknown> = { name: "loop" };
		cyclic.self = cyclic;
		expect(() => redactDeep(cyclic)).not.toThrow();
	});
});
