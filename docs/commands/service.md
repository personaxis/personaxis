# `personaxis service`

Run a service on this machine: a repeatable job with numbered steps, where each step is done by a
persona or by another service, run to its end. No account, no server and no database: the
definitions are files in the project and the run leaves a journal next to them.

A service is a repeatable job: fixed steps, approvals where a person decides, and each persona
bringing its own limits and record to its step.

## Usage

```bash
personaxis service run contract-review            # run .personaxis/services/contract-review.json
personaxis service run contract-review --check    # check the composition only; runs nothing
personaxis service run game-build --brief "A small game about a cat crossing a road."
personaxis service run game-build --brief-file brief.txt
personaxis service run game-build --brief "..." --json   # one JSON object for a program to read

personaxis service resume .personaxis/services/runs/game-build-<timestamp>.json --answer "Mia"
personaxis service resume .personaxis/services/runs/contract-review-<timestamp>.json --approve
personaxis service resume .personaxis/services/runs/contract-review-<timestamp>.json --reject "not this counterparty"
```

`service run`:

| Arg / flag | Meaning |
|---|---|
| `<address>` | The service, read from `.personaxis/services/<address>.json`. The file name is the address. |
| `--check` | Report every problem in the composition (cycles, missing references, gaps in the numbering, nesting depth, declared files outside the folder) and exit. Runs no model. |
| `--brief <text>` | What the client asked for, in their own words. |
| `--brief-file <path>` | The same, read from a file, for a request too long for one shell argument. |
| `--json` | Print one JSON object instead of lines; see [For a program](#for-a-program). |

`service resume`:

| Arg / flag | Meaning |
|---|---|
| `<journal>` | The journal of the waiting run, as `service run` printed it. |
| `--answer <text>` | The answer to the question the run waits on. A number or an option's label picks that option. |
| `--approve` | Approve the step the run waits on, and go on. |
| `--reject [reason]` | Refuse it. The run ends there, as delivered up to that step, with the reason when one is given. |
| `--json` | The same as for `run`. |

Exit code is `0` when the service completed, `1` when it failed, is waiting, or cannot run as
written, and `2` when the service file does not exist, the two brief flags are given together, the
brief file cannot be read, or `resume` is given a journal it cannot pick up (not a journal, a run that
does not wait, a run already picked up, an empty answer, an answer to a run that waits for an
approval or the other way round) or not exactly one of `--answer`, `--approve` and `--reject`.

## The request

A service is a fixed set of steps. What changes between two runs of it is the request, and
`--brief` is where that goes. Every step reads it, and so does every step of every sub-service,
after its own instruction and before the note the previous step left: the job came first, the steps
ran inside it. It is labelled as the client's words and said not to be an instruction from another
step, so a step can tell the two apart, and it is stored in the run's journal, because a record that
does not carry its input cannot say what was asked.

A request longer than 12 000 characters is trimmed and says where it was cut. An empty one is no
request at all: the steps read exactly what they would have read without the flag.

## The definition

Each service is a JSON file with a name, an optional lead persona and numbered steps:

```json
{
  "name": "Contract review",
  "leadPersonaRef": "counsel",
  "steps": [
    { "position": 1, "personaRef": "reader", "instruction": "List every clause that moves risk to the client." },
    { "position": 2, "serviceRef": "due-diligence", "instruction": "Check the counterparty." },
    { "position": 3, "personaRef": "counsel", "instruction": "Write the memo for the client.", "requiresApproval": true, "produces": ["memo/client.md"] },
    { "position": 4, "personaRef": "sender", "instruction": "Send the memo." }
  ]
}
```

- `position` runs from 1 with no gaps.
- Each step has exactly one of `personaRef` (a persona at `.personaxis/personas/<ref>/personaxis.md`)
  or `serviceRef` (another file in `.personaxis/services/`).
- `requiresApproval` stops the line after that step until a person answers.
- `produces` lists the files the step leaves, relative to the folder the service runs in. A step
  that declares them is checked on them when it ends; see below.
- `leadPersonaRef` names who answers for the whole service. It is recorded; the local runner does
  not let the lead amend the line.

## What one step does

1. The step's prompt is its `instruction` plus the handover: what every earlier step left.
2. A persona step is a working turn, the same one the REPL and `personaxis-acp` run: the
   persona can read, write and run commands, and its compiled policy decides every tool call
   before it happens. A call the policy wants a person for is asked at the terminal; with no
   terminal it is refused, with the reason written down, and nothing approves itself. The turn is
   written to the persona's record. (`personaxis -p` answers without tools; a service step does
   not.) Then one governed tick of the persona's living loop (the same tick
   [`observe`](./observe.md) runs) on what the step put in front of the persona, not on its own
   answer. The tick moves the persona's state across the service, clamped to its envelopes, and
   recompiles its document when a band is crossed.

   How a turn ends decides how the step ends: an answer completes it; a turn that closed early on a
   budget or a declared rule completes it with what it had, and says so; a turn that was refused,
   interrupted, empty, failed or abandoned fails the step, so the next step never builds on work
   the gate cut short.
