/**
 * What the kernel promises, checked.
 *
 * The tests are grouped by the promise they hold, not by the file they exercise,
 * because a promise is what somebody reading this needs to trust. Each name is the
 * sentence that would appear in the header of the thing it protects.
 */

import { describe, expect, it, vi } from "vitest";

import {
	EffectScope,
	EventBus,
	GRANTED,
	Kernel,
	KernelError,
	LIFECYCLE,
	PERMISSIONS,
	denied,
	event,
	once,
	permissionKey,
	serviceKey,
	type Component,
	type LifecycleEvent,
	type PermissionSource,
} from "../src/kernel/index.js";

const CLOCK = serviceKey<{ now(): number }>("clock");
const STORE = serviceKey<{ read(): string }>("store");
const WRITE_FILES = permissionKey("write.files");
const REACH_NETWORK = permissionKey("reach.network");

/** A permission source whose answers a test can change between settles. */
function sourceOf(granted: Set<string>): PermissionSource {
	return {
		answer: (permission) =>
			granted.has(permission.id) ? GRANTED : denied(`not in this machine's consent`),
	};
}

/** Collects lifecycle entries the way the record eventually will. */
function watch(kernel: Kernel): LifecycleEvent[] {
	const seen: LifecycleEvent[] = [];
	kernel.bus.onNotify(LIFECYCLE, "test", (entry) => {
		seen.push(entry);
	});
	return seen;
}

describe("a component waits rather than fails", () => {
	it("stays pending until what it declared exists, whatever the mount order", () => {
		const kernel = new Kernel();
		const activated = vi.fn();

		kernel.mount({
			name: "reader",
			needs: [CLOCK],
			activate: (ctx) => {
				activated(ctx.get(CLOCK).now());
			},
		});

		expect(kernel.stateOf("reader")).toBe("pending");
		expect(activated).not.toHaveBeenCalled();

		kernel.provide(CLOCK, { now: () => 7 });

		expect(kernel.stateOf("reader")).toBe("active");
		expect(activated).toHaveBeenCalledWith(7);
	});

	it("says which key it is waiting for, because a bare pending sends people looking", () => {
		const kernel = new Kernel();
		const seen = watch(kernel);
		kernel.mount({ name: "reader", needs: [STORE], activate: () => {} });
		kernel.provide(CLOCK, { now: () => 0 });

		const waiting = seen.find((entry) => entry.to === "pending");
		expect(waiting?.reason).toContain("store");
	});

	it("resolves a chain no matter which end is mounted first", () => {
		// Mounting order is the thing a declared graph is supposed to stop mattering,
		// so this is the one to break if the settle loop is wrong.
		for (const reversed of [false, true]) {
			const kernel = new Kernel();
			const mounts: Component[] = [
				{
					name: "middle",
					needs: [CLOCK],
					activate: (ctx) => {
						ctx.scope.use(
							kernelProvide(kernel, STORE, { read: () => String(ctx.get(CLOCK).now()) }),
						);
					},
				},
				{ name: "leaf", needs: [STORE], activate: () => {} },
			];
			for (const component of reversed ? [...mounts].reverse() : mounts) {
				kernel.mount(component);
			}
			kernel.provide(CLOCK, { now: () => 1 });

			expect(kernel.stateOf("middle")).toBe("active");
			expect(kernel.stateOf("leaf")).toBe("active");
		}
	});
});

