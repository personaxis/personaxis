#!/usr/bin/env node
/**
 * Dedicated `personaxis-dash` bin entry. This file is the ONLY place the
 * dashboard auto-runs, the library barrel (index.ts) must never carry a
 * main-module guard: inside a bun-compiled binary every bundled module
 * shares the virtual root, so `import.meta.url === argv[1]` guards fire
 * spuriously on every invocation (found in FR.V verification).
 */
import { dashMain } from "./index.js";

dashMain().catch((err) => {
  console.error("personaxis-dash fatal:", err);
  process.exit(1);
});
