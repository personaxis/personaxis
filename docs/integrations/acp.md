# ACP: a persona as the agent in your editor

`personaxis-acp` is the process an editor launches to run a persona. Zed, JetBrains, VS Code and any
other client that speaks the Agent Client Protocol start an agent as a child process and talk to it over
stdio; this is that process. It ships in the `personaxis` package, next to the `personaxis` binary.

## What it does

- It opens the persona that lives in the directory the editor starts it in, at
  `.personaxis/personaxis.md`.
- It runs each turn with the persona's compiled gate attached, so the persona's own policy decides every
  tool call. When the policy wants a person rather than a rule, the question goes to the editor and
  whoever is sitting there answers it.
- It gives the turn the same runtime context the terminal session gets: what the persona has, and where
  its work goes (see [awareness](../architecture/awareness.md)).
- It writes the persona's record on your machine, so the turn appears in `personaxis audit` like any other.
- The persona evolves from what it does in the editor too. A band crossed during a turn rewrites the
  compiled document for the next session.

## Requirements

- A persona in the project directory. Without one, the editor shows `session/new` failing, which is the
  right place for it: a session that opened and then failed every turn would look like a persona with
  nothing to say.
- A model. Set `local.endpoint` and `local.model` with `personaxis config set --global ...`, or
  `PERSONAXIS_ENDPOINT` and `PERSONAXIS_MODEL` in the environment the editor launches the process with
  (see [configuration](../guides/configuration.md)).

## Registering it

Register `personaxis-acp` as a custom agent command in your editor's ACP settings. It takes no arguments
and speaks the protocol on stdin and stdout. The exact setting differs by editor, so follow your
editor's documentation for adding an external ACP agent.

The repository tests the process and its protocol layer (`packages/cli/test/acp-*.test.ts` and
`@personaxis/protocol`). It has not been verified against a specific editor release, so check it in
yours before relying on it.