describe("a permission is the same mechanism as a service", () => {
	it("keeps a component pending when nothing can answer its permission", () => {
		const kernel = new Kernel();
		kernel.mount({ name: "writer", requires: [WRITE_FILES], activate: () => {} });

		expect(kernel.stateOf("writer")).toBe("pending");
	});

	it("activates when the permission is granted and names the denial when it is not", () => {
		const kernel = new Kernel();
		const seen = watch(kernel);
		kernel.provide(PERMISSIONS, sourceOf(new Set([WRITE_FILES.id])));

		kernel.mount({ name: "writer", requires: [WRITE_FILES], activate: () => {} });
		kernel.mount({ name: "caller", requires: [REACH_NETWORK], activate: () => {} });

		expect(kernel.stateOf("writer")).toBe("active");
		expect(kernel.stateOf("caller")).toBe("pending");
		const refused = seen.find((entry) => entry.component === "caller");
		expect(refused?.reason).toContain("reach.network");
		expect(refused?.reason).toContain("consent");
	});

	it("suspends the dependents of a withdrawn permission and nothing else", () => {
		const kernel = new Kernel();
		const granted = new Set([WRITE_FILES.id, REACH_NETWORK.id]);
		kernel.provide(PERMISSIONS, sourceOf(granted));
		kernel.provide(CLOCK, { now: () => 0 });

		const torn: string[] = [];
		kernel.mount({
			name: "writer",
			requires: [WRITE_FILES],
			activate: (ctx) => {
				ctx.scope.use(() => torn.push("writer"));
			},
		});
		kernel.mount({
			name: "watcher",
			needs: [CLOCK],
			activate: (ctx) => {
				ctx.scope.use(() => torn.push("watcher"));
			},
		});

		expect(kernel.stateOf("writer")).toBe("active");

		granted.delete(WRITE_FILES.id);
		kernel.replace(PERMISSIONS, sourceOf(granted));

		expect(kernel.stateOf("writer")).toBe("suspended");
		expect(kernel.stateOf("watcher")).toBe("active");
		expect(torn).toEqual(["writer"]);
	});

	it("treats a source that throws as a denial, never as a yes", () => {
		const kernel = new Kernel();
		kernel.provide(PERMISSIONS, {
			answer: () => {
				throw new Error("the consent store is unreadable");
			},
		});
		const seen = watch(kernel);
		kernel.mount({ name: "writer", requires: [WRITE_FILES], activate: () => {} });

		expect(kernel.stateOf("writer")).toBe("pending");
		expect(seen.at(-1)?.reason).toContain("unreadable");
	});
});

describe("the epoch is what says whether anything changed", () => {
	it("reloads a component when its provider is replaced", () => {
		const kernel = new Kernel();
		kernel.provide(CLOCK, { now: () => 1 });
		const runs: number[] = [];
		kernel.mount({
			name: "reader",
			needs: [CLOCK],
			activate: (ctx) => {
				runs.push(ctx.get(CLOCK).now());
			},
		});

		const before = kernel.epochOf("reader");
		kernel.replace(CLOCK, { now: () => 2 });

		expect(runs).toEqual([1, 2]);
		expect(kernel.epochOf("reader")).not.toBe(before);
	});

	it("leaves a component alone when a key it never asked for changes", () => {
		const kernel = new Kernel();
		kernel.provide(CLOCK, { now: () => 1 });
		let runs = 0;
		kernel.mount({
			name: "reader",
			needs: [CLOCK],
			activate: () => {
				runs += 1;
			},
		});

		kernel.provide(STORE, { read: () => "x" });

		expect(runs).toBe(1);
	});

	it("refuses a read of a key the component did not declare", () => {
		// An undeclared read is invisible to the epoch, so the component would keep
		// running against a provider that had already been replaced.
		const kernel = new Kernel();
		const seen = watch(kernel);
		kernel.provide(CLOCK, { now: () => 1 });
		kernel.provide(STORE, { read: () => "x" });
		kernel.mount({
			name: "sneak",
			needs: [CLOCK],
			activate: (ctx) => {
				ctx.get(STORE);
			},
		});

		expect(kernel.stateOf("sneak")).toBe("failed");
		expect(seen.at(-1)?.failure?.code).toBe("service_absent");
	});
});

