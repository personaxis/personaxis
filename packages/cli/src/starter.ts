/**
 * Starter-persona scaffolding for first-run onboarding.
 *
 * Writes a valid, immediately-playable generic companion persona (embedded as
 * templates/starter_persona.md) to `<dir>/.personaxis/personaxis.md`, with the
 * chosen name/slug substituted. It passes `personaxis validate` out of the box.
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { templates } from "./generated/assets.js";

export function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "companion"
  );
}

export function writeStarterPersona(baseDir: string, name: string): string {
  const slug = slugify(name);
  const dir = join(baseDir, ".personaxis");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "personaxis.md");
  const content = templates["starter_persona.md"]
    .replace(/__SLUG__/g, slug)
    .replace(/__NAME__/g, name)
    .replace(/__DATE__/g, new Date().toISOString().slice(0, 10));
  writeFileSync(path, content, "utf-8");
  return path;
}
