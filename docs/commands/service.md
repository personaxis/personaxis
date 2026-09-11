# `personaxis service`

Run a **service** on this machine: a repeatable job with numbered steps, where each step is done
by a persona or by **another service**, run to its end. No account, no server and no database: the
definitions are files in the project and the run leaves a journal next to them.

A service is what a client pays for, because it is what gets delivered, and what makes it worth
paying for is that it runs the same way every time. The steps fix the order, the approvals fix where
a person decides, and each persona brings its own limits and record to its step.

## Usage

```bash
personaxis service run contract-review            # run .personaxis/services/contract-review.json
personaxis service run contract-review --check    # check the composition only; runs nothing
```

| Arg / flag | Meaning |
|---|---|
| `<address>` | The service, read from `.personaxis/services/<address>.json`. The file name is the address. |
| `--check` | Report every problem in the composition (cycles, missing references, gaps in the numbering, nesting depth, declared files outside the folder) and exit. Runs no model. |

Exit code is `0` when the service completed, `1` when it failed or is waiting for an approval, and
`2` when the service file does not exist.

## The definition

Same shape as a service template in the workspace, plus `serviceRef`:

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
- Each step has **exactly one** of `personaRef` (a persona at `.personaxis/personas/<ref>/personaxis.md`)
  or `serviceRef` (another file in `.personaxis/services/`).
- `requiresApproval` stops the line after that step until a person answers.
- `produces` lists the files the step leaves, relative to the folder the service runs in. A step
  that declares them is checked on them when it ends; see below.
- `leadPersonaRef` names who answers for the whole service. It is recorded; the local runner does
  not yet let the lead amend the line, which the workspace does.

## What one step does

1. The step's prompt is its `instruction` plus the handover: what every earlier step left, written
   by the same function the workspace uses, so a step reads the same note locally and in the cloud.
2. **A persona step** is a working turn, the same one the REPL and `personaxis-acp` run: the
   persona can read, write and run commands, and **its compiled policy decides every tool call
   before it happens**. A call the policy wants a person for is asked at the terminal; with no
   terminal it is refused, with the reason written down, and nothing approves itself. The turn is
   written to the persona's record. (This is NOT what `personaxis -p` gives: `-p` answers without
   tools.) Then one governed tick of the persona's living loop (the same tick
   [`observe`](./observe.md) runs) on what the step put in front of the persona, not on its own
   answer. The tick is what makes it a persona at work and not a document pasted into a prompt: its
   state moves across the service, clamped to its envelopes, and its compiled document is
   recompiled when a band is crossed.

   How a turn ends decides how the step ends: an answer completes it; a turn that closed early on a
   budget or a declared rule completes it with what it had, and says so; a turn that was refused,
   interrupted, empty, failed or abandoned fails the step, so the next step never builds on work
   the gate cut short.
3. **A service step** runs the other service from its first step to its end, and its result becomes
   this step's result. Every step of that sub-service is briefed with the parent step's
   instruction and what the parent handed to it, so due diligence knows which deal it is
   checking. Nested deeper, the brief carries the outer job too; past 12 000 characters the
   outermost context is trimmed first, with a line saying so, because the step right above is
   what the sub-service is doing.
4. **A step that declares `produces` is checked on its files.** When it ends completed, every
   declared file has to be in the folder and written at or after the moment the step began. One
   that is missing, or was already there and not written again, fails the step, and the step's
   reason names it, whatever the agent said. The agent is told this in its instruction. A step done
   by a service is checked when that service has finished, and its sub-service's steps are told
   what the parent expects. What was found is recorded with its size.
5. What decides the next step is the same pure function the workspace uses, moved into the engine
   unchanged: in order, one at a time, stopping for approvals.

## How a sub-service ends, inside its parent

| The sub-service | The parent's step |
|---|---|
| completes | completes, and what it delivered is the step's note |
| fails | fails, and the parent stops there |
| **stops because there was nothing to do** | **completes**, empty |
| waits for an approval | the parent waits too |

The third row is deliberate. A step that stops ends its own service early, because "nothing to do"
is a complete delivery of nothing. If that travelled upward, a sub-service's "nothing to do" would
end a parent that still had work.

## What cannot be composed

- **Cycles.** A inside B inside A never ends. Refused by `--check`, and again at run time from the
  stack, because a definition can change between checking and running.
- **Depth.** Services nest at most 8 levels deep.
- **A step with both references, or neither**, and **a reference to a service that is not
  installed.** Every one of these is reported, not just the first.
- **A declared file that is absolute or climbs out of the folder** (`/etc/x`, `~/x`, `../x`).
  A check that passed there would prove something about the wrong folder.

## Approvals

When a step asks for approval and the run is in a terminal with a person at it, it asks
`approve step N of <service>? [y/N]`. Anything but `y` or `yes` is a rejection, and a rejection
closes the service as delivered up to that step, with `not approved at step N` as its reason, without
running the steps after it. With no terminal (CI, a pipe), the run stops as
**waiting** and says which step. **Nothing approves itself**: an automatic approval would be the gate
the step asked for, opened by the thing it was there to watch.

## The journal

Every run writes `.personaxis/services/runs/<address>-<timestamp>.json`: the result, every step with
its path from the root service, who did it, how it ended, what it left, the declared files it wrote
with their sizes (`produced`, the same `{ path, bytes }` the workspace uses), and what each persona
step cost and what its tools did. The cost is split into the **work** (the whole working turn,
every model call in it) and the **governed tick**, each with its time, its model calls and their
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

Said so it is not assumed:

- **An unattended step asks nobody, so its persona's posture has to let it act.** A persona that
  writes in a service needs `sandbox: workspace-write` with `approval: never` or `on-failure`: then
  a write inside the project runs, while a write outside it, a destructive command, a call made
  from a tainted context and anything under `.git` or `.personaxis` are still refused or asked
  about, and with nobody at the terminal an ask is a refusal. With `on-request`, the default, every
  write is asked about and the step cannot write. A persona that only reads works under any
  posture, because a known read inside the project is never asked about.
- **A failed or waiting run is not resumed.** Run it again; the journal of the earlier run stays.
- **The workspace cannot hold a sub-service or a declared file yet.** Its steps are one persona
  each and declare nothing; `serviceRef` and `produces` exist here first. The workspace already
  names the files a step wrote, from its record, in the same `{ path, bytes }` shape.

## Not to be confused with

| | What it is |
|---|---|
| `service` | A fixed line of steps, done by personas and services, repeatable, with approvals and a journal. |
| [`team`](./team.md) | A group of personas with roles and a shared goal. No order of work. |
| [`orchestrate`](./orchestrate.md) | Picks the best persona for one task. One task, one persona. |
| Delegation | During a turn, a persona hands a piece of its own work to a sub-run of **itself**, with the scope it had declared at that moment and never more, on the same budget. Decided by the model inside the turn, not written in advance, and never another persona. |
