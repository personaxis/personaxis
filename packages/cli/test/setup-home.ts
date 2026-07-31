/**
 * V5.FIX.1: hermetic PERSONAXIS_HOME for the ENTIRE cli test suite.
 *
 * Root cause of the incident this guards against: a test sandboxed the global
 * config by mutating process.env.PERSONAXIS_HOME in beforeEach/afterEach around
 * ASYNC UI work; a deferred write (or a crashed worker) landed after the
 * restore and clobbered the developer's REAL ~/.personaxis/config.json
 * (defaultProfile flipped to the test's "openai" profile → every model call
 * 401'd with "no api key supplied").
 *
 * This setup file runs ONCE PER WORKER, before any test module loads, and
 * points PERSONAXIS_HOME at a throwaway directory for the whole process
 * lifetime. There is no restore step by design: the worker process dies with
 * the sandbox. Tests that set their own PERSONAXIS_HOME still work (they
 * override within the already-sandboxed process); no cli test can ever see or
 * write the real user home again.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.PERSONAXIS_HOME = mkdtempSync(join(tmpdir(), "pxs-test-home-"));
