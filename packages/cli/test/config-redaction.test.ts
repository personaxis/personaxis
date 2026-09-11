/**
 * `personaxis config` must never print a secret in full, anywhere in the tree.
 *
 * This suite exists because on 2026-09-10 it did. `redact()` masked `local.apiKey` and
 * `personas.*.apiKey` and did not know about `profiles.*.apiKey`, which is exactly where
 * `config set --profile` writes one, so a real provider key printed in full to stdout: into
 * terminal scrollback, into any screen share, and into whatever gets pasted into an issue.
 *
 * The fix walks the whole object instead of naming locations, so the test that matters is
 * not "profiles are covered now" but "a shape nobody has thought of is covered too". That
 * is what `a location the redactor has never seen` below asserts.
 */

import { describe, expect, it } from "vitest";

import { redact } from "../src/commands/config.js";

/** A value shaped like a real provider key, long enough that a partial mask still hides it. */
const SECRET = "cohere_dFNYgO4L6Kd4tib6rcSoAKwGdGTdUyDwkMLDt3Z92gV9yS";

const printed = (cfg: unknown): string => JSON.stringify(redact(cfg));

describe("config redaction", () => {
	it("masks the top-level provider key", () => {
		expect(printed({ local: { apiKey: SECRET } })).not.toContain(SECRET);
	});

	it("masks a key inside a persona", () => {
		expect(printed({ personas: { marlow: { apiKey: SECRET } } })).not.toContain(SECRET);
	});

	it("masks a key inside a profile, which is the hole that leaked", () => {
		// The regression. `config set --profile <name> key <value>` writes here.
		expect(printed({ profiles: { cohereoficial: { apiKey: SECRET } } })).not.toContain(SECRET);
	});

	it("masks a key in a location the redactor has never seen", () => {
		// The point of walking the tree: a config shape that does not exist yet still cannot leak.
		const future = { workspaces: [{ connectors: { stripe: { apiKey: SECRET } } }] };
		expect(printed(future)).not.toContain(SECRET);
	});

	it("masks the other names a secret travels under", () => {
		for (const field of ["api_key", "API_KEY", "secret", "token", "password", "authorization"]) {
			expect(printed({ anything: { [field]: SECRET } })).not.toContain(SECRET);
		}
	});

	it("leaves everything that is not a secret exactly as it was", () => {
		// A redactor that eats the endpoint or the model makes the command useless, which is
		// the failure mode that gets redaction removed again by whoever is debugging.
		const cfg = {
			profiles: { p: { endpoint: "https://router.huggingface.co/v1", model: "google/gemma-3-4b-it", apiKey: SECRET } },
			defaultProfile: "p",
		};
		const out = redact(cfg);
		expect(out.profiles.p.endpoint).toBe("https://router.huggingface.co/v1");
		expect(out.profiles.p.model).toBe("google/gemma-3-4b-it");
		expect(out.defaultProfile).toBe("p");
	});

	it("does not mutate the config it was given", () => {
		// `show` redacts a live config object; a redactor that edited in place would erase the
		// key from the process that is about to use it to make a call.
		const cfg = { profiles: { p: { apiKey: SECRET } } };
		redact(cfg);
		expect(cfg.profiles.p.apiKey).toBe(SECRET);
	});

	it("keeps enough of the key to tell two providers apart", () => {
		// Masking to a constant would be safer and would make the command unusable for its
		// actual job, which is telling you WHICH key is configured.
		const a = printed({ local: { apiKey: "cohere_AAAAAAAAAAAAAAAAAAAAAAAA" } });
		const b = printed({ local: { apiKey: "hf_BBBBBBBBBBBBBBBBBBBBBBBB" } });
		expect(a).not.toBe(b);
	});

	it("does not leak a short secret by masking it into itself", () => {
		// A three-character key masked as first-three plus last-two is the key plus decoration.
		const short = "abc12";
		expect(printed({ local: { apiKey: short } })).not.toContain(short);
	});

	describe("the control of the control", () => {
		it("a redactor that only knows named locations FAILS the profiles case", () => {
			// The negative control: the old implementation, restored here, so the suite proves it
			// is catching the real defect rather than passing because the input was harmless.
			const oldRedact = (cfg: Record<string, any>) => {
				const mask = (k?: string) => (k ? k.slice(0, 3) + "…" + k.slice(-2) : k);
				const out = JSON.parse(JSON.stringify(cfg));
				if (out.local?.apiKey) out.local.apiKey = mask(out.local.apiKey);
				for (const p of Object.values<any>(out.personas ?? {})) if (p.apiKey) p.apiKey = mask(p.apiKey);
				return out;
			};
			const leaked = JSON.stringify(oldRedact({ profiles: { cohereoficial: { apiKey: SECRET } } }));
			expect(leaked).toContain(SECRET);
		});
	});
});
