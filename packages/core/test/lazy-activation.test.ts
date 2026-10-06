/**
 * A plugin that nobody has needed yet has not run.
 *
 * K2. `K1` made the catalogue readable without executing anything; this is what that
 * buys. With hundreds of plugins and several personas on one machine, activating
 * everything in order to have it available is a cost paid at every start, by every
 * persona, for work that mostly will not happen in that session.
 *
 * The word matters as much as the mechanism. `dormant` is not `pending`, and they are
 * opposite facts that would otherwise share a name: pending means something is MISSING
 * and a person may have to go and provide it, dormant means everything is there and
 * nobody has asked. Collapsing them sends somebody looking for a provider that is not
 * absent, which is the failure mode the kernel's own header warns about for pending
 * components with no reason attached.
 */

import { describe, expect, it } from "vitest";

import { Kernel, event, serviceKey, type Component } from "../src/kernel/index.js";

const OPENED = event<{ path: string }>("editor.opened", "notify");
const SAVED = event<{ path: string }>("editor.saved", "notify");
const ASKED = event<{ text: string }>("editor.asked", "waterfall");

const CLOCK = serviceKey<() => number>("clock");

/** A component that records whether it ran, so "did not run" is a fact and not a hope. */
function spy(over: Partial<Component> = {}): Component & { runs: () => number } {
	let runs = 0;
	return {
		name: "plugin",
		activate: () => {
			runs += 1;
		},
		...over,
		runs: () => runs,
	};
}

describe("a component that waits to be needed", () => {
	it("does not run when it is mounted", () => {
		const kernel = new Kernel();
		const plugin = spy({ activatesOn: [OPENED] });

		kernel.mount(plugin);

		expect(plugin.runs()).toBe(0);
		expect(kernel.stateOf("plugin")).toBe("dormant");
	});

	it("runs when its event happens", () => {
		const kernel = new Kernel();
		const plugin = spy({ activatesOn: [OPENED] });
		kernel.mount(plugin);

		kernel.bus.notify(OPENED, { path: "a.ts" });

		expect(plugin.runs()).toBe(1);
		expect(kernel.stateOf("plugin")).toBe("active");
	});

	it("runs once, however often the event happens again", () => {
		// Waking twice would re-run an activation whose effects are already registered,
		// and the second registration is what leaves two subscriptions on one bus.
		const kernel = new Kernel();
		const plugin = spy({ activatesOn: [OPENED] });
		kernel.mount(plugin);

		for (let index = 0; index < 5; index += 1) kernel.bus.notify(OPENED, { path: "a.ts" });

		expect(plugin.runs()).toBe(1);
	});

	it("wakes on any of the events it named, not all of them", () => {
		const kernel = new Kernel();
		const plugin = spy({ activatesOn: [OPENED, SAVED] });
		kernel.mount(plugin);

		kernel.bus.notify(SAVED, { path: "a.ts" });

		expect(plugin.runs()).toBe(1);
	});

	it("is not woken by an event that happened before it was mounted", () => {
		// Waking is about what happens next. Replaying history into a component that was
		// not there activates it for work that is already finished.
		const kernel = new Kernel();
		kernel.bus.notify(OPENED, { path: "a.ts" });

		const plugin = spy({ activatesOn: [OPENED] });
		kernel.mount(plugin);

		expect(plugin.runs()).toBe(0);
	});
});

