/**
 * Genesis, creating an AI Persona from its sources (docs/architecture/genesis.md).
 *
 * Every entry mode (a brief, the interview, a project, an import, transcripts, web research) produces
 * sources (`sources.ts`); a model authors the persona from them stage by stage (`author.ts`), and every
 * field says which source it came from or what it was inferred from.
 */

/** A provider-agnostic structured-output caller (the CLI injects its provider). */
export type StructuredCaller = (prompt: string, schema: unknown, name: string) => Promise<unknown>;
