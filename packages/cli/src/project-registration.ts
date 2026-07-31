/**
 * The registry learns about a project BY USE, never by searching the disk.
 *
 * This is the primary and normal mechanism: the moment a persona is created, opened,
 * compiled, messaged or diagnosed, the CLI already knows exactly where it is, so it
 * records it then. Registration is a by-product of using the tool, costs one small write,
 * and is always correct because it reflects something that actually happened.
 *
 * The alternative, walking the filesystem looking for personas, is the wrong default: it
 * is slow (a real run touched ~1700 directories to find four projects), it burns work to
 * rediscover what the tool was already told, and it means reading through folders nobody
 * asked us to read. A scan exists (`personaxis overseer scan`) but only as RECOVERY, for
 * projects that already existed before this mechanism did, and only over folders the user
 * names.
 *
 * Registration used to happen in exactly one place, opening the REPL inside a project, so
 * a project you only ever compiled stayed invisible. The answer to "what personas do I
 * have" cannot depend on which command someone happened to use.
 *
 * Best-effort by construction: a registry write must never break, slow or complicate the
 * command the user actually asked for.
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { registerProject } from "@personaxis/core";
import { discoverTree } from "./repl/roster.js";

/**
 * @param personaPath the persona in scope, or undefined to derive from the cwd.
 *
 * The HOME persona is deliberately not a project: `~/.personaxis` is where the CLI keeps
 * its own configuration, and listing the home directory among someone's projects is noise.
 */
export function noteProject(personaPath?: string): void {
  try {
    const p = personaPath ?? resolve(process.cwd(), ".personaxis", "personaxis.md");
    if (!existsSync(p)) return;
    const norm = resolve(p).replace(/\\/g, "/");
    const home = resolve(homedir()).replace(/\\/g, "/");
    if (!norm.endsWith("/.personaxis/personaxis.md")) return; // a sub-persona: its project is registered by its root
    if (norm.startsWith(`${home}/.personaxis/`)) return;
    registerProject(dirname(dirname(resolve(p))), discoverTree(p).map((s) => s.address));
  } catch {
    /* the registry is a convenience; it never gets in the way of the actual command */
  }
}
