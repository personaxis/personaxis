/**
 * E88: a draft the persona wrote about its own work is visible where a person can approve it.
 *
 * Written because nothing watched it. The writer leaves the file in `skills/pending/` and deliberately does
 * NOT declare or register it, so a list built from `extensions.skills` cannot see it, and a draft nobody can
 * see is a draft nobody approves. The miniapp and the external subcommands share this layer, so both surfaces
 * answer the same thing.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { listSkills } from "../src/repl/views/skills-data.js";

let dir: string;
let personaPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pxs-e88-tui-"));
  personaPath = join(dir, ".personaxis", "personaxis.md");
  mkdirSync(join(dir, ".personaxis"), { recursive: true });
  writeFileSync(personaPath, "---\napiVersion: personaxis/v1\nkind: Persona\n---\n# Boss\n");
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** What `writeSelfSkill` leaves under `suggesting`: a file, declared nowhere. */
function draft(name: string): void {
  const at = join(dir, ".personaxis", "skills", "pending");
  mkdirSync(at, { recursive: true });
  writeFileSync(join(at, `${name}.md`), `---\nname: ${name}\n---\n1. Do the thing.\n`);
}

describe("drafts waiting for a person (E88)", () => {
  it("shows a pending draft, which nothing declares", () => {
    draft("fix-a-crashing-page");

    expect(listSkills(personaPath)).toEqual([{ name: "fix-a-crashing-page", kind: "self-written", status: "pending" }]);
  });

  it("shows nothing when there are no drafts, which is the ordinary case", () => {
    expect(listSkills(personaPath)).toEqual([]);
  });

  it("lists drafts after the declared skills, so a pending method never reads as one in use", () => {
    mkdirSync(join(dir, ".personaxis", "skills", "research"), { recursive: true });
    writeFileSync(join(dir, ".personaxis", "skills", "research", "SKILL.md"), "---\nname: research\ndescription: d\n---\nhow\n");
    writeFileSync(
      personaPath,
      "---\napiVersion: personaxis/v1\nkind: Persona\nextensions:\n  skills:\n    - ./skills/research\n---\n# Boss\n",
    );
    draft("fix-a-crashing-page");

    const rows = listSkills(personaPath);
    expect(rows.at(-1)).toMatchObject({ name: "fix-a-crashing-page", status: "pending" });
    expect(rows).toHaveLength(2);
  });

  it("still shows the drafts when the spec cannot be read, because they are beside it and not in it", () => {
    writeFileSync(personaPath, "not: [valid: yaml");
    draft("fix-a-crashing-page");

    expect(listSkills(personaPath).map((r) => r.status)).toEqual(["pending"]);
  });
});