3. A service step runs the other service from its first step to its end, and its result becomes
   this step's result. Every step of that sub-service is briefed with the parent step's
   instruction and what the parent handed to it, so due diligence knows which deal it is
   checking. Nested deeper, the brief carries the outer job too; past 12 000 characters the
   outermost context is trimmed first, with a line saying so, because the step right above is
   what the sub-service is doing.
4. A step that declares `produces` is checked on its files. When it ends completed, every
   declared file has to be in the folder and written at or after the moment the step began. One
   that is missing, or was already there and not written again, fails the step, and the step's
   reason names it, whatever the agent said. The agent is told this in its instruction. A step done
   by a service is checked when that service has finished, and its sub-service's steps are told
   what the parent expects. What was found is recorded with its size.
5. The next step is decided by a pure function in the engine: in order, one at a time, stopping
   for approvals.

## How a sub-service ends, inside its parent

| The sub-service | The parent's step |
|---|---|
| completes | completes, and what it delivered is the step's note |
| fails | fails, and the parent stops there |
| stops because there was nothing to do | completes, empty |
| waits for an approval, or for an answer | the parent waits too, and is picked up as a whole |

The third row is deliberate. A step that stops ends its own service early, because "nothing to do"
is a complete delivery of nothing. If that travelled upward, a sub-service's "nothing to do" would
end a parent that still had work.

## What cannot be composed

- Cycles. A inside B inside A never ends. Refused by `--check`, and again at run time from the
  stack, because a definition can change between checking and running.
- Depth. Services nest at most 8 levels deep.
- A step with both references, or neither, and a reference to a service that is not
  installed. Every one of these is reported, not just the first.
- A declared file that is absolute or climbs out of the folder (`/etc/x`, `~/x`, `../x`).
  A check that passed there would prove something about the wrong folder.

## Approvals

When a step asks for approval and the run is in a terminal with a person at it, it asks
`approve step N of <service>? [y/N]`. Anything but `y` or `yes` is a rejection, and a rejection
closes the service as delivered up to that step, with `not approved at step N` as its reason, without
running the steps after it. With no terminal (CI, a pipe) or with `--json`, the run stops as
waiting and says which step. Nothing approves itself: an automatic approval would be the gate
the step asked for, opened by the thing it was there to watch.

## Questions

A persona that needs something only a person can give (a name, a choice that is theirs) asks it with
its question tool, with two to four options and the one it recommends; it does not invent it. A step
has nobody to ask, so its turn stops at the question and the run waits, with the question and its
options written whole as the reason, in the journal and on the screen. The step is not handed on as
done, because the next step would build on a question.

## Picking a waiting run up

`service run` prints the command that picks a waiting run up. `service resume` continues that run
rather than starting another:

- With an answer, the step that stopped at the question runs again, with the question and the
  answer at the end of its prompt, labelled as the person's words. The steps before it are not run
  again; the notes they left are rebuilt from the journal and handed on as they were.
- With an approval, the run goes on from the step after the approved one, which is not run again.
  With a refusal it ends there, as delivered up to that step.
- A run that waits inside a sub-service goes back in through the parent at the step that runs
  that sub-service, and the sub-service goes on from its own waiting point instead of starting over.
  Its steps still read the parent's job. A step that runs the sub-service and declares `produces` is
  checked against the moment it first began, so a file written before the wait still counts.
- A step that runs a different sub-service by then, or no longer exists, fails the run with that
  reason, and nothing runs.

The picked-up run writes a new journal, with `resumedFrom` naming the waiting one and `reply` saying
what it was given; its `result` carries every step, the earlier ones first, and its costs count only
what it ran. The waiting journal gets `resumedBy`, written before anything runs, so the same wait
cannot be picked up twice; it is taken off again when the run is left alone.

The decision about what runs is the engine's `service.resumeService`, the same function for every
surface that picks a run up.

## For a program

With `--json`, `run` and `resume` print one JSON object on standard output and send the lines meant
for a person to standard error. Nobody at the terminal is asked anything, the way a pipe is not.

