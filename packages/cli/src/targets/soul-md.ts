/**
 * SOUL.md placement — the identity file read by **openclaw** (workspace-root `SOUL.md`) and
 * **Hermes** (Nous Research; `~/.hermes/SOUL.md` or a per-profile `SOUL.md`). Both inject SOUL.md as
 * the FIRST section of the agent's system prompt and RE-READ it fresh each message (hot reload).
 *
 * F3.2 moved the pure logic to `@personaxis/core` (`compile/targets.ts`) so the SaaS can place
 * server-side too; this module re-exports it for existing CLI callers/tests.
 */
export { toSoulMd } from "@personaxis/core";
