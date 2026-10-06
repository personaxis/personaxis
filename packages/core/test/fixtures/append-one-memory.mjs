/**
 * Writes ONE episodic entry and exits. Spawned several times at once by
 * `memory-concurrency.test.ts`, which is the only way to exercise a lock: within a
 * single process the re-anchor alone is enough, and a test that never starts a second
 * process proves nothing about the thing the lock is for.
 *
 *   node append-one-memory.mjs <personaPath> <content>
 *
 * The sleep between preparing and committing is the point. It widens the window the
 * race lives in so the test is about the mechanism rather than about who won.
 */
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const { prepareMemoryEntry, commitMemoryEntry } = await import(
  pathToFileURL(join(HERE, "..", "..", "dist", "index.js")).href
);

const [personaPath, content] = process.argv.slice(2);
const entry = prepareMemoryEntry(personaPath, { content, source: "internal" });
await sleep(40);
commitMemoryEntry(personaPath, entry);
