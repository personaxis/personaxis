# Contributing to personaxis

Thanks for helping. This repository holds the eight packages of the Personaxis CLI and engine. The open
file format they implement lives in [persona.md](https://github.com/personaxis/persona.md): a change to what
a persona file may contain starts there, as an issue.

## Set up

You need Node 20.18.1 or newer and pnpm 10 (the version is pinned in `package.json`).

```bash
git clone https://github.com/personaxis/personaxis && cd personaxis
pnpm install
pnpm run build
node packages/cli/dist/index.js proof --quick   # a few seconds: confirms the build works
```

## Before you open a pull request

Run what CI runs. Each line is a script in the root `package.json`:

```bash
pnpm test                    # every package's test suite
pnpm lint                    # type-check every package
pnpm check-test-types        # tests go through the type checker, with a ceiling per package
pnpm check-private           # no public file points at private work or carries personal data
pnpm check-private-history   # no commit of your branch adds personal data, even one a later commit removes
pnpm check-docs-style        # the public docs keep the writing rules a program can measure
pnpm check-docs-refs         # the architecture docs cite code that exists
pnpm check-mirror            # the spec mirror matches the persona.md checkout, if you have it next to this one
```

Public documentation has to match what the code does. A test fails when the documented commands and the
registered commands disagree, so change the page in the same pull request as the code.

## Changing the spec files

`packages/spec/schema/` and `packages/cli/templates/` are canonical here, and `docs/SPEC.md` is canonical in
the persona.md repository. After a change, run `pnpm sync-mirror` to copy each file to its other home, and
open a pull request in each repository.

## Commits and pull requests

- Branch from `main`, keep commits small, and write them in English as `type(scope): what changed and why`.
- Look at `git status` and `git diff --stat` before every commit, so a generated file or a local setting
  does not travel with it.
- Never commit personal data: a user name, a machine name, a local path or a personal e-mail. A commit that
  adds one cannot be taken back by a later commit, because the history is public. CI reads every commit of
  the pull request, text and binary files alike, and fails the build on it.
- A pull request needs a green CI before it merges. Pull requests are merged with a merge commit, so the
  history of the branch stays.

## Reporting a problem

Open an issue with the command you ran, what you expected, and what happened. For a security problem, do not
put the details in a public issue: open one that says you have a security report and nothing else, and a
maintainer will follow up.
