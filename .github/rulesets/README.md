# Branch rulesets, kept as files

A ruleset lives in GitHub's settings, where nothing reviews it and nobody can see
when it changed. Kept here it is a file with a history, and applying it is one
command that anybody can read before running.

## What `main-checks-must-pass.json` does

**The Merge button stays grey until CI is green.** Without this, GitHub will happily
merge a pull request whose checks failed: the red cross is information, not a gate.
That matters most for the pull requests nobody reads closely, which is exactly what a
Dependabot pull request is.

It also refuses a deleted `main` and a force-push onto it. Neither is something you
do on purpose, and both are unrecoverable in the way that matters: the reflog is on
whichever machine did it.

Four checks are required, chosen because they always run:

- `test suite (ubuntu / node 22)`
- `golden test (validate CMO = PASS)`
- `governance evals (deterministic, no API keys)`
- `build & typecheck (ubuntu-latest / node 22)`

The rest of the build matrix is not required. It runs, and its result is visible, but
a required check that gets skipped blocks a pull request forever, so only the
unconditional ones are named here.

**The repository owner can bypass it.** `bypass_actors` names the admin role, so this
is a guard rail rather than a lock: it stops an accident, not a decision.

## What is verified here

**The four check names are verified.** They were compared character by character
against `gh run view --json jobs` on a real run of ci.yml, which is the only place the
true names exist. This matters more than it sounds: a required check whose name does
not match anything GitHub ever reports leaves every pull request stuck on "Expected, waiting for status to be
reported", forever, with no way to tell from the UI that the
name is simply wrong.

**`bypass_actors` is verified too, now.** Applied 2026-08-29 as ruleset 21834154, and
GitHub answered with `"current_user_can_bypass": "always"`, which is the confirmation
that `actor_id: 5` really is the administrator role. It was documented numbering until
then and is a measured fact now.

## Applying it

```sh
gh api -X POST repos/personaxis/personaxis/rulesets \
  --input .github/rulesets/main-checks-must-pass.json
```

To see what is in force, and to get the `id` you would need to change or remove one:

```sh
gh api repos/personaxis/personaxis/rulesets
gh api -X DELETE repos/personaxis/personaxis/rulesets/RULESET_ID
```

Editing the file after it is applied changes nothing on its own. Delete and re-apply,
or `PUT` to the ruleset's id.