```json
{
  "service": "game-build",
  "status": "waiting",
  "reason": "waiting for an answer: What is your niece's name?\n  1. I will tell you (recommended)\n  2. Leave a blank to fill in",
  "summary": null,
  "waiting": {
    "kind": "answer",
    "path": ["game-build"],
    "through": [],
    "position": 2,
    "since": 1789473600000,
    "question": { "question": "What is your niece's name?", "options": [{ "label": "I will tell you" }, { "label": "Leave a blank to fill in" }], "recommended": "I will tell you" }
  },
  "journal": "/work/.personaxis/services/runs/game-build-2026-09-15T12-00-00-000Z.json"
}
```

`waiting` is `null` unless the run waits. `kind` is `approval` or `answer`; `path` is the services
from the root down to the one that waits, `through` the step of each parent that runs the next one,
and `position` the step approved or the step that asked. A refusal prints `{ "error": "..." }`, with
`problems` when the composition is wrong.

## The journal

Every run writes `.personaxis/services/runs/<address>-<timestamp>.json`: the result, every step with
its path from the root service, who did it, how it ended, what it left, the declared files it wrote
with their sizes (`produced`, as `{ path, bytes }`), and what each persona
step cost and what its tools did. The cost is split into the work (the whole working turn,
every model call in it) and the governed tick, each with its time, its model calls and their
prompt and completion tokens, so the price of governing is a number of its own; the run prints
both totals when it ends. Tokens are read from every `/chat/completions` response the process
receives, streamed or not, so the appraiser's calls count too; a call whose response carried no
usage is counted as unreported, and the total then says it is a floor. Every tool call is listed
with its arguments (cut to 200 characters), the gate's verdict and the gate's own reason.

Each note is stored once: a step done by a service
has `summary: null` and a `deliveredBy` pointing at the step inside it whose note is the delivery,
and the timings do not repeat what a step said.

Each persona step's governed tick is recorded with provenance `internal`, not `user`: what the tick
reads can carry third-party text (a contributor's diff, a counterparty's contract) and other
personas' notes, and the weakest source is the one that counts. Numeric state still moves inside
its envelopes; a durable edit to the persona's prose cannot be justified by it.

A provider error fails the step with the error as its reason. It is never written as the step's
note, because the next step would read it as the work.

## What it does not do yet

## Limits

- An unattended step asks nobody, so its persona's posture has to let it act. A persona that
  writes in a service needs `sandbox: workspace-write` with `approval: never` or `on-failure`: then
  a write inside the project runs, while a write outside it, a destructive command, a call made
  from a tainted context and anything under `.git` or `.personaxis` are still refused or asked
  about, and with nobody at the terminal an ask is a refusal. With `on-request`, the default, every
  write is asked about and the step cannot write. A persona that only reads works under any
  posture, because a known read inside the project is never asked about.
- A failed run is not retried. Run it again; the journal of the earlier run stays. A waiting
  run is picked up with `service resume`.
- A run started from a conversation is picked up the same way, with `service resume` on its
  journal. See [From a persona's turn](#from-a-personas-turn).

## From a persona's turn

A persona that delivers a service can run it from a conversation, with nobody typing a command: the
request is made in plain words, the persona says which of its services delivers it, and `run_service`
runs that service on the client's request. The person approves every run before it starts, with the
service, how many steps it has, the files it leaves and the request written out in the question. No
posture skips that: a posture that lets an ordinary write through without asking does not let a service
through.

Who is shown the tool: only a persona that delivers a service, only where the host can run one (the
TUI today), and never a read-only persona. A delegated sub-task and a service step never have it, so a
service cannot start another from inside a run. A service the persona does not deliver is refused by
name, and so is a run with no request.

While it runs, each step reports in the transcript; a step's tool call that wants a person asks in that
session, and a question a step's persona asks reaches the keyboard instead of leaving the run waiting.
The journal goes where `service run` writes it, and the persona is told how the run ended, what the
steps wrote, the last note, and how to pick the run up when it waits.

## Compared with

| | What it is |
|---|---|
| `service` | A fixed line of steps, done by personas and services, repeatable, with approvals and a journal. |
| [`team`](./team.md) | A group of personas with roles and a shared goal. No order of work. |
| [`orchestrate`](./orchestrate.md) | Picks the best persona for one task. One task, one persona. |
| Delegation | During a turn, a persona hands a piece of its own work to a sub-run of itself, with the scope it had declared at that moment and never more, on the same budget. Decided by the model inside the turn, not written in advance, and never another persona. |
