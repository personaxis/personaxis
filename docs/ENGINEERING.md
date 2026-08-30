# How work gets verified here

Rules for changing this codebase, and the platform repository beside it. Every one of
them is here because breaking it cost something measurable, and the cost is named.

This is not a style guide. Naming, imports and component structure live in `AGENTS.md`
here and in `agents.md` in the platform repository. This is about how you know a change
is right.

---

## Measure before you assert, and by more than one route

A claim about the codebase is a measurement or it is a guess, and a guess written in a
plan becomes a task somebody builds.

One route is not enough, because each one lies in a different direction. Auditing dead
modules by searching for bare identifiers reported `blackboard.ts` as alive: its four
hits were a CLI command that happens to share the name. Searching imports instead
reported **223 orphans across 96 modules**, because the barrel exports namespaces and
`gate.runGuards` appears in no import statement anywhere. Neither number was a finding.
Both signals together gave **177**, which was.

The rule that follows: when a sweep returns a suspiciously round or extreme answer,
**check the instrument before the subject**. A regex written into a shell heredoc on
this machine lost a backslash, `\\s` became `s`, the match silently returned false for
everything, and the result was "856 of 1,001 columns have no reader", `User.email`
among them. The real answer was 40. Print `regex.source` and the corpus size before
believing a number.

Every sweep in this repository therefore carries a guard on itself. `columns-with-no-reader`
asserts it scanned more than 500 files; the CI sweep asserts it found at least one CI
step. Without those, a path that stops resolving reports everything as clean, which is
the quiet failure every sweep eventually has.

## Break the test on purpose before you trust it

A test that has never failed has not been shown to work. Change the thing it watches,
watch it go red, put it back. Write what you did in the commit.

This is not ceremony. The coverage sweep for CI steps matched lines beginning `- run:
pnpm`, and the day a step gained a `name:` the `run:` moved to its own line and six
assertions went red while CI was running everything correctly. A check whose truth
depends on YAML layout cries wolf, and a check that cries wolf gets deleted.

The other direction is worse and needs its own test. `readUpTo(n)` fetches `n + 1` rows
so `withinCeiling` can tell a complete read from a truncated one, and pairing it with a
plain `take: n` makes the check **unable to ever fire** while everything stays green.
That mistake is pinned by a test of its own.

## A number that only moves one way

Where a problem is too large to fix at once, write the count down and let the gate
refuse to let it grow. Then shrink it in passes.

- `designed-not-connected`: 177 unreachable exports, and 178 fails.
- Coverage floors in `vitest.floor.ts`, one column, per package.
- Query ceilings, named, in one file.

The mechanism is not the number, it is that **moving it costs a line in a diff somebody
reads**. A threshold is rarely broken; it is quietly relaxed. When a floor does have to
come down, the reason goes in the file: `database` went 72 to 71 because reformatting
changed how V8 attributes a function, and that sentence is what stops the next reader
assuming it was neglect.

## Name the exceptions, or the rule is worthless

Everything a gate lets through is listed, with the reason or the task that closes it.
Three lists, not one, when there are three reasons: of the 40 columns with no reader,
16 are read by a library, 11 are write-only form attribution which is a legitimate
shape once said out loud, and 13 wait on a named task. Merging them would have made all
40 unarguable.

Exemptions rot in one direction that nothing catches on its own: an entry left behind
after its wiring landed is a hole, and a passing test looks identical either way. So
each list has a test that fails when an exemption outlives its reason.

## A gate nobody runs is not a gate

The most expensive failures here were not wrong code. They were correct code nobody
executed.

- CI triggered on `main` only, so 63 commits had never been built anywhere but the
  laptop that wrote them. What found the one that asserted the opposite of its own name
  on Linux was a release, at the publish step, after the tag was pushed.
- The platform's CI job named three test suites out of six. 315 tests existed, passed
  locally, and had never run anywhere else, among them the sweep that finds columns
  nothing reads and the only test proving a POST from the app reaches a daemon holding
  a socket.
- `format:check` was a CI step failing on 244 files, so it had been red since before
  anyone looked.

So: every gate runs in CI, and a test asserts that CI names it. Where CI cannot run on
every push, `pnpm verify` runs the same checks locally and the workflow says why.

## The obvious fix is sometimes worse than the problem

`findMany` with no `take` is a query whose cost is whatever the customer happens to
have. Adding `take: 50` to four of them would have been a bug, not a fix: `egressFor`
intersects three sets to decide which hosts a run may reach, so a short read can only
ever **remove** access, silently, from any customer with fifty-one connectors.

Before applying a rule, read what the code is for. The fix there was a ceiling that
refuses to truncate: fetch one row past the limit and fail on it.

## Do not export what nothing consumes

`ReadCeilingExceeded` was exported and nothing caught it by type. `designed-not-connected`
caught that within minutes of the code existing, and the answer was to stop exporting
it, not to write an exemption. Exports are a promise; a promise with no caller is
maintenance you pay for nothing.

## Verify in the conditions the gate will run in

A floor measured in cheap conditions is a floor CI cannot meet. Eleven suites in the
platform repository refuse to import without `DATABASE_URL`, which reads like a database
dependency and is not: they need the variable to exist, not a server to answer. Measured
with the placeholder URL the workflow already sets, all eleven run, and the API's
function coverage moves **down** from 66% to 63%, because loading more files adds
uncalled functions faster than called ones.

Similarly, push the branch and let CI go green before tagging a release. Two releases
were burned on failures a branch build would have caught, each leaving an orphan GitHub
Release to clean up.

## Say what was measured and what was not

Mark an estimate as an estimate. The platform CI was described as "about 32 minutes"
derived from declared timeouts, and it should not have been stated as though it had been
observed. Where a number is unverified, the file says so and says what would verify it,
the way `.github/rulesets/README.md` distinguishes the four check names confirmed
against a real run from the one that has never run.

Corrections go in the same place as the claim. A plan with a wrong number inside
produces a task built on it.

## The commit message carries the why

The diff already says what changed. What it cannot say is what was tried, what was
measured, what was rejected and why, and how the change was verified. Those are the
things the next reader needs and the only place they exist is here.
