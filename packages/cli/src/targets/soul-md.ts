import matter from "gray-matter";

/**
 * SOUL.md placement — the identity file read by **openclaw** (workspace-root `SOUL.md`) and
 * **Hermes** (Nous Research; `~/.hermes/SOUL.md` or a per-profile `SOUL.md`). Both inject SOUL.md as
 * the FIRST section of the agent's system prompt at the start of every session.
 *
 * The modern approach (unlike the pre-v0.7 field-mapping compiler this replaces) reuses the canonical
 * compiled document produced by `runCompile` — it is already a second-person qualitative identity doc,
 * exactly what SOUL.md wants (identity, voice, values, boundaries, examples). We only strip the
 * subagent YAML frontmatter (`name`/`description`) that openclaw/Hermes don't use.
 */
export function toSoulMd(compiledText: string): string {
  const { content } = matter(compiledText);
  const body = content.trim();
  // openclaw/Hermes inject the file verbatim as identity; a leading "# SOUL" is idiomatic but not
  // required. Keep the compiled identity as-is if it already opens with a heading, else add one.
  return body.startsWith("#") ? body : `# SOUL\n\n${body}`;
}
