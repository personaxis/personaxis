/**
 * Services: the line a delivery follows, the note one step leaves the next, and running a
 * service that contains other services.
 *
 * `advance` and `handover` were copied here from the SaaS unchanged, with their tests, because the
 * local runner needs them. The SaaS still has its own copy: it depends on `@personaxis/core` from
 * npm, so it cannot import this module until a new version is published. Until then the two copies
 * must not diverge, and the switch is a single step recorded in the plan. `lead`, `busy` and
 * `address` stay in the SaaS until that switch, because the engine does not use them yet and an
 * export nothing reaches is exactly what `designed-not-connected` exists to refuse.
 */

export * from "./advance.js";
export * from "./handover.js";
export * from "./compose.js";