describe("effects come apart in the opposite order", () => {
	it("unwinds newest first", () => {
		const order: string[] = [];
		const scope = new EffectScope("test");
		scope.use(() => order.push("first"));
		scope.use(() => order.push("second"));
		scope.use(() => order.push("third"));

		scope.unwind();

		expect(order).toEqual(["third", "second", "first"]);
	});

	it("keeps unwinding after a disposer throws, and reports it", () => {
		const order: string[] = [];
		const scope = new EffectScope("test");
		scope.use(() => order.push("first"));
		scope.use(() => {
			throw new Error("teardown broke");
		});
		scope.use(() => order.push("third"));

		const failures = scope.unwind();

		expect(order).toEqual(["third", "first"]);
		expect(failures).toHaveLength(1);
		expect(failures[0]!.code).toBe("disposal_failed");
	});

	it("refuses an effect registered while unwinding, with its own code", () => {
		const scope = new EffectScope("test");
		let caught: unknown;
		scope.use(() => {
			try {
				scope.use(() => {});
			} catch (thrown) {
				caught = thrown;
			}
		});

		scope.unwind();

		expect((caught as KernelError).code).toBe("effect_after_unwind");
	});

	it("unwinds a child when its parent unwinds", () => {
		const order: string[] = [];
		const parent = new EffectScope("parent");
		parent.use(() => order.push("parent effect"));
		const child = parent.child("child");
		child.use(() => order.push("child effect"));

		parent.unwind();

		expect(order).toEqual(["child effect", "parent effect"]);
	});

	it("makes a disposer safe to run twice", () => {
		let count = 0;
		const dispose = once(() => {
			count += 1;
		});
		dispose();
		dispose();
		expect(count).toBe(1);
	});

	it("unwinds a component's partial effects when its activation throws", () => {
		const kernel = new Kernel();
		const torn: string[] = [];
		kernel.provide(CLOCK, { now: () => 1 });
		kernel.mount({
			name: "half",
			needs: [CLOCK],
			activate: (ctx) => {
				ctx.scope.use(() => torn.push("the part that did register"));
				throw new Error("and then it broke");
			},
		});

		expect(kernel.stateOf("half")).toBe("failed");
		expect(torn).toEqual(["the part that did register"]);
	});
});

describe("an event's mode belongs to the event", () => {
	it("lets a waterfall listener transform, and the terminal sees the transform", async () => {
		const STEP = event<{ text: string }, string>("step", "waterfall");
		const bus = new EventBus();
		bus.onWaterfall(STEP, "upper", async (payload, next) =>
			next({ text: payload.text.toUpperCase() }),
		);

		const result = await bus.waterfall(STEP, { text: "hola" }, async (p) => p.text);

		expect(result).toBe("HOLA");
	});

	it("lets a waterfall listener decide by not delegating", async () => {
		const STEP = event<{ text: string }, string>("step", "waterfall");
		const bus = new EventBus();
		const terminal = vi.fn(async () => "ran");
		bus.onWaterfall(STEP, "veto", async () => "refused");

		const result = await bus.waterfall(STEP, { text: "x" }, terminal);

		expect(result).toBe("refused");
		expect(terminal).not.toHaveBeenCalled();
	});

	it("fails the dispatch when a decision-point listener throws", async () => {
		// A listener that threw halfway did not decide. Containing it here would turn
		// a crash into a silent allow, which is the one reading a gate cannot survive.
		const STEP = event<null, string>("step", "waterfall");
		const bus = new EventBus();
		const terminal = vi.fn(async () => "ran");
		bus.onWaterfall(STEP, "broken", async () => {
			throw new Error("listener broke");
		});

		await expect(bus.waterfall(STEP, null, terminal)).rejects.toThrow("listener broke");
		expect(terminal).not.toHaveBeenCalled();
	});

	it("gives every parallel listener its chance even when one fails", async () => {
		const DRAIN = event<null>("drain", "parallel");
		const bus = new EventBus();
		const wrote: string[] = [];
		bus.onAwaited(DRAIN, "a", () => {
			wrote.push("a");
		});
		bus.onAwaited(DRAIN, "b", () => {
			throw new Error("disk full");
		});
		bus.onAwaited(DRAIN, "c", () => {
			wrote.push("c");
		});

		const report = await bus.parallel(DRAIN, null);

		expect(wrote.sort()).toEqual(["a", "c"]);
		expect(report.failures).toHaveLength(1);
		expect(report.failures[0]!.subject).toContain("b");
	});

	it("contains a notify listener's failure and names whose it was", () => {
		const TICK = event<number>("tick", "notify");
		const bus = new EventBus();
		const seen: number[] = [];
		bus.onNotify(TICK, "counter", () => {
			throw new Error("observer broke");
		});
		bus.onNotify(TICK, "good", (n) => seen.push(n));

		const report = bus.notify(TICK, 3);

		expect(seen).toEqual([3]);
		expect(report.failures[0]!.subject).toContain("counter");
	});

	it("refuses to dispatch an event as a mode it did not declare", async () => {
		const TICK = event<number>("tick", "notify");
		const bus = new EventBus();

		await expect(bus.serial(TICK as never, 1)).rejects.toThrow(/declared notify/);
	});

	it("refuses to subscribe to an event as a mode it did not declare", () => {
		const TICK = event<number>("tick", "notify");
		const bus = new EventBus();

		expect(() => bus.onAwaited(TICK as never, "x", () => {})).toThrow(/declared notify/);
	});

	it("unsubscribes a component's listeners when it reloads, so it never listens twice", () => {
		const TICK = event<number>("tick", "notify");
		const kernel = new Kernel();
		kernel.provide(CLOCK, { now: () => 1 });
		const seen: string[] = [];
		kernel.mount({
			name: "listener",
			needs: [CLOCK],
			activate: (ctx) => {
				ctx.bus.onNotify(TICK, "ignored", () => seen.push(ctx.name));
			},
		});

		kernel.replace(CLOCK, { now: () => 2 });
		kernel.bus.notify(TICK, 1);

		expect(seen).toEqual(["listener"]);
		expect(kernel.bus.countFor(TICK)).toBe(1);
	});
});

