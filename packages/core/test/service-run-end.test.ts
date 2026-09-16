/**
 * E89: the engine says when a run is over, and only when it really is.
 *
 * Whoever holds the disk needs that, because nothing else knows: the three ways of starting a run all pass
 * through the same ports, and none of them can tell a run that finished from one that is waiting for a person.
 * A close fired on a waiting run would consolidate half a working conversation as if it were the whole of one,
 * and that run is picked up later (`E97`).
 */
import { describe, expect, it } from "vitest";

import { runService, type ServiceDef, type ServicePorts } from "../src/service/compose.js";

/** A service of one step, which is enough: what is under test is the ending, not the line. */
const def = (requiresApproval = false): ServiceDef => ({
	address: "review",
	name: "Review",
	description: "looks at the thing",
	leadPersonaRef: "gamewright",
	steps: [{ position: 1, personaRef: "gamewright", instruction: "look at it", produces: [], requiresApproval }],
});

function ports(over: Partial<ServicePorts> = {}): { ports: ServicePorts; ends: { status: string; reason: string | null }[] } {
	// The reason can be absent, and that is the product and not a gap: a run that completed because its last
	// step said so carries no separate sentence. Declaring it `string` here was my own mistake, and this test
	// caught it before the compiler did, because vitest does not type-check.
	const ends: { status: string; reason: string | null }[] = [];
	return {
		ends,
		ports: {
			resolveService: () => undefined,
			runPersonaStep: async () => ({ outcome: "completed", summary: "had a look", reason: "done" }),
			approve: async () => "approved",
			onRunEnd: (result) => ends.push(result),
			...over,
		},
	};
}

describe("when the engine says a run is over (E89)", () => {
	it("says so when it completes, once", async () => {
		const { ports: p, ends } = ports();

		const result = await runService(def(), p);

		expect(result.status).toBe("completed");
		expect(ends).toHaveLength(1);
		expect(ends[0]?.status).toBe("completed");
	});

	it("says so when it fails, so a run that died still closes what it opened", async () => {
		const { ports: p, ends } = ports({
			runPersonaStep: async () => ({ outcome: "failed", summary: null, reason: "the model hung up" }),
		});

		const result = await runService(def(), p);

		expect(result.status).toBe("failed");
		expect(ends).toHaveLength(1);
		expect(ends[0]?.status).toBe("failed");
	});

	it("says nothing while the run is waiting for a person, because it is not over", async () => {
		// The case that matters: `E97` picks this run up later, and a close here would distil half of it.
		const { ports: p, ends } = ports({ approve: async () => "unavailable" });

		const result = await runService(def(true), p);

		expect(result.status).toBe("waiting");
		expect(ends).toEqual([]);
	});

	it("runs perfectly well for a caller that does not care when it ends", async () => {
		// The port is optional, like the journal beside it: a runner that wants none of this keeps working.
		const { ports: p } = ports();
		const bare: ServicePorts = { resolveService: p.resolveService, runPersonaStep: p.runPersonaStep, approve: p.approve };

		expect((await runService(def(), bare)).status).toBe("completed");
	});
});