describe("dormant is not pending", () => {
	it("says it is waiting to be needed, not waiting for something missing", () => {
		// The reason is the single most useful thing about a component that is not
		// running, and these two reasons send a person to different places.
		const kernel = new Kernel();
		const reasons: string[] = [];
		kernel.bus.onNotify(
			{ name: "kernel.lifecycle", mode: "notify", recorded: true },
			"test",
			(payload) => {
				const change = payload as { component: string; to: string; reason?: string };
				if (change.component === "plugin" && change.reason) reasons.push(change.reason);
			},
		);

		kernel.mount(spy({ activatesOn: [OPENED] }));

		expect(reasons).toContain("waiting to be needed");
	});

	it("does not go looking for what it needs while it is dormant", () => {
		// A dormant component's dependencies are not the question. Resolving them at
		// every start, for every plugin, is exactly the work this removes.
		const kernel = new Kernel();
		const plugin = spy({ activatesOn: [OPENED], needs: [CLOCK] });

		kernel.mount(plugin);

		expect(kernel.stateOf("plugin")).toBe("dormant");
	});

	it("becomes pending, and stays unrun, when it wakes without what it needs", () => {
		// Waking is not activating. It only means the question is now worth asking, and
		// the answer here is still no.
		const kernel = new Kernel();
		const plugin = spy({ activatesOn: [OPENED], needs: [CLOCK] });
		kernel.mount(plugin);

		kernel.bus.notify(OPENED, { path: "a.ts" });

		expect(kernel.stateOf("plugin")).toBe("pending");
		expect(plugin.runs()).toBe(0);
	});

	it("activates later, when what it needed arrives", () => {
		const kernel = new Kernel();
		const plugin = spy({ activatesOn: [OPENED], needs: [CLOCK] });
		kernel.mount(plugin);
		kernel.bus.notify(OPENED, { path: "a.ts" });

		kernel.provide(CLOCK, () => 0);

		expect(kernel.stateOf("plugin")).toBe("active");
		expect(plugin.runs()).toBe(1);
	});
});

describe("what may wake a component", () => {
	it("refuses a trigger that could delay or veto the thing that woke it", () => {
		// The same argument LIFECYCLE makes: an observer that can block what it observes
		// is the mechanism, not an observer. Refused at MOUNT, so a component with an
		// impossible trigger fails when it is installed rather than days later, in front
		// of a person, when its event finally fires.
		const kernel = new Kernel();

		expect(() => kernel.mount(spy({ activatesOn: [ASKED as never] }))).toThrow(
			/only be woken by a notify event/,
		);
	});

	it("leaves a component that named no events exactly as it was", () => {
		// The behaviour of everything written before this is unchanged by construction
		// rather than by a flag somebody has to remember to set.
		const kernel = new Kernel();
		const plugin = spy();

		kernel.mount(plugin);

		expect(plugin.runs()).toBe(1);
		expect(kernel.stateOf("plugin")).toBe("active");
	});

	it("stops listening when it is unmounted", () => {
		// The subscriptions belong to the kernel, because the component's own scope does
		// not exist until it activates. Something has to drop them.
		//
		// Asserted on the LISTENER COUNT, and the first version was not: it checked that
		// the component had not run, which stays true whether or not the listener leaked,
		// because an unmounted entry is no longer in the list `settle` walks. The leak is
		// a subscription that outlives its component, so the count is the only thing that
		// can see it.
		const kernel = new Kernel();
		const plugin = spy({ activatesOn: [OPENED] });
		const unmount = kernel.mount(plugin);

		expect(kernel.bus.notify(OPENED, { path: "a.ts" }).listeners).toBe(1);

		unmount();

		expect(kernel.bus.notify(OPENED, { path: "a.ts" }).listeners).toBe(0);
		expect(plugin.runs()).toBe(1);
	});
});

describe("what it costs to start", () => {
	it("does no activation work for a hundred plugins nobody has needed", () => {
		// The measurement the row asks for, as a count rather than a clock: a hundred
		// components mounted, zero activations, and one wake runs exactly one of them.
		// A time-based assertion would be a flake on a busy machine and would say less.
		const kernel = new Kernel();
		let activations = 0;
		for (let index = 0; index < 100; index += 1) {
			kernel.mount({
				name: `plugin.${index}`,
				activatesOn: [index === 42 ? SAVED : OPENED],
				activate: () => {
					activations += 1;
				},
			});
		}

		expect(activations).toBe(0);

		kernel.bus.notify(SAVED, { path: "a.ts" });

		expect(activations).toBe(1);
		expect(kernel.stateOf("plugin.42")).toBe("active");
		expect(kernel.stateOf("plugin.7")).toBe("dormant");
	});
});