describe("every lifecycle change is reportable", () => {
	it("reports the epoch on activation, which is what an audit reads", () => {
		const kernel = new Kernel();
		const seen = watch(kernel);
		kernel.provide(CLOCK, { now: () => 1 });
		kernel.mount({ name: "reader", needs: [CLOCK], activate: () => {} });

		const activated = seen.find((entry) => entry.to === "active");
		expect(activated?.epoch).toContain("clock@");
	});

	it("reports a suspension with the reason it suspended", () => {
		const kernel = new Kernel();
		const drop = kernel.provide(CLOCK, { now: () => 1 });
		kernel.mount({ name: "reader", needs: [CLOCK], activate: () => {} });
		const seen = watch(kernel);

		drop();

		const suspended = seen.find((entry) => entry.to === "suspended");
		expect(suspended?.reason).toContain("clock");
	});
});

describe("the kernel refuses what it cannot make sense of", () => {
	it("refuses two providers for one key", () => {
		const kernel = new Kernel();
		kernel.provide(CLOCK, { now: () => 1 });

		expect(() => kernel.provide(CLOCK, { now: () => 2 })).toThrow(/already has a provider/);
	});

	it("refuses two components with one name", () => {
		const kernel = new Kernel();
		kernel.mount({ name: "twin", activate: () => {} });

		expect(() => kernel.mount({ name: "twin", activate: () => {} })).toThrow(/already mounted/);
	});

	it("wraps anything thrown so no failure reaches the record without a code", () => {
		const kernel = new Kernel();
		const seen = watch(kernel);
		kernel.mount({
			name: "rude",
			activate: () => {
				throw "a bare string";
			},
		});

		expect(seen.at(-1)?.failure?.code).toBe("activation_failed");
		expect(seen.at(-1)?.failure?.message).toBe("a bare string");
	});
});

/** Provides while a component is activating, returning the undo for its scope. */
function kernelProvide<T>(kernel: Kernel, key: Parameters<Kernel["provide"]>[0], value: T) {
	return kernel.provide(key as never, value as never);
}
