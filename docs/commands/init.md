# `personaxis init`

Create this folder's persona, the way `/init` gives a repository its `CLAUDE.md`: a model reads the
folder, takes what you say it is for, asks what that leaves open, and writes the persona and its
`PERSONA.md`. A model is required; without one, `init` refuses and says how to configure one.

```bash
personaxis init                                  # read this folder, ask what it is for, then interview
personaxis init "review the payments service"    # the same, with what it is for given up front
personaxis init --yes "..."                      # never ask: folder and intent only
```

In your home folder it creates your personal persona, the one every project without its own inherits.

## The order, whatever the case

1. **This folder.** Its tree (two levels, without `.git`, `node_modules` or build output), the files
   that explain it (README, `CLAUDE.md`, `AGENTS.md`, `SOUL.md`, `CONTRIBUTING.md`, the manifest of each
   ecosystem: `package.json`, `pyproject.toml`, `Cargo.toml`, `go.mod`, …, and up to three documents from
   `docs/`) and the personas already in it, with their purpose. Bounded: a large repository costs the same
   as a small one. In the home folder or an empty one there is nothing to read, and it says so.
2. **What you want it for**, optional: the command's argument, or one question in a terminal ("Enter to
   let the model infer it"). When the folder and what you say disagree, what you say wins.
3. **Material you point at**, optional: `--from-import` (a SOUL.md or SoulSpec package, a character card,
   a system prompt), `--from-transcript` (example conversations), `--research` (the field, read on the web).
4. **The interview**, in a terminal: the model asks only what all of that leaves open, at most fifteen
   questions, any of them skippable.
5. **The persona**, stage by stage, the coherence reading, the gates, and `PERSONA.md` written by the
   model, with `CLAUDE.md` and `AGENTS.md` pointing at it.

`init` writes `.personaxis/personaxis.md` and `PERSONA.md` at the folder's root. For another persona beside
it, use [`create`](./create.md), which runs the same process. Both take the same options:

| Flag | Effect |
|---|---|
| `--from-import <file>` | also read a SOUL.md or SoulSpec package, a character card (.json/.png), a system prompt, `CLAUDE.md` or `AGENTS.md` |
| `--from-transcript <file>` | also read example conversations |
| `--research` | also search the web for the field and keep what it found in `references/` (needs a web provider key) |
| `--profile <name>` | starting stance: `regulated`, `standard` (default) or `research` |
| `--yes` | never ask (no intent question, no interview), and overwrite existing files |
| `--json` | emit the spec, gates, sources and stages as JSON (dry-run unless `--yes`) |
| `--provider <p>` | override the provider (`local \| byok \| agent`) |
| `--no-compile` | write the definition only; `PERSONA.md` comes later with `personaxis compile` |

Until 2026-10-08 `init` wrote fixed templates (a marketing persona, a blank form with TODO markers, a user
persona to fill in). There are none any more: every persona is written by a model from your sources.
