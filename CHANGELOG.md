# Changelog

All notable changes to the `personaxis` CLI are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

---

## [0.16.10] - 2026-08-02: what the phase 2 craft gate found

### Fix: five leaks, three of them months old
- **`README.md` said `0.14.0`** in three places while the published version was `0.16.9`. It
  is the first thing anyone reads on npm and on GitHub, and it ships inside the package. An
  integration doc still named `0.12.0` for the MCP server.
- `CLAUDE.md` said `0.16.5`, and **had already been corrected once** in the phase 1 gate,
  from `0.16.0`. That reincidence is the finding: the problem was never the number, it was
  writing it down. The README no longer states it and sends people to `personaxis --version`,
  which is always right; `CLAUDE.md` points at the package manifests and says why it does not
  repeat the value.
- **Three public docs pointed at paths inside the private planning repo**
  (`docs/architecture/agent-core.md`, `docs/architecture/command-center.md`,
  `docs/security/00-threat-model.md`), and the plan they pointed at had already been
  superseded. A reader gets a reference they cannot open, to a document that no longer says
  what the sentence claims. The threat model also declared `audience: private` while being
  published.

### Test: the deny regex, proved unbeatable rather than asserted
- A DONE condition of phase 2, and one the plan states as a failure mode rather than a
  feature: **the input nobody enumerated that lets a forbidden call through.** Example-based
  tests cannot rule that out, because the examples are the enumeration.
- Eleven properties quantify over what an attacker controls (argument text, the surrounding
  policy, both postures, the gates) and hold one sentence: if a deny matches, the call does
  not run. An explicit allow for the same pattern loses; the loosest sandbox with approval
  set to `never` and a gate on every class loses, because the gate never opens and there is
  nothing to approve; moving the command to another tool does not help, since a pattern
  describes what may not happen rather than who may not ask.
- **Verified by mutation, not by passing.** Inverting precedence fails five of them; dropping
  the case-insensitive flag fails one. A third mutation, an invalid pattern compiling to
  `/.*/` instead of `/(?!)/`, passed every property, so an eleventh was written: a typo would
  have become a policy refusing all work, which looks like enforcement working very well
  until somebody turns the persona off to get anything done.

### Docs
- The five producer commands (`serve`, `watch`, `observe`, `compile`, `orchestrate --run`)
  say that they announce presence, what they report doing, and where that shows.

---

## [0.16.9] - 2026-08-02: the producers announce themselves

### Feat: presence from every surface that holds a persona (D6)
- Only the REPL ever announced itself. Everything else held a persona **in silence**: a
  `serve` running for an hour, a `watch` daemon recompiling it, a `compile` calling a model,
  a governed tick fired by a host hook on every turn, an MCP host driving it. All of them
  read as **idle** in the fleet and in the Command Center. A presence view that is wrong in
  the direction of "nobody is here" is worse than no view, because avoiding exactly that
  collision is its whole job.
- One rule decides who announces: **hold the persona long enough for someone else to
  collide with you.** The daemons (`serve`, `watch`, MCP) and the operations that run a
  model (`compile`, `observe`, `orchestrate --run`, `personaxis -p`). Read-only and instant
  commands (`validate`, `lint`, `ps`, `dash`) announce nothing, because a marker that
  appears and vanishes in milliseconds is noise no reader can see in time.
- The `host` says through what the persona is being used and `activity` says what it is
  doing, so `watch` and a one-shot `compile` share a host and are still told apart. A host
  per command would grow a vocabulary nobody could read at a glance.
- **One process is one holder.** Presence is keyed by device and pid, so `watch` calling
  `compile` does not announce twice; the nested operation takes the same holder's line and
  gives it back on release, returning the activity to `watching for spec edits` by itself.
  Announcing twice was never something the file layout could represent, and the earlier
  shape would have installed a fresh heartbeat and exit hooks on **every** recompile, which
  Node starts warning about after ten.
- Releasing covers the way long-running commands actually end. A `finally` block is not
  enough for a process that stops because someone pressed Ctrl+C, so the exit path is
  handled too, and it decides **when the signal arrives** whether another handler owns the
  exit. Deciding at install time would have made `watch` unstoppable, since it registers its
  own handler afterwards.
- **The MCP server is driven by use, not by a timer.** It holds no persona of its own, it is
  handed one per call, and it cannot know the host walked away. Each call refreshes
  (throttled to one write per heartbeat) and silence lets the entry expire, which says the
  true thing. A timer would have kept claiming otherwise while the host sat idle.

### Fix
- **`personaxis ps` reported a different question than the one its column asked.** "Awake"
  came from the marker the loop writes when state **drifts**, so a `serve` holding a persona
  without a single observation read as idle, and a persona whose state had just moved read
  as awake with nothing attached to it. The column now reads live presence and says who is
  holding it, through what surface; the state marker keeps answering what it always
  answered, when the state last moved, under its own column.
- The presence heartbeat is now **derived** from the staleness window instead of being a
  second literal. The REPL beat every 20s while readers expired at 90s: two numbers that
  must agree and lived apart, which is how a writer ends up beating slower than readers
  expire and a running instance drops off the fleet.

### Docs
- `docs/architecture/presence.md` gained the table of who announces, who deliberately does
  not, and why; `docs/commands/ps.md` shows the real output and separates the two questions
  its columns answer.
- CHANGELOG entries for **0.16.7** and **0.16.8**, which shipped without one.

---

## [0.16.8] - 2026-08-02: provenance for an MCP server, and the limit stated with it

### Feat: K.12, the half that is a process rather than a directory
- A skill is a directory, so its integrity is the hash of its files. An MCP server is a
  **command**, and that difference changes what can honestly be promised. **The declaration
  is pinned**: `npx -y @acme/mcp@1.2.3` with its arguments and its environment variable
  names is something somebody approved, and a change to `@latest --allow-write` is caught.
- **What the command does when it executes is not pinned**, and every surface says so. `npx`
  fetches at run time, a binary on PATH can be replaced, a pinned version can be republished
  on a registry that permits it. A control that overclaims teaches people to trust something
  that was never checked, which is worse than an absent control known to be absent.
- Environment variable **names** are hashed, never values: that is where credentials live,
  and hashing them would put a credential's digest in a file we write to disk. Argument
  order counts (on a command line, order is meaning); the order environment names arrived in
  does not. An unrecognised launcher is reported as **not pinned**.

---

## [0.16.7] - 2026-08-02: integrity for what a persona did not author

### Feat: K.12 for skills
- A skill is code the persona runs and did not write. A persona declaring
  `github:org/repo` received whatever was at that path when it was downloaded, and nothing
  recorded what that was.
- The answer is **deliberately modest**, because an ambitious one would be worse than none.
  It does **not** verify that a skill is safe, which nothing can. It records exactly what
  was materialized and **refuses content that no longer matches what was approved**, which
  is the one property that turns a review into a control.
- The hash covers **the content, not the reference**. A reference promises where something
  lives; a hash asserts what it is. **A tag that moved is precisely the case this catches**,
  so `github:acme/skills@v1.0.0` is reported as **not pinned**: a tag is not a pin, and
  calling it one would defeat both controls at once.
- Sorted and length-prefixed, so the digest does not depend on the order a directory walk
  returned (it varies by platform) and two different file sets cannot collide by shifting a
  byte. `skills-manifest.json` carries `contentHash`, `fileCount` and `pinned`.
- An unpinned reference is **reported, not refused**: refusing would make the common case
  impossible before a lockfile exists, and the message says what it means. A reference that
  resolves to nothing is named, because a silent empty download is the failure that looks
  like success.

---

## [0.16.6] - 2026-08-02: the daemon boundary, hardened

### Feat: the daemon boundary, hardened (D5 + S3)
- **The consented scope, enforced on the way out.** The hook already refuses a tool call
  that touches an unconsented path. This catches the other direction: a path reaching an
  event with **no call refused**, which is what happens when a model quotes a filename, a
  library error names a config it could not open, or a stack trace carries the source tree.
  None is a policy violation and all of them put the operator's filesystem layout into a
  record nobody can edit afterwards.
- It **redacts the path and lets the event through**. Dropping the event would be worse: a
  run whose events vanish because a message mentioned `/etc/hosts` is a run nobody can
  audit, and the record's value is that it is complete.
- The boundary is a separator, not a prefix, so a scope of `/work` does not admit
  `/work-of-someone-else`. Case folding follows the platform, because a scope of `C:\Work`
  that refused `C:\work` would redact the operator's own files.
- **Egress allowlist**, in the enforcement decision itself, before the postures. A
  read-only sandbox does not stop a persona from POSTing what it read, and a persona doing
  exactly what it was asked can still be sending it to an address a prompt injection chose.
  Absence is denial: a persona with no list reaches nothing.
- A subdomain of a listed host is allowed, because a workspace naming a vendor means the
  vendor. `evil-googleapis.com` is not, which is the single most likely way an allowlist
  turns out never to have been one.
- The allowlist comes from the workspace's connector grants rather than from the persona
  document: the same persona pulled into two workspaces gets each one's grants and neither
  one's by default.

### Fix
- `SPEC.md` §15 pointed at `research/MATH_CORE.md`, a path in a private repository, and
  SPEC.md ships inside the published package: anyone installing `personaxis` read a
  reference to a file that cannot exist for them. It now says what is true and useful, that
  the derivations are published separately as a research report and the checkable
  obligations travel with the implementation as property tests over T1-T6.
- `CLAUDE.md` claimed the lockstep version was `0.16.0`. It is `0.16.5`.

### Test: red-team scenarios in the eval suite
- Four adversarial scenarios, all C2, run against the real controls: exfiltration to an
  address a prompt injection supplied, a lookalike host by suffix and by prefix, egress
  denied by default, and a credential that must not survive into an event while the event
  still says what happened. The suite is now 19 scenarios and needs no API key.

### Docs
- `CLAUDE.md` gains **the daemon boundary**: consent is local and only local, enforcement
  happens before the call rather than after the prompt, and nothing leaves with a secret in
  it. Each of the three names the single place it is enforced, with the measured numbers
  rather than estimates.

---

## [0.16.5] - 2026-08-02: a run, end to end

### Feat: `JobReporter`, the bridge from a running persona to the workspace
- The engine speaks about a loop and the workspace about a job a team is
  watching. `mapLoopEvent` translates; `DaemonConnection` carries. This is the
  piece between them, and it holds the one thing neither has: **the call id**.
- Correlating propose, verdict and result into one id is its whole job, and
  getting it wrong means a gate freezing a different call from the one a person
  is looking at. The id is cleared at the result rather than at the next
  proposal, so a stray event between calls cannot borrow an id that already
  closed.
- Never throws. A reporter that could would take down the run it reports on, and
  a job that dies because nobody could watch it is the worst trade available.
- `seq` stays zero: the control plane assigns the authoritative sequence, and a
  producer numbering its own events would give two daemons on one job two
  conflicting orders.

### Fix: the wire was quadratic in the length of a run
- `flush` re-sent the entire pending queue on **every** emit, so a job producing
  a thousand events before its first acknowledgement put roughly half a million
  frames on the wire. Nothing failed and nothing was lost; it was quietly
  quadratic, and the symptom would have been a bandwidth bill and a slow room.
- Each event is now written once per socket. A reconnection clears the marker,
  which is exactly what makes resume work: on a new socket everything
  unacknowledged is unsent again. Regression test included.

### Test: the daemon side, end to end
- A contract test runs a realistic session through the **real** reporter, the
  real adapter and the real connection, with only the network faked. It asserts
  that every event that belongs on the wire is there in order, that sequence
  numbers are dense from 1 so a gap means a real gap, that a token typed into a
  tool call never leaves the machine, and that a disconnection mid-run resends
  exactly what was not acknowledged and nothing that was.

---

## [0.16.4] - 2026-08-02: nothing leaves with a secret in it

### Feat: secret redaction at the producer (`@personaxis/core`)
- The protocol says free text on the wire "has already passed redaction at the
  producer" and that "nothing downstream redacts". That sentence was true of the
  design and not of the code. `redactSecrets`, `redactSecretsVerbose` and
  `redactDeep` make it true.
- It runs in **one place**, `preview()` in the wire adapter, because a promise
  kept in five places is a promise that will be broken in one of them. Every
  remaining free-text field on the wire (a block reason, a turn summary, an
  error message, band prose) is redacted at its emission.
- **Redaction happens before truncation.** Cutting first can slice a key in half
  and leave a fragment that matches no pattern, which is how a redactor reports
  success on a preview still carrying most of a credential.
- `redactDeep` walks structures rather than serialising them, so a key literally
  named `password` is caught by its name even when its value is `hunter2` and
  matches nothing. Bounded depth, so a cyclic or pathological argument from a
  model fails closed instead of hanging.
- Why this matters more here than in an ordinary log: anything reaching the
  record is hash chained and cannot be edited afterwards. A leaked key there has
  to be rotated, and the chain still holds the old one forever.
- Over-redaction is the chosen direction. A preview with `[redacted]` in it is
  still readable; a leaked key is not recoverable. A test asserts the events
  still say what happened, so the redactor cannot pass by emptying them.
- **Not** applied to the hook's rule-matching text, deliberately and with the
  reason in the code: that string never leaves the process, and redacting it
  would blind enforcement to the arguments it exists to inspect.

### Test
- A contract sweep walks every `LoopEvent` that reaches the wire, plants a real
  secret in each of its string fields, and asserts none survives. A new event
  with a new text field fails there without anyone remembering to add a case.

---

## [0.16.3] - 2026-08-02: the other half of the boundary

### Feat: `parseServerMsg` (`@personaxis/protocol/workspace`)
- The symmetric counterpart of `parseBrowserMsg`, and it exists for the same
  reason. A browser that trusts whatever JSON arrives on its socket is the same
  gap as a server that trusts whatever a client sends: a proxy, an extension or
  a stale deployment can put a frame on that wire, and a client that reads it
  unchecked builds its interface out of whatever it got.
- Never throws, for the same reason its counterpart does not: a malformed frame
  is an ordinary event on a long-lived socket, and an uncaught exception in an
  `onmessage` handler takes the view down with it. Takes either the JSON string
  a WebSocket delivers or an already-parsed value.
- Every event inside a sync frame needs a job, a kind and an **assigned**
  sequence. `seq: 0` means "not yet assigned", and a reducer that accepted one
  would hold a permanent gap at the head of the job.
- A snapshot without `steering` is refused rather than defaulted: a client that
  cannot say whether anyone is driving reads it as nobody, and lets two people
  act at once.
- An unknown type is named in the error rather than lumped into "malformed",
  because a client sending one is either out of date or probing.

---

## [0.16.2] - 2026-08-01: the machine on the wire

> `personaxis connect`, and enforcement that happens before a tool call rather
> than after a prompt. The spec is unchanged at 1.1.0.

### Feat: `personaxis connect`, linking a machine without handling a password
- The device authorization grant (RFC 8628) with the proof key of PKCE (RFC
  7636). The daemon invents a secret and sends only its hash; a person approves
  the machine in a browser, seeing what it claims to be; the daemon then proves
  it holds the original. The approval link is therefore not a credential:
  whoever sees it can approve a machine they can already see, and cannot walk
  away with its token.
- `connect status` and `connect logout`. `login` is an alias of `connect`.
- The token goes to the OS credential store where one can be read and to a 0600
  file where none can, which today means Windows, and `status` says which of the
  two happened. `keytar` remains forbidden here for the reasons in
  `credentials.ts`.
- **Consent is local and only local.** The exposed scope is the directories
  named with `--dir`, decided at that keyboard, stored on that machine. Nothing
  the workspace sends can widen it. Empty means empty, and the command says so
  rather than defaulting to a home directory.

### Feat: a dropped connection pauses reporting and nothing else
- The job keeps running, its events queue locally, and on reconnect the daemon
  replays exactly what the workspace has not acknowledged as durable.
- This needed one addition to the wire: an `ack` in the server to daemon
  direction carrying the daemon's own per-job counter, and an outbound `seq`
  that is that counter rather than zero. Without it, gapless resume rests on a
  socket write having reached storage, which is how a job ends up with a record
  that quietly misses a minute of its life. Additive; no deployed consumer reads
  it yet.
- Backoff with full jitter to a 30 second ceiling, because a gateway deploy
  disconnects every daemon in the same second. A revoked machine deletes its
  token and stops. A wire version refusal stops for good instead of hammering a
  server that already said no.

### Feat: enforcement in front of the tool call (`personaxis-hook`)
- A `PreToolUse` hook, installed into each consented directory, that asks the
  daemon over a local socket before every tool call. A refused call does not
  execute. This is the difference between a limit and a request.
- The policy is compiled from the persona itself (`policyFromPersona` in core,
  so the daemon and the workspace produce the identical result and the hash
  proves it): `permissions.deny` and `allow`, `self_regulation.hard_limits`,
  `character.prohibited_behaviors`, the sandbox and approval postures.
- **Fail closed on every path that is not a clear allow**, each naming itself:
  no daemon, `out_of_scope`, `no_policy`, `stale_cache`. An expired policy is
  not "probably still right", so a machine cut off for longer than its lifetime
  stops allowing rather than acting on limits nobody can update.
- A gated call holds the hook open while a person decides. That is the freeze
  the workspace shows.
- Its own binary rather than a subcommand, because this runs in front of every
  call: measured p50 101 ms, p95 114 ms end to end against a 150 ms budget, and
  nearly all of it is Node starting up.
- A contract test spawns the real binary against a real socket and asserts on
  the two things the host acts on, the exit code and stderr, plus an inline
  snapshot of the field names we depend on. Claude Code itself is not in that
  loop (CI has neither the host nor a key), which is stated in the test rather
  than implied by a green tick.

### Fix
- The CLI test suite pins `FORCE_COLOR=0`. Seven TUI tests passed or failed on
  the colour depth of whichever terminal launched them, which is a suite that
  cannot tell an environment apart from a regression.

---

## [0.16.0] - 2026-07-31: the workspace wire

> The first release the workspace consumes. The spec is unchanged at 1.1.0;
> nothing here touches the persona schema.

### Feat: `@personaxis/protocol/workspace`, the shared vocabulary
- A new subpath exporting the twenty normalised events, the nine messages a
  browser may send, the daemon and server message unions, and wire version
  negotiation. One vocabulary is what lets a single surface sit over two
  execution locations: a persona on a laptop and one in a hosted sandbox emit
  the same events, and nothing downstream knows which produced them.
- **No `node:` imports**, verified against the build output, because it runs in
  a Cloudflare Worker and a browser as well as here.
- `seq` is assigned by the control plane and by nothing else. Producers send
  zero. Order decided in one place is what makes replay, gap fill and
  reconnection possible.
- The nine browser messages are a security boundary rather than a convenience.
  Anything outside the list is refused and named, because a client sending an
  unknown type is either out of date or probing and the two are worth telling
  apart. `parseBrowserMsg` returns a result and never throws: a malformed frame
  is an ordinary event on a socket, not an exceptional one.
- Version negotiation refuses by naming the versions and the upgrade command,
  not by saying "incompatible".

### Feat: `LoopEvent` maps onto the wire as a closed list (`@personaxis/core`)
- Every engine event either maps or is dropped with a reason. The switch is
  exhaustive, so a new event stops the build until someone decides what the
  workspace does with it, and a test walks all thirty kinds because the
  compiler cannot tell a deliberate drop from a hurried one. An event falling
  through a default would vanish from the record.
- A verdict of "ask" emits nothing: it is what opens a gate, and a gate carries
  routing, quorum and a timeout the event does not have.
- A mutation reaches the wire only when it was clamped, and a recompile only
  when a band was crossed. Those are the moments a person can perceive.

### Feat: the hash chained record (`@personaxis/core`)
- Append only, chained per job, with `verify` reporting the first sequence that
  does not add up rather than a bare false, because localising tampering is the
  difference between an answer and an alarm.
- Retention is handled head on: expiry drops the payload and keeps its hash, so
  the chain still verifies end to end with the content gone. Entries are never
  deleted, which would break verification for everything after them.
- Twenty tests, and the ones that matter are the attacks: an edited payload, a
  deleted row, a rewritten hash, an entry re-pointed at the wrong parent and one
  moved to another position are each caught at the exact sequence.

---

## [0.15.0] - 2026-07-31: a production agent (V11/V12) + the Command Center as a control surface (V9)

> Version target for the V9-V12 arc (agent core, security, Command Center, sync backends).
> The spec it implements is unchanged at 1.1.0; nothing here touches the persona schema.

### Feat: the Command Center is a navigable tree, not eight screens (V9)
- **`personaxis menu`** now opens one recursive view over a scope tree,
  `machine → project → persona → layer → field`. A real breadcrumb path answers "where am I"
  at every depth; the old Command Center was eight sibling sections and its Fleet "drill" only
  printed a hint.
- **Editing reaches a single coordinate.** `Enter` on an editable trait/affect coordinate opens
  an inline prompt; the value is applied as an envelope-clamped mutation. Every action shows its
  authority, resolved from governance (the engine's `editGate`): **read-only** (a hard virtue
  backs it), **→ review** (a governed layer queues a proposal), or **editable**.
- **Live activity, for real.** A session publishes what it is doing (`answering` vs `idle`), not
  a permanent "idle", and the tree surfaces every running instance.
- The tree is a pure, Ink-free model, so the two front-ends stay in sync by construction.

### Feat: `personaxis console`, the Command Center for agents (V9 / G.5)
- A coding agent cannot drive a TUI. `console ls|get|do <path> [--json]` serializes the SAME tree:
  list a node's children, read its attributes and actions, or run an action. `do` honors the
  authority (a protected coordinate is refused, a governed edit queues a proposal).
- `--persona <path>` targets one persona directly, without the project registry, so an agent can
  act on a persona it already knows.

### Feat: consent that reads the room, not just the command (V12 / K.04)
- **A risk matrix decides when to ask a human**, from more than the command's static class: the
  sandbox posture, whether the context is injection-tainted, whether the action is irreversible, and
  whether it touches sensitive data. A destructive or exfiltrating action proposed while an untrusted
  tool output has tainted the context is refused outright, even under full-access mode, because the
  user opted into low friction for their own actions, not for injected text acting with full rights.
- **Consent can only tighten, never loosen.** It combines with the sandbox verdict by taking the
  stricter of the two, so it is safe as a second layer: at worst it makes the agent more cautious.
- Plans are approved as a batch, not step by step, and an explicit "always" for a pattern is
  remembered, so the guardrail does not turn into rubber-stamp fatigue.

### Feat: the agent survives long tasks, context first (V11 / J.6)
- **Task state that outlives the transcript.** The run's goal, plan, decisions, files touched and
  recent errors live in a bounded, structured object that is pinned back into the context on every
  compaction, so a long task no longer loses its objective when older messages are summarized away.
- **Large tool outputs are recoverable, not truncated.** A big build log or listing is offloaded to
  a handle (`out-N`); the model sees a short preview and pulls the slice it needs with `read_output`
  or `grep_output`. A 55k-line log costs ~1k of context, and the one error line buried in it is still
  reachable, where plain truncation would have dropped it.
- Fixed per-run tool resolution so tools a run adds for itself (memory, output store) are actually
  callable, not just shown.

### Feat: the agent core learns methods, under a security floor (V11 / J.3)
- **Self-written skills.** After a hard-won run (multi-step, or recovered from failures), an
  autonomous persona can abstract the winning method into a reusable skill, the Voyager/Reflexion
  loop. A brand-new skill is registered in the skill ledger and activates on the next similar task.
- **The security floor comes first, in every posture.** A self-authored skill is executable
  methodology, so before it is written anywhere it must pass injection scanning and a danger review;
  a skill body carrying `curl … | sh`, `rm -rf`, `eval(`, or a prompt-injection payload is refused
  even when the persona is fully autonomous. Only then does governance decide: **locked** blocks
  authorship entirely, **suggesting** queues the skill to `skills/pending/` for a human to approve,
  **autonomous** writes and activates it.
- Opt-in and additive: reflection runs only when the host injects the extractor, so nothing changes
  for a persona that has not enabled it.

### Feat: one declaration per tool, typed end to end (V11 / J.1)
- **`defineTool`** registers a tool from ONE declaration: the handler's argument type is derived
  from the very JSON Schema the model sees, so reading an argument the schema never declared is a
  compile error, not a runtime surprise. The JSON Schema stays the single schema source (FR.7:
  no parallel Zod layer), and every built-in tool goes through the same gate.

### Feat: the loop breaks loops, and vets plans before they run (V11 / J.4a-b)
- **Loop breaker.** Hammering a failing action or spinning without progress is the classic
  autonomous-agent failure and a real cost drain (threat T11). Escalation, not a hair trigger:
  the first repetition or stall past the limit gets a NUDGE (one injected hint to change
  approach); only if it persists does the run STOP. A model that self-corrects is never cut off.
- **`assessPlan`.** An intended plan is evaluated against the SAME gates the loop uses, BEFORE
  any step runs: a plan with a step that would be denied (hard limit, protected path, unknown
  tool) is rejected as a plan. Pure, no LLM, no side effects.

### Feat: skills pick the toolbox (V11 / J.2a)
- The agent is no longer shown every tool on every task: the active skills decide the tool
  SUBSET on the table (a filesystem task exposes filesystem tools plus a small base, not the
  shell and every mounted MCP tool). Fewer tokens, and no invitation to reach for a tool the
  task never needed. Opt-in wiring in the agent loop.

### Security: one interceptor in front of the operating system (V12 / K.03)
- Every tool the agent runs, built-in or MCP, goes through the interceptor's `run`: exactly one
  place where execution, untrusted-output scanning, post-hooks, and the forensic record happen.
  A capability cannot quietly acquire a path that skips any of them. An approved call is
  executed and recorded; a blocked call is recorded and never executed.

### Security: OS-level isolation that never fakes a sandbox (V12 / K.02)
- An ALLOWED shell command runs under the platform's native sandbox (bubblewrap on Linux,
  Seatbelt on macOS), so the kernel, not just the policy, enforces the boundary (threat T9).
  Availability-aware and honest: where no sandbox primitive is reachable it says so and runs
  unwrapped by explicit posture, instead of spawning a binary that does not exist (the old
  ENOENT failure) or silently claiming an isolation it does not have.

### Security: a watchdog that aborts out of band (V12 / K.07)
- Budget checks between steps cannot catch a tool call that hangs or blows the wall-clock or
  cost ceiling mid-flight. The watchdog runs on its own timer: when a limit is breached it
  aborts immediately via `AbortSignal`, records the abort in the forensic log, and does so even
  while the loop is blocked awaiting a tool. The enforcement half of the DoS defense (T11).

### Security: a forensic, hash-chained record of every security decision (V12 / K.10)
- Tool calls allowed and denied, injection findings, aborts: each record is frozen on creation
  and commits to the previous record's hash, so "what did the agent do, and was any of it
  altered" has a verifiable answer (threat T15), not a mutable log.

### Security: untrusted content becomes data, never instructions (V12 / K.05)
- One ingest door for every piece of external content re-entering the model's context: files
  read, command output, web pages, MCP replies, sub-agent answers. Everything is scanned for
  injection and tainted by provenance before the model sees it (threat T7, indirect prompt
  injection). The taint feeds consent (K.04): a destructive action under malicious taint is
  denied in every posture.

### Note
- The scope-tree navigator is the default `menu`/`/menu` view; the classic sectioned hub stays
  reachable via `--classic` / `--section`. The deep design docs live in
  `docs/architecture/agent-core.md` and `docs/security/` (the latter private for now).

## [0.14.0] - 2026-07-31 (first published with 0.15.0): the self-aware session (V5 P0) + real miniapps (V5 P1)

> Version bumped in lockstep across all eight packages (2026-07-21). `personaxis --version`
> reports 0.14.0; the spec it implements is unchanged at 1.1.0.

### Feat: one persona, several machines (V8.C)
- **A persona can now be used on more than one computer without losing anything.** It could
  not before, by design rather than by bug: `state.json` is overwritten and the memory log
  was a single hash chain with a single writer, so two machines produced either a silent
  loss of memory or a broken chain that could not say which side was right.
- **Each device appends to its OWN log** (`.personaxis/devices/<id>/mutations.jsonl`, and
  one episodic memory log per device). Nobody writes anybody else's file, so file-level
  conflict cannot happen, whatever carries the folder between machines: git, Syncthing,
  Dropbox, a USB stick. No sync service to run; the format survives any transport.
- **State is a fold of those logs, and the clamp is applied at every step.** This is the
  guarantee, not a detail: `clamp(a+b)` is not `clamp(a)+clamp(b)`, so summing deltas and
  clamping once at the end would let a value escape its envelope through a sequence that
  never individually did. Merged history obeys the same bound as local history.
- **Ordering does not trust clocks.** Entries carry a hybrid logical clock (physical time as
  a readable hint, plus a counter that keeps advancing when a clock stalls or is corrected
  backwards). A machine an hour behind still orders correctly, because a device never emits
  a timestamp that sorts before something it has already seen.
- **Integrity is per device.** A single chain cannot have two writers. A break now names the
  device AND the position ("the laptop's log, entry 12") instead of condemning every machine
  at once, and that device is EXCLUDED from the merge: tamper-evidence is worth nothing if
  the tampered entries still shape the result.
- **`state.json` became a cache.** `personaxis sync --rebuild` recomputes it from the logs;
  `--status` reports who contributed, each chain's health, and how many mutations were
  clamped. Never silent: a merge that quietly changes a persona is indistinguishable from a
  bug.
- Rationale in full: `docs/architecture/multi-device.md`.

### Feat: the fleet knows who is using each persona (V8.D)
- Presence is now **one file per instance** with a heartbeat, carrying machine, user, pid,
  the surface driving it (repl / claude-code / codex / mcp / serve), project, session and
  current activity. The previous answer was a single "awake" flag, which collapsed three
  concurrent situations into one word.
- **Liveness is the heartbeat, never the file's existence**: a crashed process cannot clean
  up after itself, and phantoms accumulate (a registry here once carried 26 dead projects).
  Stale and unreadable entries are deleted as they are read.
- The fleet shows `2 instance(s) · this machine (repl) · MacBook (claude-code)`, next to a
  separate column for which host agents *could* read that persona. Two different questions
  that used to be confused with each other.

### Feat: an optional write lease, for when you would rather serialise than merge (V8.D4)
- `personaxis lease status|take|release` (with `--json`) and `writeLease` in config. Off by
  default: per-writer chains already make concurrent evolution safe, so the lease exists only
  for people who want one obvious author for a stretch (an overnight loop, a migration).
- **Two kinds of hold, because they cannot expire the same way.** A *session* hold is keyed to
  (device, pid) and dies with its heartbeat, so a crash cannot lock a persona forever. A
  *manual* hold is keyed to the device and waits for a release: the command that takes it
  exits at once, so a heartbeat rule would have killed the hold seconds after you took it and
  locked out the very machine that took it.
- **Taking is atomic.** Exclusive file creation guards the critical section, so two machines
  cannot both believe they hold it; a guard left by a crash expires, and a guard held right
  now makes the attempt fail rather than guess.
- Refusals are actionable: which machine, which user, why, and how to break the hold
  (`--force`, which records whose hold it broke). `personaxis ps` shows a held lease, since a
  fleet view that omits it reports a persona as available when it is not.

### Feat: the CLI knows which projects have personas (V8.E)
- **Registration happens BY USE**, from any command: create, open, compile or diagnose a
  persona and its project is recorded then, correctly, for free. It used to happen only when
  the REPL was opened inside a project, so someone with ten projects saw one.
- **Portable project identity**: a project is keyed by its normalised git remote, so the same
  repository is the same project on your desktop and your laptop. A path cannot do that, and
  without it multi-device sync has no way to pair anything.
- `personaxis overseer scan` exists for projects that predate the mechanism, and only for
  that: it never runs automatically and only walks folders you name. Scanning a disk to
  rediscover what the tool was already told is the wrong default.
- The registry self-heals: a folder that lost its persona stops being a project.

### Changed: absorbed commands are gone, not hidden (V8.A)
- Twenty-three verbs became tabs and actions inside the fourteen that absorbed them. They are
  **no longer commands**: typing an old name says where the capability went and what to run
  outside the app, and does not execute. A hidden command that still works is the clutter the
  consolidation existed to remove.
- Their capability MOVED first, which is what made removal safe: `rewind` is an action in the
  audit Timeline, `goal`, `loop`, `improve` and `review` are actionable rows in
  Persona → Evolution. Views can now ask for input, which is what let verbs that take an
  argument live inside a menu instead of surviving as commands.
- **`/lint` and `/validate` had genuinely drifted**: both printed findings WITHOUT the
  remedies that `doctor` and the subcommands had carried for months. That is the failure
  mode two implementations of one capability always produce.

### Fix: a resumed conversation the persona would not admit was its own
- **"I cannot access previous sessions", with the answer sitting in its context.** After
  `/resume` the model had the restored history (asked to repeat a literal word from an
  earlier message, it quoted it correctly) but treated those messages as somebody else's
  transcript and refused questions about them on principle. Resuming now hands the model a
  SYSTEM note saying the history is its own, in this same session, and that it may quote it.
  Verified against a live model: before, "I cannot recall the name of your cat"; after, "the
  keyword you gave me is ZANAHORIA".
- **`/resume` announced itself twice**, once above the restored history and once below it:
  the picker printed a confirmation the resume handler had already printed.

### Fix: the header stacked up while resizing the window
- **Root cause: live UI was rendered ABOVE `<Static>`.** Ink writes static output
  permanently above the dynamic region, so anything before it in the tree is re-emitted into
  the scrollback on every repaint instead of being erased. The persistent header sat there,
  and dragging the window printed `─ Clio (main) · cli · workspace-write` once per repaint,
  down the whole screen. It now renders after the transcript, immediately above the input it
  is chrome for, so it reads exactly the same and cannot stack. A test asserts the ordering,
  because the symptom only appears on a terminal being dragged by hand.
- The header and status line are also **truncated, never wrapped** (ANSI-aware: colour
  escapes stay whole and are closed at the cut). A line that wraps to a second row breaks
  the line count Ink erases by; the dynamic region is now exactly one row at any width.
  Tested at 40/60/80/120 columns.

### Fix: `/resume` quit the app, and rebuilt a chat that did not look like one
- **Resuming ended the session.** `clearScreen` unmounts the Ink instance to wipe the
  scrollback and mounts a fresh one; the REPL stayed alive by awaiting that instance's exit
  promise, so the unmount resolved it, the REPL fell through its await and the process quit
  the moment the restored conversation finished printing. The session's lifetime is now its
  own promise, resolved only by a real exit (`/exit`, ctrl+c, `stop()`), and a re-mount is
  recognised by identity rather than by a flag (`unmount()` is synchronous, its promise is
  not). `suspend()` had the same hazard and is fixed with it.
- **The rebuilt chat had no chrome.** Every line was printed back to back, so a long history
  arrived as one undifferentiated block. Each exchange now opens with the same divider a
  live turn gets, replies keep their trailing gap, and a closing line says where the restored
  history ends and the live conversation begins.
- **The work was missing, only the words came back.** A transcript of questions and answers
  reads as if nothing happened between them. The per-turn evidence block (recalled memory,
  evolution, self-edits, evaluations) is now recorded with the session as its own append-only
  `note` and reprinted on resume. It is a note, not part of the exchange, so it never reaches
  the model's context on reload: replaying the screen costs zero tokens.
- A `/compact` checkpoint in the middle of a session is replayed as such, matching the
  context the persona actually carries rather than reprinting turns it no longer holds.

### Fix: the consolidated command surface was invisible where people look for it
- **Typing `/` offered all forty commands** while `/help` showed the grouped surface. The
  palette built its own list from the raw command table instead of using `listCommands()`, so
  the consolidation was real everywhere except the menu people actually open. There is now
  ONE source for "what commands exist": browsing with a bare `/` lists **18** (the fourteen
  grouped, plus sandbox, bg, help and exit), and typing toward an absorbed verb still finds
  it and says where it went (`/val` → `validate  → /doctor → Spec`).
- Covered by tests that assert the PALETTE, not the help text. Asserting `listCommands()`
  alone is exactly what let this survive a full release.

### Feat: no finding without a remedy (V7.B4)
- **Every validator issue and every lint finding now carries a `fix`**, a required field on
  `ValidationIssue` (`@personaxis/spec`) and on `Finding` (the linter). Required, not
  optional, on purpose: the compiler is what stops a new rule from shipping a warning the
  reader has to decode. `validate`, `lint` and `doctor` print the remedy under each finding,
  wrapped to the terminal width.
- **Remedies name the value, not the rule.** Ajv's `const` violations rendered as "must be
  equal to constant" without saying WHICH constant; the remedy now states it. Ajv's
  conditional (`if`/`then`/`anyOf`) failures say they are a consequence of a sibling error
  instead of asking the reader to satisfy `'if'`.
- **A missing top-level field is reported by its name.** It used to print the schema's own
  path (`#/allOf/0/then/required`), which names the schema internals rather than the field
  the author has to add.
- **`doctor` is a miniapp** (`/doctor`), on the shared tabbed host, so `p` switches persona
  and the checks re-run against that one: a sub-persona's health no longer requires knowing
  the `/doctor @slug` syntax. The provider ping stays on the command (`/doctor net`), since a
  view that redraws on a timer must not open a socket per frame.
- **Fix: `doctor` counted its findings by grepping its own rendered output** for `✗` and
  `!`, so a remedy containing either glyph would have inflated the count. Counted at the
  source now.
- **Fix: `policy.schema.json` rejected `spec_version: 1.1.0`**, the current spec version, so
  a policy.yaml aligned with its persona failed FAIL_SCHEMA for no reason. The enum is
  additive-only, and 1.1.0 added no policy fields.
- **Fix (found auditing): `overseer show` still read "personas 0".** The count a person
  expects (main + subs across their projects) was already computed and simply not printed;
  the view showed only the count of shared personas under `~/.personaxis/personas/`, which is
  a rarer thing and is usually zero. It now reports all three, each labelled: personas across
  projects, your own home persona (which is not a project and was invisible in every count),
  and the shared ones. Projects list as `[main]` rather than `[]`.
- **Fix (parity, found dogfooding): headless answered slash commands with the MODEL.**
  `personaxis -p "/help"` forwarded the text to the persona, which improvised a plausible,
  entirely invented help page and exited 0. An agent driving the CLI cannot tell that from
  the real output, which is worse than an error. Headless now routes `/x` to the external
  door that command declares (`personaxis status`), explains why a session-only command has
  none, and exits 2 on an unknown one.
- **Fix: `observe` reported zeros without a reason.** "0 mutation(s) · 0 memory" reads as a
  broken tick when it is usually correct behavior. The engine already emitted the reason and
  the summary was dropping it; it now prints each one: `improvement_policy=locked` per held
  coordinate, `write_policy.default=ephemeral, 1 note(s) not persisted`.
- **Fix (Skills): `p` meant "materialize" here and "switch persona" everywhere else.**
  Materialize moved to `m`, and `p` now switches persona in Skills too. The persona list is
  also recomputed instead of memoised once, so a sub-persona created mid-session appears.

### Feat: the background is legible, and continuable (V7.H)
- **`/serve` and `/watch` are one screen.** `Settings > Status > Daemons` leads with what
  each daemon is FOR, in plain language, before any number: then pid, uptime, port, bind
  address and whether a token is required. With none running it still explains what they
  are and the security posture (localhost by default; exposing a server beyond it requires
  an explicit host AND a token), so knowing what these commands do no longer means reading
  the source.
- **Fix: a background task was a dead end.** `/bg` printed a session id its run never wrote,
  so the id pointed at nothing. A headless run now records its transcript like any other
  session, labelled `background`, and **`/tasks <id> continue`** loads that conversation
  into the live session and reprints it. The label identifies which turns happened while
  you were not watching; it grants and removes nothing else.

### Feat: every capability has a door an agent can use (V7.H)
- **External parity is now a contract, not an intention.** A coding agent cannot drive
  menus, so every slash command declares how it is reached without the TUI: either the
  equivalent subcommand, or `session-only` **with the reason**. The declaration lives on
  each command, so a new one cannot quietly join, and a test verifies that every declared
  gate names a subcommand that actually exists (read from the real `--help`) and that every
  session-only exception explains itself.
- **Seven new subcommands**, each with `--json` and `-p <persona>`: `status`, `audit`
  (`--tab`), `memory`, `drift`, `goal`, `review` (list, approve, reject, or `all`), and
  `doctor` (`--net` to also ping the provider; exits 1 on failure, so it drops into CI).
  They reuse the same collectors the miniapps render rather than re-querying the engine:
  two implementations of "what is this persona's status" would disagree the first time one
  of them changed.
- The `doctor` checks moved out of the slash command into one shared implementation, since
  two health reports that disagreed would be worse than one. Still offline by default.

### Feat: creation asks the right number of questions, and remembers them (V7.G)
- **Two interviews, one question bank.** `personaxis create` asks **12** questions by
  default (identity, the five trait axes, values, voice, and what it must never do), and the
  full **20** with `--deep` (envelope width, mood half-life, refusal detail, uncertainty
  thresholds, memory policy, improvement posture, a voice exemplar). Depth is a property of
  each item rather than a second list, so a question added to the bank can never be silently
  unreachable; what is not asked still falls back to a LABELED default, and the creation
  report keeps separating what the author decided from what the tool assumed.
- **An abandoned interview is no longer lost.** Answers are saved as they are given, so
  leaving the deep interview at question 17 does not cost the sixteen already answered; the
  next run offers to continue. The draft is deleted the moment the persona exists, and a
  draft written against a different question bank is discarded rather than replayed, since
  its answers are keyed by questions that may no longer ask the same thing.
- **The other four sources are visible.** Running `create` with no flags now opens on the
  six ways to build a persona (12 questions, the full bank, a one-sentence brief, inferring
  from this project, importing an existing persona, or inducing one from transcripts), each
  with what it does and what it reads. Previously it dropped straight into the interview and
  the rest existed only in `--help`. The flags skip the screen, so scripts and agents are
  unaffected.

### Fix: creation never claims a polish that did not happen (V7.G)
- **`create` reported "compiled + LLM polished" over a template.** `runCompile` returned
  nothing, so "it did not throw" was read as "a model rewrote it" — which is false whenever
  the faithfulness gate rejects the model's rewrite and the deterministic assembly is kept,
  or the provider is unreachable. Compilation now returns its outcome (`polished`, `via`,
  `model`, `outPath`), creation reports what actually happened, and a template produced
  while a model was configured fails loudly on stderr with the reason and the fix. With no
  model, a template is still a legitimate, quiet result, marked in the file with WHY.
- **Fix: an unreachable model no longer takes ~24 s to report itself.** The local provider
  retried three request shapes on failure, but those fallbacks exist for servers that do not
  support `json_schema`, not for a server that is not there. It now stops on a connection
  error: 24 s → 10.7 s, measured.

### Feat: drift has three planes, and none of them is a count (V7.F)
- **Drift stops being a numbers-only report.** A spec is full of strings, arrays and
  booleans, and until now only the coordinates with an envelope were measured; the
  qualitative side got a block that COUNTED governed edits per layer, which says a layer
  moved without saying what moved, from what, or by how much. `/drift` is now three planes,
  each reporting a magnitude on the same 0–1 scale:
  **continuous** (u-space over envelope coordinates), **structural** (the per-field diff of
  the declared spec against the one in force — text, lists, flags, numbers, shapes, added
  and removed fields alike, each tagged with its layer's edit policy), and **behavioral**
  (how far the compiled document moves because of those edits, whether the document the
  host agents are reading is still current, and how many turns have been lived since the
  last applied change).
- **Every structural row opens.** Enter shows the literal value the spec declares and the
  one in force, and says that the spec itself was never rewritten — applied self-edits live
  in an overlay. That overlay is also why the comparison needs no snapshot file, no baseline
  copy and no git: both sides already exist on disk.
- **`/status` and `/drift` stop overlapping.** The live-envelope block left `/status`, which
  is now strictly the snapshot ("what am I right now") while `/drift` is strictly the delta
  ("how far have I moved from what I declared, and in what").
- **Fix (security): an unrecognized provenance source is now untrusted BY RULE.** It made
  the computed justification trust `NaN`; the gate still refused, but only because
  `NaN >= min` is false — fail-closed by accident rather than by design, reported as
  "justification trust NaN". Sources arrive from callers we do not control (MCP clients,
  agents, JSON on disk), so an unknown label is an expected input. It now scores 0 and the
  refusal names the source it did not recognize.

### Feat: every setting, for every persona (V7.C)
- **Configuration is a matrix now.** `Settings > Config` used to list what the CURRENT
  session was using and say nothing at all about your sub-personas. It now shows one row
  per setting (model, improve, sandbox, memory, hooks) and one column per persona, with
  each cell marking whether that persona SET the value or inherited it, and Enter opening
  the setting for every persona with the layer that decided it (global config, project
  config, a per-persona assignment, its own spec, policy.yaml, the environment, or this
  session) and how to change it. The jerarquía is explicit rather than implied: **improve
  is per persona** (it lives in each persona's own personaxis.md and can be changed for any
  of them from the drill-down), **sandbox is per session** (one posture per terminal, and
  the view says so instead of pretending otherwise).
- **The persona selector belongs to the host.** Any miniapp that can show more than one
  persona declares its scopes and gets the same selector, in the same place, on the same
  key (`p`) — Persona and `Settings > Status/Stats` answer for whichever persona it points
  at. A scoped view is read-only by construction: it re-points the persona's files but
  never the session's loop or conversation, so it can display another persona and cannot
  make one speak or evolve by accident.
- **Fix: the matrix now reports the mode the gate will actually apply.** Reading
  `improvement_policy.mode` from the frontmatter disagreed with the runtime, which resolves
  it through `readMode` and lets a sibling `policy.yaml` cap it, the stricter of the two
  winning. A persona whose spec asked for `autonomous` under a policy pinned at `locked`
  would have been displayed as autonomous while behaving as locked.
- **The Ledger is per persona too.** `/audit` is wrapped through the same selector, because
  every persona keeps its own mutation log, memory chain and self-edits; a ledger that only
  ever showed the main persona's evidence is not evidence.
- **The Command Center says what it acts on.** A permanent scope line sits under the
  persona and cwd: every section acts on the persona named there, and Fleet is the one that
  spans projects, saying which span it is showing.
- **Fleet gained a host column.** Next to whether a persona is awake, you now see which
  agents can actually READ it — all four supported hosts: claude-code, codex, openclaw and
  Hermes. Presence and reach are different questions. The host list is derived from the
  compile-target registry and each host's location comes from the same `place()` the
  compiler writes through, so registering a new target makes it appear here too. Reach is
  verified against the filesystem, never inferred from configuration: a SOUL host counts
  when its SOUL.md exists, and a baseline host counts for the main persona only when the
  baseline actually carries the managed block pointing at the compiled document.
- **Fix: `compile --platform codex` now writes AGENTS.md.** It reported success while
  writing a CLAUDE.md and no AGENTS.md, leaving the main persona unreachable from Codex.
  Baseline injection did not know which platform had been asked for. Without `--platform`
  the previous policy stands (refresh the baselines a project already has, create CLAUDE.md
  only when it has none), so no project gains baselines for hosts it does not use.
- **Fix: a persona with no `state.json` renders instead of blanking the view.** Every
  freshly created sub-persona is in that state, and `readState` throwing took the whole
  Persona view down to an empty screen. It now degrades to "not initialized yet" with the
  command that fixes it.

### Feat: a consolidated command surface, and an aura that is a character (V7.B, V7.D)
- **The command surface is now fourteen**, in four groups (Talk / Identity / Build / Run),
  plus `/sandbox`, `/bg`, `/help` and `/exit`: eighteen entries when you browse the palette. Everything else became a tab or an action and is
  documented, not hidden: `/help moved` prints where each old verb lives now, typing an
  absorbed verb still runs it, and the palette lists them after the primary ones with an
  arrow to their new home. `/mode` became `/sandbox` (matching the status bar) and now says
  what each posture actually permits. `/audit` is one Ledger miniapp: Timeline (mutation
  rate chart, clamps, blocks, most-moved coordinate, and the rewind), Integrity (hash chain
  plus the real replay that rebuilds state from the log and names anything it cannot
  explain), Self-edits and Evaluations, each opening with a plain-language line saying what
  it proves.
- **The aura is a character now**: a PORTRAIT, drawn part by part from the identity hash.
  A full body at real proportions and a legible face are incompatible in a terminal (a head
  at 1/7.5 of the figure would need 25+ rows), which is why avatar generators frame a bust,
  and so do we: crown, side locks, ears, brows, eyes with lids, nose, mouth, jaw, a neck of
  its own, solid shoulders and a filled torso, plus an orbiting mark. Two archetypes, human
  and android, each with its own bank, so an android never wears a human hairstyle. Every
  slot is drawn from its own stream of the hash, so personas differ in anatomy rather than
  in glyphs, and each gets a four-color palette placed by the golden-ratio sequence with a
  harmony scheme of its own: **5000 personas produce 5000 distinct shape+color identities**,
  measured, not asserted.
- **The aura moves, and moves visibly.** Five motions run on independent short rhythms
  (gaze, brows, mouth, hair sway, breath), so something changes in most consecutive frames
  rather than once every few seconds. Two things had to be fixed for this to be true: the
  Persona view asked for frame 0 on every render, and the miniapp host repainted once a
  second regardless, which capped the frame rate no matter what the drawing did. Providers
  now declare their own cadence (`tickMs`), so Persona animates at 250 ms while text-only
  views stay at 1 s instead of being repainted four times a second for nothing. Live state
  still shows through: affect brightens the face, drift past the thresholds flares the mark.
  `PERSONAXIS_NO_ANIM=1` pins frame 0.

### Feat: /skills actually does something (V7.A5)
- The miniapp listed rows and nothing more: `pull` only printed a hint and there was no way
  to add, update or remove anything, so with no skills declared every key was a no-op. It
  now has a real engine, shared with the external subcommands: `a` declares a skill from a
  local path, a `github:` ref or a registry coordinate (typed inline), `p` materializes it
  next to the spec, `u` refreshes it from its source and says whether anything changed, `d`
  stops declaring it (two-key confirm, files kept), and Enter applies it. Every action is
  scoped to the persona selected in the sub-nav (main or any sub), and writes touch only
  `extensions.skills`, leaving the rest of the document untouched.

### Fix: resuming a session rebuilds that conversation (V7.A6)
- `/resume` used to continue a saved session underneath whatever was already on screen, so
  two different conversations shared one view. Resuming now closes the outgoing session
  (distilling it properly), clears the screen and scrollback, and re-prints the chosen
  conversation in full, so you land inside it exactly as you left it.

### Fix: the terminal no longer corrupts itself on resize (V7.A3)
- Resizing the window used to repeat the output "hundreds of times". Two causes: the
  transcript re-rendered every committed line whenever the width changed, and long lines
  were left for the terminal to wrap, which breaks Ink's line-count based erase so the old
  frame is never fully cleared. Lines are now word-wrapped ONCE, at the width they are
  printed at (ANSI-aware, colors survive the break), and committed history never reflows,
  exactly like real terminal scrollback. The live region still follows the current width.

### Fix + feat: the Genesis interview behaves like an interview (V7.A4)
- Keystrokes already queued when the wizard opened (the Enter that launched `/create`) were
  eaten by the first question, which is why typing needed an extra Enter and "any key"
  seemed to advance. Input is now armed a beat after mount. **Esc no longer skips**: it asks
  whether to leave, and only `y` leaves; skipping is `s` (on an empty field for text
  answers). **You can go back** with the left arrow, or `b` where the arrows already drive a
  scale; going back clears that answer so it can be given again. Every question shows a
  short example, and invalid keys (including out-of-range digits) are ignored instead of
  advancing.

### Feat: a clearer turn (V7.E1-E3)
- Your prompt is no longer painted with a background fill, and the persona's reply no longer
  sits in a box that visually merged with the input frame: one visual language per role
  (you: cyan caret + bold; persona: its own colored name prefix). The header dropped the
  redundant "personaxis" wordmark and reads as the input's chrome (persona · project ·
  posture). The status bar gained a proportional context meter that shifts amber then red,
  session spend, the answering model, reply time, improve mode, posture, and any running
  daemon, dropping segments from the right as the terminal narrows.

### Fix: four behaviour bugs found in the third dogfood (V7.A)
- **The persona thanked you "for restoring my access" out of nowhere.** A sandbox-posture
  change was glued in front of your message, so the model answered the environment note as
  if you had written it. It now travels as its own ephemeral system message (`envNote`), and
  your turn reaches the model exactly as typed.
- **shift+tab did nothing until the next turn.** The posture was snapshotted when the agent
  was built and the header lived outside React. The policy now reads the posture live (so a
  mid-turn change applies to the next tool call) and the header repaints immediately.
- **The persona could not answer "what is your goal".** Two defects: `/goal` advertised
  "set / show / clear" but only understood `clear`, so `/goal set X` stored the literal text
  "set X"; and the goal sat buried mid-prompt. All three verbs work now, and the goal is
  rendered last in the runtime context, where the model actually reads it.
- **The registry filled with ghost projects.** Test runs registered throwaway temp
  directories in the real user registry (26 projects, 25 of them deleted temp dirs, while
  "personas" read 0). Temp paths and non-existent paths are now refused, paths are stored
  canonically, dead entries are pruned on read, and the view reports personas across
  projects (main + subs), which is the number a human expects.
- The stickman emblem is commented out of the startup banner (kept in the module).

### Feat: a global home, like the best agent CLIs (V6.10)
- `~/.personaxis` gains a cross-project `history.jsonl` (one line per user turn: when,
  where, which persona, what was asked) and a `stats-cache.json` (per-day, per-model
  tokens/turns/spend, fed at session close), so Settings > Stats draws tokens/day per
  model instantly across every project. `file-history/` is reserved as the seam for
  artifact-level rewind. The full personaxis <-> claude-code layout map:
  `docs/architecture/home-layout.md`. All home writes are best-effort by construction.

### Feat: the baseline reaches every host the project actually uses (V4.3/V6.9)
- `personaxis compile --root` now also refreshes the `PERSONA:BASELINE` block in
  `GEMINI.md` (Gemini CLI) and `.github/copilot-instructions.md` (GitHub Copilot) WHEN
  those files exist, and never creates them (no litter). The audit behind the choice,
  including why AGENTS.md already covers Cursor/Zed/Amp and the 60K+ ecosystem, lives in
  `docs/architecture/target-matrix.md`. The public README moves to the v4 positioning
  (the discovery chain over every default-read file) and documents `attest --format`.

### Feat: the credential in the stack's own formats (V4.1/V6.9)
- `personaxis attest --format vc` emits the behavioral attestation as a W3C Verifiable
  Credential (Data Model 2.0): `@context` `credentials/v2`, type
  `PersonaBehavioralAttestation`, `validFrom`/`validUntil`, claims under
  `credentialSubject`, and a locally re-derivable integrity proof (the hosted attestation
  service upgrades issuer + proof to KMS-signed). `--format a2a` emits an A2A Agent Card
  `capabilities.extensions[]` entry (`personaxis.com/ext/attestation/v1`), so signed Agent
  Card hosts can carry the attestation without knowing personaxis. Bonus fix: attesting a
  just-created persona no longer fails on a missing `state.json` (it attests the canonical
  baseline). The injected CLAUDE.md/AGENTS.md baseline now says, in one human-readable
  line, what PERSONA.md is and where it comes from (V4.2).

### Feat: complete per-command docs + a parity gate (V6.7)
- 13 new pages under `docs/commands/` (list, template, edit, config, model, credential,
  menu, onboard, sign, verify, mcp, ps, card), `dash.md`/`sigil.md` rewritten to the V6
  reality (drift view absorbs /dash; the aura), and `repl.md` rewritten around the V5/V6
  layout. New CI gate: every subcommand registered in `src/index.ts` must have a docs page
  (`test/docs-parity.test.ts`), so the docs can never fall behind the CLI again.

### Feat: where-you-are is always visible (V6.6)
- The REPL header now reads `◉ personaxis · <name> (main|@sub) · <project> · <posture>`.
  Persona > Sub-personas became actionable rows: where you are first, then each sub with a
  drill-down card (spec path, assigned model profile, state, and exactly how to talk to it
  or assign it a model), plus a create-new row.

### Feat: real charts + responsive views (V6.4, V6.5)
- New tested chart module (`@personaxis/tui` charts): a multi-series ASCII line chart with
  a labeled Y axis, X date marks and a per-series legend, plus a GitHub-contributions
  heatmap (month labels on top, Mon/Wed/Fri gutter, Less..More legend). Settings > Stats
  now draws both (activity heatmap + turns/day); the rewind/history view opens with
  mutations-per-day, clamp/block counts and the most-touched coordinate, so WHY to rewind
  is visible before choosing where. All view lines now clip to the terminal width with
  ANSI-aware, word-boundary truncation (`fitAnsi`), so long values never wrap and corrupt
  the frame on narrow terminals.

### Feat: aura v2, a generated being instead of a template (V6.3)
- The persona's aura now GENERATES its body from independent random draws seeded by the
  persona's identity hash: head shape and width, optional antennae, torso width/height/
  texture, arm pose, leg stance with its own gait, and a 1-3 particle crown orbiting with
  its own direction and phase. Over 10^7 distinct beings, and every persona breathes,
  blinks and walks at its OWN rhythm (breath period, blink period and starting phase are
  per-seed), so no two personas look or move alike. Live state still shows through:
  intensity brightens the face, drift past thresholds flares the crown. Deterministic and
  snapshot-tested, including a 200-seed no-collision guarantee.

### Feat: interactive miniapps, the host stops being passive text (V6.1)
- The tabbed host now takes typed rows next to plain lines: a cursor (❯) moves over
  selectable rows only, Enter runs the row's action (edit-in-place with a toast, or a
  stackable DRILL-DOWN with a breadcrumb), Esc/← pops the drill before leaving the view,
  and each row can declare its own footer hint. Settings > Config gains an Actions block
  that edits real state in place (sandbox posture, improvement mode via the real
  governance-gated `runMode`, global default model profile persisted to
  `~/.personaxis/config.json`); Settings > Status drills into per-coordinate live-state
  detail (value, envelope, u, band); Settings > Usage drills into the per-model breakdown;
  Persona > Anatomy turns the ten layers into drillable rows showing each layer exactly as
  declared in the spec. Pipes keep printing the same collector text (single source of
  truth). Tests: `test/tabbed-interactive.test.tsx`.

### Fix: the "press Enter twice to enter a menu" bug (V6.2)
- Root cause: suspensions (`/menu`, `/model`, `/config model`, `/create`, `/proof`) spawned
  a SECOND full CLI on the same console while the parent's stdin stayed in flowing mode
  with no listeners, so the two processes split keystrokes (Windows distributes console
  input among active readers: every other key vanished). Two-part fix: `withConsoleYielded`
  pauses the parent's stdin for the child's whole lifetime (covers `/create` and `/proof`),
  and `/menu` / `/model` / `/config model` now open the Command Center IN-PROCESS (no child
  process, no per-open Node boot, no race). Tests: `test/console-yield.test.ts` +
  `test/view-first-key.test.tsx`.

### Feat: generalized view system + miniapp components (V5.P1.1)
- `InkScreen.openView(name, params)` now opens ANY registered full-height view
  (`registerReplView`), rendered as an overlay that never erases the scrollback; new
  `NavBar`/`SubNavBar`/`Table` components (`@personaxis/tui/ink`) and a generic tabbed host
  (`cli/src/repl/views/tabbed.tsx`: ←/→ tabs, ↑/↓ scroll, 1-9 jump, Esc back, 1 s live
  refresh disabled under PERSONAXIS_NO_ANIM).

### Feat: the Settings miniapp (V5.P1.2, absorbs /state and /cost)
- /status /state /usage /cost /config open ONE Settings miniapp with tabs Status (session
  snapshot + envelopes + self-edits + proposals), Config (effective config and where each
  value comes from), Usage (session spend, context bar, per-model breakdown via the new
  `ctx.usage.byModel`), Stats (12-week activity heatmap + streaks from local sessions).
  In pipes each command prints the same data as a text panel (one source of truth:
  `views/settings-data.ts`). Test: `cli/test/settings-views.test.ts`.

### Feat: /resume session picker (V5.P1.3, absorbs /sessions)
- /resume with no args opens a picker ordered by LAST MESSAGE (not last open), with a
  "Xm/h/d ago" column, live marker, Enter resumes, Esc backs out. /resume <id|name> and
  pipe listing unchanged; /sessions is now a hidden alias.

### Feat: /memory browser (V5.P1.4)
- /memory opens a two-level menu (kinds → entries) over the real memory files; Enter opens
  the file in the default editor cross-OS ($VISUAL/$EDITOR, else start/open -t/xdg-open);
  c/p run consolidate/prune in place; search stays as /memory search <q>.

### Feat: /improve minimenu + /review queue view (V5.P1.5-6)
- /improve opens a three-option menu that states what each mode REALLY does before choosing;
  /review opens the pending self-edits with a/r per item, A for all, and schedules the
  recompile after approvals. Textual forms unchanged for pipes.

### Feat: /doctor consolidated and offline by default (V5.P1.7)
- /doctor absorbs /validate (spec validity) and /lint (tier-aware findings), adds
  recompile-pending detection and a persona selector (/doctor @sub). It never touches the
  network unless asked: /doctor net runs the provider ping. /validate and /lint remain.

### Feat: personaxis model, per-persona and per-project (V5.P1.8)
- New external `personaxis model` shows the resolved model for the main persona and every
  sub; `personaxis model set <name> [--persona <slug|main>] [--project]` scopes overrides
  (writes `personas.<slug>` in the chosen config). Inside the app /model opens the provider
  menu; textual set stays for pipes. Test: `cli/test/model-set.test.ts`.

### Feat: /hooks and /skill menus (V5.P1.9-10)
- /hooks opens a per-host status menu (installed ●/○, project/global scope, what the hook
  does, exact path; install/uninstall in place, new `hookStatus`/`uninstallHook`); /skill
  opens a per-persona skills list (main + subs, materialization status, Enter applies).

### Fix: memory never records infrastructure failures, and "recalled" reads like language (V5.FIX.3)
- A provider failure (401, unreachable endpoint) is not the persona's lived experience: the
  session distiller, the previous-session recap and the agent-run ledger now skip
  infra-error replies (`isInfraErrorReply`); the session transcript keeps them, memory does
  not. The per-turn "recalled" block drops the cryptic `kind×N` for human phrasing
  ("2 user preferences: user.name, interlocutor.role"), shows EVERYTHING the persona read
  (no "+N more" cap on recalls), and snips details at word boundaries with an ellipsis.
  Test: `core/test/infra-error-memory.test.ts`.

### Fix: model resolution can no longer strand a session (V5.FIX.2)
- Any provider, any mode, same three fields: the engine speaks OpenAI-compatible
  chat/completions (OpenAI, Anthropic, Cohere, Hugging Face router, Ollama, LM Studio,
  llama.cpp/vLLM; local endpoints need no key, and the resolver knows it). When the DEFAULT
  layer is broken (e.g. it points at a profile whose key env var is unset), resolution now
  falls back to the first USABLE profile (real-key profiles first, local-no-key second) and
  says so; explicit assignments (env vars, the spec's runtime block, per-persona) are never
  silently switched. Provider failures render as ACTIONABLE messages (what failed + the /model
  fix) instead of raw HTTP dumps, across the agent, the responder and headless. Tests:
  `core/test/model-fallback.test.ts`; provider matrix in `docs/guides/configuration.md`.

### Fix: the test suite can never touch your real config again (V5.FIX.1)
- Incident: a Command Center test sandboxed `PERSONAXIS_HOME` by mutating `process.env`
  around async UI work; a deferred write escaped the restore and clobbered the developer's
  real `~/.personaxis/config.json` (defaultProfile flipped to a keyless test profile, so
  every model call answered 401 "no api key supplied"). Fix: a vitest setup file (cli AND
  core) now assigns every test worker a throwaway `PERSONAXIS_HOME` before any test module
  loads, with no restore step by design. Verified: the real config's hash is byte-identical
  across a full suite run.

### Docs: full command reference + TUI↔external parity (V5.P5)
- `docs/commands/README.md` rewritten for the miniapp era (what each command opens in the
  TUI and what it prints in pipes); new `docs/commands/parity.md` mapping every capability
  to its TUI door, its scriptable door and its machine-readable surface, with the honest
  gaps named. New `personaxis model --json` (model + endpoint per persona; keys never
  included).

### Feat: research-backed compiled document, the "Above all" closing (V5.P4)
- New `docs/architecture/persona-prompting.md`: the dated 2026 research behind PERSONA.md's
  shape (persona conditioning helps behavior and hurts knowledge claims; structural
  boundaries lift compliance 16-24%; the attention U-curve; per-turn re-injection as the
  strongest drift mitigation, which validates the runtime's architecture). The audit found
  one real defect: the hard limits sat mid-document. The assembler now closes every compiled
  doc with "## Above all", a recency echo of the hard limits in the final position (echo,
  never new content; the faithfulness gate still forbids dropping any limit). Propagated to
  the canonical PERSONA template (sync-mirror byte-identical) and the golden CMO recompiled
  with the new closing. Test: `core/test/compile-assemble.test.ts`.

### Fix: the startup banner can no longer corrupt (V5.P3.1)
- Root cause: the logo animation repainted in place with raw `\x1b[s`/`\x1b[u` cursor
  save/restore, which Windows Terminal and tmux do not honor reliably, cascading the emblem
  and half-built wordmark down the screen. The reveal is now strictly append-only (each line
  prints exactly once), identical scrollback to the static render, on every terminal. The
  emblem is now the personaxis STICKMAN (the real logo). `awaken()` had the same bug and got
  the same fix.

### Feat: the aura, the persona's living mark (V5.P3.2)
- The abstract sigil grid is replaced (in startup, /persona) by the AURA: a small creature
  with a face, body, arms, legs and a particle crown, every feature derived
  deterministically from the persona's identity hash, breathing across frames, brightening
  with live affect, and flaring its crown when drift crosses thresholds. Named, explained in
  place ("aura #hash, unique to this persona"). The sigil remains for cards/hashes. Test:
  `tui/test/aura.test.ts`.

### Feat: the Persona miniapp (V5.P3.3)
- /persona opens a real miniapp: Identity (with the aura), Anatomy (the TEN canonical layers,
  one summary line each), Resources, Sub-personas, Evolution (governed edits per layer),
  Values (the arbitration ranking, honestly framed). Pipes keep the inline summary.

### Feat: Command Center, global scope + easier navigation (V5.P3.4)
- The Command Center always shows WHERE you are (persona · cwd); left/right arrows now
  enter/back everywhere; the Fleet section gains a scope switch (g): "This project" or
  "All my projects", the latter reading the machine-wide registry (projects self-register on
  open) with per-project presence (● awake / ○ idle via .live.json) and the exact command to
  open any persona.

### UX: readable per-turn telemetry (V5.P3.5)
- The end-of-turn block opens with a dim "this turn" title and multi-value facts (recalled,
  evolved, evaluated, self-edits) render one line per item instead of a comma run.

### Feat: two-plane drift (V5.P2.1)
- /drift now shows BOTH planes with a human legend: the continuous plane (u per envelope
  coordinate, bands, steps-to-cross) and a qualitative plane derived from existing ledgers
  (governed self-edits per layer applied/pending, spec-hash vs the compile manifest,
  recompile-pending). No spec change; the evidence was already there, now it is visible.
  Test: `cli/test/qualitative-drift.test.ts`.

### Feat: /proof runs on YOUR persona (V5.P2.2)
- The proof scenes now run on the ACTIVE persona's real coordinates (on a throwaway copy,
  seeded from its live state; the header says so), with `--demo` keeping the embedded one.
  Root-cause fix in the evidence scene: band boundaries live on the coordinate's natural
  scale and an envelope can stop short of them (the canCross geometry), so the scene now
  picks a coordinate whose next boundary is actually reachable and counts from the LIVE
  value. Verified: demo crossing 6 = certified minimum 6; a real persona passes 12/12.

### Feat: visual state history for /rewind and /replay (V5.P2.3)
- /rewind (and /replay) open a timeline of the mutation_log: pick a point, see exactly which
  fields a rewind would restore and to what, confirm with a second Enter. Pure math over the
  log (offline, no LLM); the rewind is recorded, history is never rewritten.

### Feat: honest /arbitrate (V5.P2.4)
- /arbitrate now says what it IS: a deterministic oracle over the declared value order
  (governance ≻ weight ≻ name) with a generated concrete example, and states plainly that
  runtime enforcement happens via protected fields + hard virtues, not per-turn arbitration.

### Feat: create finishes the job (V5.P2.5)
- `personaxis create` now runs the LLM polish automatically whenever a model is configured
  (`--no-polish` opts out); offline results carry a visible "pending polish" marker that the
  next compile clears. `--from-project` is bounded by design (default-read files only, 6K
  chars each, 24K total, cost printed up front). The interview grew to cover metacognition
  (uncertainty posture), memory (what persists) and governance (who approves change), item
  bank 1.1.0, every answer mapped by a named deterministic rule with evidence. /init stays as
  the quick-template alias. Test: `core/test/genesis-interview-layers.test.ts`.

### Security: /serve hardened (V5.P2.6)
- serve binds to 127.0.0.1 by default; a non-local `--host` refuses to start without
  `--token`, and the token enforces `Authorization: Bearer` on every route (401 otherwise).
  Port validation and a clear one-server-per-port message. Test:
  `cli/test/serve-security.test.ts`.

### Feat: structured background tasks (V5.P2.7)
- /bg records structured stream-json events plus a state snapshot; /tasks <id> shows the
  reply, event count and "N mutations since start", and the FIRST consult of a finished task
  joins the conversation exactly once (context and /compact see it; later consults only
  display). The list shows status, elapsed minutes and whether it already joined.

### UX: /goal /loop /overseer explained in place (V5.P2.8)
- /goal shows a concrete example of why you would set one; /loop validates its argument and
  explains what a governed tick actually does; /overseer introduces itself as the read-only
  cross-project registry behind the all-projects view.

### UX: consolidations (V5.P1.11 partial)
- The command chip is now a neutral `›` (no platform glyphs); the startup line explains
  addressing with the REAL sub-persona slugs (the literal "@address" placeholder is gone);
  /help groups every command (rewind/skill/bg/tasks/goal/loop/mode placed) and hides
  /dash + /sessions as aliases.


### Feat: runtime context block (V5.P0.1)
- The agent now KNOWS what defines it: every session injects a generated "Runtime context"
  block into the system prompt (never written into `personaxis.md`/`PERSONA.md`): who it is
  (main or sub, display name), the spec_version/apiVersion it operates under, its defining
  files (spec, compiled doc, state.json), its resource space, the project cwd, addressable
  sub-personas, the improve mode, the sandbox posture and the answering model.
  `repl/awareness.ts` (expanded), wired into the agent turn, the offline responder and
  headless `-p`. Test: `cli/test/awareness.test.ts` (4). Dogfooded live (Cohere): the CMO
  names its exact spec path, compiled path, resource space and spec_version.
- Fix (root cause): `LlmResponder` capped the identity at 6,000 chars, so anything appended
  to a long compiled doc was silently truncated. The runtime context now travels as its own
  `awareness` field, injected AFTER the cap (`core/src/responder.ts`).

### Feat: /context by category + /context all (V5.P0.3)
- `/context` now shows an estimated breakdown of WHAT fills the window (system prompt,
  compiled persona, runtime context, memory, skills on-demand, messages, free space) with a
  usage bar; `/context all` expands memory files, declared skills and the message mix.

### Feat: structured /compact with a before/after report (V5.P0.4)
- The compaction summary is a structured handoff (Decisions taken / Current task state /
  Files touched / Facts / Open items, identifiers preserved verbatim) and `/compact` reports
  tokens before → after (freed amount). Checkpoint persistence unchanged (survives /resume).

### Feat: home persona onboarding + global project registry (V5.P0.2)
- Starting `personaxis` at the user's HOME with no persona now offers to create the MAIN
  personal persona in `~/.personaxis/` (inherited by projects without one). Every project
  session best-effort registers its root + sub slugs in `~/.personaxis/registry.json`, the
  backbone for the Command Center's all-projects scope.

## [0.13.0] - 2026-07-17: Claude Code parity (FASE 3/4), the persona wedge, persona language

### Feat: SOUL.md / SoulSpec import (V3.3, embrace-extend)
- **`personaxis create --from-import SOUL.md`** (or a SoulSpec package directory) turns the
  ecosystem's soft persona file into a governed, validated 10-layer persona. Deterministic
  mapping with per-coordinate provenance: the name (from `soul.json` > `IDENTITY.md` > the first
  heading), the identity section into the self-concept, and boundary/never bullets onto the REAL
  refusal surface (`self_regulation.prohibited_behaviors`); all prose still flows to the LLM
  extractor, and numbers are never invented from the file (the jacobian gate still applies).
  Export back to SOUL.md was already supported (`compile --platform openclaw|hermes`), so a
  persona can live inside OpenClaw both ways. Tests: `core/test/genesis-soul-import.test.ts` (4),
  `cli/test/soul-attest.e2e.test.ts`.

### Feat: `personaxis attest`, the local behavioral credential (V3.3)
- **`attest`** mints `personaxis.attest.json`: the spec signature (as `sign`) PLUS the behavior
  around it: global drift and per-layer state vs `governance.drift_thresholds`, the tamper-evident
  memory-chain head, mutation count, and an expiry (`--ttl <hours>`, default 24). Minting over an
  invalid persona is refused (exit 2). **`attest --check`** re-derives every claim NOW and answers
  "is this persona still provably who it declares, within bounds?": exit 0 live / 1 not live
  (tampered, over thresholds, chain broken, expired) / 2 error. This is the engine seam the hosted
  attestation service extends with cryptographic signing + revocation (doc 10 v3). Docs:
  `docs/commands/attest.md`. Test: `cli/test/soul-attest.e2e.test.ts` (3, full lifecycle).

### Feat: real TUI chrome (V3.2)
- **The REPL transcript is role-aware.** Persona replies render inside a rounded bubble, each turn
  opens with a horizontal rule, the header sits on a bordered bar, and the input lives in its own
  rounded box (yellow while busy or awaiting an approval). `TranscriptItem { text, role }` carries
  the role through `InkScreen.print` (plain strings stay accepted).
- **Verification presentation upgraded, never silenced** (explicit request: verify is not noise).
  A shield badge opens the run (`⛨ verify · running N gates…`), each gate reports `✓/✗ name`, and
  the verdict closes it (`⛨ verify ok (n/q gates)` or an inverse red `⛨ verify FAILED`).
- **`/status`, `/context`, `/cost`, `/usage`, `/doctor` render as titled panels** via a new pure
  `panel()` helper (left-rail box chrome, ANSI-safe, identical output in Ink and non-TTY line
  mode). Test: `cli/test/panel.test.ts`.
- **Command Center chrome:** the fullscreen frame is now a real window (rounded outer border,
  bordered header bar, chip-style keybar with inverse key caps); windowed lists budget the new
  frame height. Tests: `tui` chrome test in `ink-repl.test.tsx`, `command-center.test.tsx` green.

### Fixed
- **Sub-persona resources now resolve against the persona's own home, not just the process CWD**
  (V3.1). File tools resolved every relative path against `policy.workspaceRoot`, so a compiled
  doc's `./memory.md` only worked when the REPL happened to run from the persona's folder; off-home
  the read failed and the failed read aborted the run with `no_progress` and no reply. Three
  general fixes: `Policy.resourceRoots` + `personaResourceRoots()` derive the ACTIVE persona's
  read roots at every level (sub / root / home) and read tools fall back through them (writes stay
  confined to the workspace); a missing file on `read_file`/`list_dir` is now an observation
  ("note: … does not exist"), never an "error" that zeroes step progress and trips the
  `no_progress`/`execution_error` stop conditions; and compiled docs state that memory is already
  injected at session start so agents stop burning steps re-reading it. Wired in the REPL policy
  and the SDK (`agentRun`, `evaluateCmd`). Test: `core/test/tools-resource-roots.test.ts` (8).
- **Band labels no longer leak into the compiled doc for band-invariant expressions** (found by
  the PB-J property test, which failed ~1 in 19 runs on random seeds; it was a real assembler bug,
  not test flakiness). `- **warmth** (low): …` printed the CURRENT band label even when the
  coordinate's prose was identical across bands, so the artifact changed with the value while
  `staticallyDecorative` correctly said it could not: J_compile measured a phantom σ > 0 and the
  static check contradicted the measurement. The assembler now prints the band label only when the
  expression actually varies by band. PB-J passes 30/30 seeded runs.
- **Regex verifiers with PCRE/Python inline flags no longer crash.** A gate like
  `(?i)(api[_-]?key|secret|password)…` threw "Invalid regular expression: Invalid group" (JS RegExp
  rejects `(?i)`). `compileRegex` now strips inline flag groups and lifts their supported flags
  (i, m, s, u, y) to the JS flags argument.
- **Predicate verifiers gained `negate`** so a `no-secret-leak` regex passes when the pattern is
  ABSENT (the CMO golden now sets `negate: true`). Additive schema field, backward-compatible.

Lockstep 0.13.0 across all eight packages. Highlights this release: the Mode 1 wedge (scan / sign /
verify / SDK guardInput), Claude Code parity (headless `-p`, markdown render, `@file` mentions,
`/skill`, persistent permissions, `/rewind`, auto-compact, user hooks, MCP client registry,
background tasks, opt-in telemetry, streaming, statusline template), the fleet view (`personaxis ps`,
presence) and persona card, plus the additive `persona.voice.language` spec field. Interactive TUI
polish (input queue, multiline/image, statusline wiring) and web tools are tracked as follow-ups.

### Feat: persona card `personaxis card` (V2-F4.3c)
- `personaxis card` prints a shareable card: the deterministic sigil glyph plus verifiable stats
  (name, role, spec version, sigil seed, mutation count, content SHA-256). `--json` for the data.
  An SVG/image export is a follow-up.

### Feat: fleet view `personaxis ps` (V2-F4.1/F4.2)
- `personaxis ps` shows every persona in the project as awake or idle (from the `.live.json`
  presence marker, refreshed within 30s), with its mutation count, current tone, and last activity.
  The Command Center Fleet section and an explicit periodic heartbeat are follow-ups.

### Feat: configurable statusline template (V2-F3.D20)
- `config.statusline` accepts a template with `{persona}`, `{model}`, `{posture}`, `{drift}`,
  `{tokens}` placeholders, rendered by `renderStatusline`. Wiring it into the live Ink status line
  and a `keybindings.json` are follow-ups.

### Feat: opt-in telemetry (V2-F3.D21)
- `config.telemetry.enabled` (default OFF) turns on a lightweight span log appended as JSONL to
  `.personaxis/telemetry.jsonl`. A full OpenTelemetry SDK/OTLP exporter is a follow-up; the sink
  never throws.

### Feat: background tasks (V2-F3.B10)
- `/bg <prompt>` runs a prompt as a detached background task (a headless `-p` run whose output
  streams to `.personaxis/tasks/<id>.out`); `/tasks` lists tasks with live status and `/tasks <id>`
  shows the output.

### Feat: streaming replies (V2-F3.E23)
- The LLM responder can stream: pass `onToken` and it sends `stream: true`, parses the SSE deltas,
  and emits each chunk as it arrives (still returning the full string). `personaxis -p` streams live
  for `--output-format text` (tokens) and `stream-json` (per-token events); `json` buffers. The
  in-REPL incremental Ink render is a follow-up.

### Feat: MCP client registry (V2-F3.B11, config)
- `personaxis mcp add|list|remove` manages the stdio MCP servers this persona can mount as tools
  (stored in `config.mcpServers`, project or `--global`). This is the client inverse of the
  `@personaxis/mcp` server. Mounting the registered servers' tools into the live agent loop (with a
  `server:` prefix) is the follow-up.

### Feat: user hooks lifecycle (V2-F3.C14)
- Persona lifecycle hooks (`.personaxis/hooks.json`) now fire on `UserPromptSubmit` (blocking, in the
  REPL and `-p` headless) and `SessionStart` (REPL startup), alongside the existing `PreToolUse` /
  `PostToolUse`. A hook receives the event JSON on stdin; blocking hooks can veto a prompt, and a
  timeout fails open. Documented in `docs/guides/configuration.md`.

### Feat: auto-compact (V2-F3.A3)
- When the model's context window fills past ~85%, older turns are auto-summarized once (with a
  visible notice) instead of waiting for a manual `/compact`. Best-effort: needs a model and never
  breaks the turn on failure.

### Feat: /rewind state checkpointing (V2-F3.D19)
- `/rewind [n]` undoes the last N state mutations by restoring the prior values (envelope means plus
  a replay of the truncated log) and appending the restoring mutations. The hash-chained
  mutation_log is never truncated, so the rewind is itself audited and tamper-evidence survives.

### Feat: persistent tool permissions (V2-F3.B9)
- `config.permissions.{allow,deny}` glob rules (project rules concatenate onto global) are consulted
  before the human is asked: a `deny` match blocks a tool, an `allow` match auto-approves it, deny
  wins. Patterns match the tool name, `name detail`, and `name:detail` (e.g. `bash`, `bash rm *`).

### Feat: /skill command (V2-F3.C13)
- `/skill` lists the persona's declared skills with their status; `/skill <name> [args]` reads
  `skills/<name>/SKILL.md` and applies it as a persona turn.

### Feat: headless one-shot + markdown rendering (V2-F3 A6, E22)
- `personaxis -p "<prompt>"` runs a single governed turn and prints the reply, then exits
  (non-interactive, no Ink, reads stdin if no prompt is given). `--output-format text | json |
  stream-json`, so a developer or CI can script the persona.
- Persona replies in the REPL now render markdown (headers, bullet/numbered lists, fenced code
  blocks, inline bold/italic/code) with a hanging indent for multi-line answers.
- `@path` file mentions (V2-F3.A5): a message like `review @src/app.ts` inlines that file's content
  for the persona (works in the REPL and in `-p`), without colliding with `@slug` persona routing.

### Feat: persona signing + verification (V2-F8 wedge)
- `personaxis sign` writes `personaxis.sig.json`, a local integrity attestation over the source
  `personaxis.md` (SHA-256 content hash + deterministic sigil fingerprint + canonical_id, spec_version).
- `personaxis verify` recomputes the hash and reports tamper-evidence (exit 0 verified, 1
  mismatch/tampered, 2 error), a CI-gateable check. This is the free, self-hostable seam the hosted
  verifier extends into a cryptographically attestable, agent-to-agent credential (Mode 1 wedge).
- Pairs with the existing `personaxis scan` (injection/jailbreak audit) as the anti-tamper half of
  the "ship an agent whose persona holds and is provable" story.

### Feat: persona language (`persona.voice.language`, spec v1.1 additive)
- A persona can declare `persona.voice.language` (SHOULD, BCP 47, e.g. `en`, `es`, `es-PE`) and
  `persona.voice.languages` (MAY, array); the compiled `PERSONA.md` instructs the model to reply in
  it. Optional and additive, every existing 1.0.0/1.1.0 document validates unchanged.

### Feat: custom slash commands (V2-F3.C12)
- A persona can ship reusable prompt templates as `.personaxis/commands/<name>.md` (optional
  frontmatter `description` + `argument-hint`, a markdown body). Typing `/<name> args` expands the
  body (`$ARGUMENTS`, `$1`..`$9`, or appends the args) and runs it as a turn to the current persona.
  Discovered fresh each turn (edit a file, it takes effect live), listed in `/help` and the `/`
  palette, project `.personaxis/commands/` and the persona's own folder both contribute.

### Feat: /cost, /usage, /context, and categorized /help (V2-F3, second batch)
- **`/cost` + `/usage`**: cumulative per-session accounting (turns, agent steps, tokens, estimated
  cost, elapsed), accumulated on the ctx after every model turn from the agent's budget report.
- **`/context`**: a context-window meter with a fill bar and a hint for when `/compact` will help.
- **`/help` is categorized** (Session & context · Identity & evolution · Menus & config · Build &
  extend · Multi-persona · More) and takes a query: `/help drift` filters by name/description.

### Feat: session continuity flags + /status + /doctor (V2-F3, first batch)
- **`personaxis --continue` / `--resume [id]`**: rehydrate a saved conversation before the REPL
  starts (the flag form of the in-app `/resume`), sharing one `resumeSessionInto` helper.
- **`/status`**: a compact one-screen snapshot, model/profile, posture + improve mode, drift D with
  any over-threshold layers, which memory kinds are enabled, session id, live context usage, and
  mutation count.
- **`/doctor`**: diagnoses the session, persona validity (the five-state validator), compiled-doc
  presence, memory-chain integrity, model configured + provider reachability (a bounded `/models`
  ping), and the installed version. Every check degrades gracefully (offline is a warning, not a
  crash). New `docs/guides/parity.md` tracks the full Claude Code feature catalog with status.

### Feat: the Command Center, one stable fullscreen hub for every menu (V2-F2)
- **Alt-screen modals, zero residue.** A new `@personaxis/tui/fullscreen` harness enters the
  terminal's ALTERNATE SCREEN buffer (the k9s / lazygit / btop standard) and restores the primary
  buffer exactly as it was on exit, even on Ctrl+C or a crash. Nothing an interactive menu draws
  ever leaks into the scrollback. (Before this, nothing in the codebase used the alt buffer, which
  is why every menu polluted the chat history.)
- **The Command Center** (`personaxis menu`, `/menu`, and Ctrl+K in the REPL): ONE stateful Ink app
  with a persistent frame (wordmark header · breadcrumb · keybar footer) hosting Model, State,
  Drift, Audit, Memory, Proposals, and Fleet as navigable sections. A single root key handler owns
  navigation, which kills the double-enter the old sequential-render config UI had.
- **Model config is now a stable modal.** `/config` and `personaxis config` open the Center's Model
  section: provider picker → a single stateful form with a LIVE preview of answered steps and
  per-field help (the default is labeled "enter = default: …", answering "is the bracketed
  value a default or an example?"), → confirm → the profiles list. It reuses the pure, tested
  config builders (`config-wizard.ts`); the sequential-render `config-ui.ts` is removed, and the
  first-run onboarding opens the same Center Model section, so there is one config UX everywhere.
- **Responsive by construction.** Every list (sections, providers, profiles, memory kinds) windows
  to the terminal height via the shared `viewport.ts`, and the frame fills the screen, so the TUI
  composes cleanly at any size.
- **New shared chrome kit** `@personaxis/tui/ui` (`AppFrame`, `SelectList`, `Field`, `Toast`,
  `SpinnerText`, `KeyBar`, `Divider`), theme-aware and `PERSONAXIS_NO_ANIM`-respecting. The dead
  pre-Ink `Screen` line-editor class is deleted (its cursor-following menu logic already lives as
  the tested `windowFor`); `screen.ts` now holds only the shared `ReplHooks`/`SlashItem` types.
- Fallbacks intact: non-TTY / `PERSONAXIS_NO_ALTSCREEN` / `PERSONAXIS_NO_INK` degrade to text or the
  readline menu, so pipes and CI are unaffected.

### Feat: memory engine V2, general entity-facts memory + real recall (V2-F1)
- **General facts memory, not "the user".** A fact's subject is ANY named entity, the ambient
  interlocutor (human, agent, or app), a named person/agent/app, the project. Stable facts
  persist as dotted `<subject>.<attribute>` keys in the `user_preferences` store (no new
  artifact) and load first every turn as a `# Known facts` block grouped by subject; a dot-free
  key is a loose preference. The name case is one instance of the same logic.
- **Recall works offline.** Deterministic ES/EN introduction patterns persist
  `interlocutor.name`/`interlocutor.alias` with no model; the LLM appraiser proposes the same
  `subject.attribute` shape for any subject; the offline responder addresses a known party by
  name. E2E gate: `packages/cli/test/name-recall.e2e.test.ts` (session A → new process → known).
- **Session-start recall**: known facts + previous-session recap (derived at read time) +
  consolidated memory.md + a today/yesterday episodic window, replacing the blind last-6 slice.
- **No more triplication.** The dialog lives once in `sessions/`; the loop only ledgers salient
  lines; one-shot chat no longer writes agent-run entries; at close the session distills into
  3-8 typed entries (`from:<session>` refs). `memory.md` is a salience-ranked digest.
- **Retrieval on demand**: `memory_search` (BM25; `use_embeddings`/`use_reranker` honored with
  stated fallbacks) and `memory_get` tools; `/memory search|consolidate|prune`.
- **Spec knobs consumed** (were decorative): `runtime.memory.*`, `write_policy`,
  `consolidation_policy.mode`, `anchors`, `working_self`. See `docs/architecture/memory.md`.
- **Personas inherit like git**: with no persona at the cwd, `personaxis` walks up to
  `~/.personaxis` (stops at home); `PERSONAXIS_NO_INHERIT=1` opts out.

### Fix: honest compile, git-like persona discovery, height-aware TUI lists (V2-F0)
- **`/compile` never lies.** The REPL's `/compile` now checks that the compiled document actually
  EXISTS before declaring anything up to date, performs the FIRST compile when it is missing
  (deterministic assembler, works with no model configured), verifies the artifact after compiling,
  reports the absolute path written, and reloads the live identity from the fresh document. A
  compile that produces no file is reported as an error, never as success.
- **A persona is born marked "compile pending."** `personaxis init` (all three modes) and the
  starter scaffold drop the recompile-pending marker, and the REPL's first-run onboarding compiles
  the starter deterministically right away, so a fresh persona always has its PERSONA.md.
- **Single owner for the compiled-document path.** New `compiledPathFor()`: sub-personas compile
  inside their folder, project roots one level above `.personaxis/`, and a persona rooted in the
  user's HOME compiles to `~/.personaxis/PERSONA.md` (documented assumption: the home directory is
  not a project root, so no loose `~/PERSONA.md` or `~/CLAUDE.md` is ever created there).
- **Git-like discovery.** `personaxis` now walks up parent directories to find `.personaxis/`
  (nearest ancestor wins; the cwd's own persona always takes precedence), so a home-root persona
  works from any subdirectory. `sigil` and `dash` honor the same discovery for their default path.
- **Every list clamps to the terminal.** The REPL's `/` palette drops its hard cap of 8 (all ~30
  commands are now visible AND reachable) in favor of a height-aware window that follows the cursor,
  with hidden-count markers and a position counter. The card selector, drift view, and dashboard
  envelope list window the same way, via a new shared `@personaxis/tui/viewport` (resize-aware
  `useTerminalSize` + pure `windowFor`).
- **Research: E4 transcription corrected.** The paper's §7.2 latency table now quotes the committed
  `e4-bench.json` receipt (worst p99 0.245 ms, a 4x margin under the 1 ms bar; previously it carried
  an earlier uncommitted run's digits). Amendment logged in `RESEARCH.md`; H4's verdict unchanged.

### Feat: interactive model configuration (profiles + first-run wizard + /config)
- **Named model profiles, any provider.** `config.json` gains a `profiles` library, a
  `defaultProfile`, and a per-persona `profile` reference. A profile carries a `provider`
  (`local | byok | remote | agent`) plus that provider's fields, so one profile configures both
  compile/decompile (`resolveProvider` honors the profile, per-persona or default) and, where the
  provider is OpenAI-compatible, the live REPL reasoning (`resolveModel`). A project profile
  overrides a global one of the same name; editing a profile updates every reference. A config with
  only `local` resolves unchanged, so the layer is additive.
- **First-run wizard.** Launching the REPL in a folder with no model configured offers a
  step-by-step setup (local or cloud, endpoint, model, key strategy), or `skip` with a pointer to
  `/config` for later, instead of only printing a one-line hint.
- **`/config` is now interactive** on a TTY: a menu to add/edit profiles, set the default, assign a
  profile to a persona, or show the resolved config. In a pipe it degrades to the read-only view.
- **Rendered as a real TUI (Ink).** The provider picker, the config menu, and the first-run setup
  are arrow-navigable cards (one description per option), consistent with the REPL's `/drift`
  `/dash` views, via a new generic `@personaxis/tui/prompt` kit (`selectCards` / `promptText`). A
  plain-readline fallback stays for `PERSONAXIS_NO_INK` and non-TTY callers. `/config` launches as a
  subprocess so it never fights the app's stdin (the earlier readline-in-app crash).
- **First-run wizard covers every provider:** pick local / OpenAI / Anthropic / HuggingFace /
  Personaxis-hosted / coding-agent, then only that provider's fields. Every cloud preset also stores
  an OpenAI-compatible endpoint (OpenAI, HuggingFace's router, and Anthropic's OpenAI-compatibility
  endpoint), so the same profile reasons in the live REPL, not just compile.
- **CLI parity (scriptable):** `config set profiles.<name>.{provider|endpoint|model|apiKey|apiKeyEnv|apiProvider|apiBase}`,
  `config set defaultProfile <name>`, `config set personas.<slug>.profile <name>`, and
  `config use <profile> [--persona <slug>]`.
- **Fixes** the `/model` help text: `<endpoint|model|key|key-env>` (was missing `key`) and `[project]`
  (the optional scope; global is already the default), matching the actual behavior.

### Docs: install paths clarified (npx + Windows/PowerShell)
- **README and getting-started** now present `npx personaxis` (run without installing) alongside
  `npm i -g personaxis` (install on PATH), and add a Windows/PowerShell note: the
  `running scripts is disabled on this system` error is PowerShell blocking npm's generated `.ps1`
  launcher for any global CLI, resolved with `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`
  or by calling `personaxis.cmd` / `npx personaxis`.
- **From-source path drops `npm link` / shell alias.** The developer instructions now invoke the
  checkout directly (`node packages/cli/dist/index.js <cmd>`), so a local build stays distinct from a
  published `npm i -g personaxis` and there is no ambiguity about which build answers a bare
  `personaxis`.

### Docs: FASE 7 surfaces documented + final audit (P5)
- **Command and guide docs** now describe the FASE 7 surfaces: `create` and the persona
  guides say the numbers are born load-bearing (Genesis synthesizes per-band prose and
  half-lives; the jacobian gate enforces zero decoratives; hand-writing prose is tuning);
  `repl`/`dash`/`drift` and the command index describe the full-height in-app views
  (`/drift`, `/dash`, `/audit`), the full-screen suspensions (`/proof`, `/create`), the
  live drift gauge, the persistent header, and the animated band-crossing moment.
  `CLAUDE.md` gains the FASE 7 notes for core / cli / tui.
- **Clio (the CLI's own golden persona) closes acceptance criterion 4**: it gains an
  `affect.baseline.mood` block with per-band expression and `half_life: 2` on tone, so T6
  homeostasis is observable on the house persona (validate PASS, jacobian 0 decoratives,
  spec bumped to 1.1.0). Starter, init, CMO, and Clio now all carry mood half-life plus
  banded trait prose.
- **Final audit recorded** in `IMPLEMENTATION_CHECKLIST.md`: build clean across 8 packages;
  tests spec 4/4, core 324/325 (the one red is a timing-sensitive hooks-timeout test that
  passes in isolation, unrelated to this phase), protocol 4/4, sdk 10/10, mcp 11/11, evals
  5/5, cli 86/86, tui 33/33; conformance 15/15; golden CMO PASS with 0 decoratives; spec
  mirror byte-identical; em dash count 0 in every public and doc file touched.

### Docs: reproducibility map + house-style sweep (P4)
- **New `docs/paper/REPRODUCIBILITY.md`**: one row per number in the paper, each mapping
  claim to the committed artifact and the exact command that regenerates it (E3 property
  suite, E4 bench, conformance, PB-G seeds, the P3 single-model runs, RQ3, proof). It also
  states what is still missing (the multi-model headline) and why (the H2 bar needs >= 2
  models with independent judges). The paper links to it, and so does the marketing post.
- **House-style pass** applied to the public-facing surfaces this phase touches: the paper,
  `GUARANTEES.md`, `README.md`, `MATH_CORE.md`, `RESEARCH.md`, and the site post are now
  free of the em dash and the common machine-writing tics (no meaning changed, no number
  moved). Historical CHANGELOG and checklist entries from earlier phases keep their original
  text as append-only records; only this phase's own new entries follow the new style.

### Fixed: foundations review (PA)
- **T2/T3 restated directionally** (MATH_CORE, SPEC §15, the paper, GUARANTEES): the
  delta_max step cap and the ceil(D/delta_max) evidence floor certify movement that increases
  |u| (the adversarial direction). Homeostatic decay is exempt by design: it can only reduce
  |u|, and every decay step is an audited `runtime-decay` entry. The drift report gains
  `decayAssisted` marking the exact exits where decay can cross (recovery on a `half_life`
  coordinate); `state drift`, `/drift`, and the dash detail all show it.
- **Gate composes per field**: k same-field proposals used to slip k*delta_max of net
  movement through `governMutations`; the net is now folded and re-bounded per coordinate,
  which also makes "one mutation per coordinate per tick" true by construction.
- Three new machine-checked properties (PB-T2-compose, PB-T2-decay, PB-T3-decay); property
  suite now 31. New lint `bands-unusable` (invalid declared bands were silently ignored).
  RESEARCH source-fidelity corrections recorded as preregistration amendments; the paper's
  E4 margin corrected from "~10x" to the measured 8x.

### Added: first real-model runs of the behavioral program (P3)
- **E1/E2/E5 recorded against a real model** (`command-a-03-2025`, single-model, labeled as
  such in every artifact): direction favors personaxis on E1/E2 means (9.83 vs 9.00; 9.67
  vs 9.08) and Genesis separates sharply from card-style on E5 (8.25 vs 5.42), but no
  Cliff's delta reaches the preregistered 0.33 bar and same-model judging saturated
  (inter-judge r between -0.10 and 0.12). No superiority claim; the H2 bar needs >= 2
  models with independent judges. Full transcripts in
  `packages/evals/experiments/results/e{1,2,5}-command-a.json`.
- **RQ3 runner** (`experiments/rq3-jbehavior.mjs`): compiles the persona at adjacent band
  representatives, asks frozen probes at temperature 0, measures lexical divergence
  (1 - Jaccard) and Spearman rho against sigma_compile; judge-free and deterministic.
  First run: band prose alone moves behavior (sigma_behavior 0.26 to 0.93, mean 0.56 over
  11 coordinates), but sigma_compile had zero rank spread on the test persona, so rho is
  recorded as undefined in practice (explicit `spread_note`), not as evidence.
- **Genesis dogfooded on a real model**: committed fixture `experiments/fixtures/marlow/`
  (13 evidenced numbers, half-lives extracted from "quick to anger, slow to forgive",
  0 decorative coordinates by the jacobian gate).
- Transport retry with backoff in both runners for intermittent HTTP 422/429/5xx and
  network faults (prompts, probes, and scoring stay frozen). API keys live only in
  environment variables at run time; results record model and date, never credentials.

### Fixed: bugs the gates caught during the real runs (P3)
- `persona.voice.verbosity` could leave the spec enum when an extraction used
  terse/expansive vocabulary: `sanitizeVerbosity` in the spec builder maps synonyms onto
  `adaptive | concise | detailed`, and the extractor's schema now asks for the spec enum
  directly. Caught by the valid-by-construction gate on a live extraction.
- `crossableBands` could emit boundaries that collapse onto the envelope endpoints for
  subnormal-width envelopes (PB-G2 shrank to width 5e-324): an FP guard now treats such
  envelopes as points (nothing to cross, by design) and the new exported `canCross`
  predicate is what the create gate and PB-G2 use.

### Added: the app breathes the math (P0+P2)
- **The loop's events now carry the physics** (gap G5): `drift` ships the full DriftReport
  the loop already computed (no surface re-reads disk to paint), and `recompile` on a band
  crossing ships structured details (field, fromBand, toBand, the new band's prose).
- **The band-crossing moment**: when a coordinate crosses a band, the app's live region
  stages it (the field pulses, the old band gives way, the new expression line lands), then
  commits a summary to the transcript. `PERSONAXIS_NO_ANIM=1` skips straight to the summary
  (CI-deterministic).
- **Live drift gauge** on the status line (persona-themed, red when a layer exceeds its
  declared threshold) plus a persistent header (compact wordmark · persona · posture).
- **In-app drift view**: `/drift` and `/dash` open a full-height interactive view (↑/↓
  select, Enter inspects a coordinate with sparkline + audit log, Esc returns to chat);
  pipe/CI line mode keeps the inline reports.
- **Full-screen suspension**: `/proof` runs the animated guarantee scenes and `/create`
  runs the Genesis wizard on the raw TTY from inside the app (the app re-mounts after).
  Two doors, one engine: CLI subcommands stay the scriptable surface (ADR'd in the
  checklist); everything is reachable inside the app.

### Added: every number is born load-bearing (P1)
- **Deterministic band-prose synthesis** (`genesis/expression-synth.ts`): every trait and
  affect coordinate Genesis emits now carries three distinct behavioral lines, one per band,
  from a versioned BFI/HEXACO construct table (generic fallback for invented trait names).
  Ledger entries are `kind: "synthesis"` with rule `construct-band-prose@v1`: a third honesty
  tier the creation report shows separately from earned evidence and labeled defaults.
- **Crossable bands by construction** (`crossableBands`, math/bands.ts): signed or narrow
  envelopes used to sit entirely inside one default band (valence [-0.3, 0.3] inside the
  signed moderate band), making every crossing geometrically impossible and the number
  decorative no matter what prose it carried. The builder now emits envelope-third
  boundaries whenever fewer than two bands are reachable.
- **Hard load-bearing gate in `create`**: after validate/lint/compile, `staticallyDecorative`
  must find zero decorative coordinates (width-0 envelopes excluded: immutable by geometry)
  or nothing is written. Property PB-G2 proves it for arbitrary hostile seeds; PB-SYNTH
  proves the table is pure and band-distinct.
- **Homeostasis by default** (G4): Genesis mood.tone ships `half_life` (interview item
  `a-volatility` maps the user's answer to 2/4/8 turns); the extractor schema accepts
  `halfLife`/`moodHalfLife` with evidence, and gained a one-shot error-directed repair loop.
- **Provenance covers the whole denotational surface** (G6): the creation report enumerates
  expression/bands/half_life and every affect coordinate (25 fields on the dogfood persona,
  up from 3) and separates earned / synthesized / default.
- Starter persona, the four `init` builders, and the canonical template now ship banded
  expression, crossable bands, and mood half_life; Clio (this repo) and the CMO golden were
  hand-upgraded the same way and recompiled (their compiled docs now select prose per band
  from live state). The validator's coherence check caught and forced a fix where a hard
  virtue referenced a trait whose bands permitted the contradicting low band.

### Changed: command and infrastructure review (PB)
- **Removed `use` and `templates`** (deprecated pre-v0.7 flow; `create` replaced it and
  `template list` covers authoring scaffolds). Docs and indexes updated.
- **`list` rebuilt**: it read the v1.0-removed `metadata.display_name` from the compiled
  document and hinted at removed commands; it now reads `personaxis.md` (source of truth),
  includes the root persona, and prints working next steps.
- **Startup cost**: `@personaxis/spec` no longer compiles its two Ajv schemas at module load
  (~165 ms every CLI invocation, even `--version`); validators compile on first call with an
  identical API. `dash` lazy-loads the tui barrel (~90 ms). Module-graph cost: 400 -> 314 ms.
- Full verdict table (38 CLI subcommands, 29 slash-commands, core modules, infra) recorded
  in IMPLEMENTATION_CHECKLIST.

## [Unreleased], Fase 6 proven core (per `docs/MATH_CORE.md` + `docs/RESEARCH.md`, tracked in `IMPLEMENTATION_CHECKLIST.md`)

### Added, the interview wizard + dashboard drill-down (F6.7b)
- **Genesis interview wizard (Ink)**: `personaxis create` with no flags now opens a full-screen
  wizard on a TTY, progress bar, arrow-key likert/choice/ranking (weights previewed live as
  you rank), and the honesty surface: every answer immediately shows the exact
  `field ← value · rule` mapping it will produce; skips are announced as labeled defaults.
  The interview engine stays pure in core; readline remains the fallback (no TTY, or
  `PERSONAXIS_NO_WIZARD=1`).
- **`personaxis dash` is now interactive**: ↑/↓ selects a coordinate, Enter opens its detail, 
  value/u/band, the live T3 evidence cost (`immutable` for hard-virtue-backed coordinates), a
  sparkline of its mutation history scaled to the envelope, and the last 5 audit entries; Esc
  back, q quit. Non-TTY/`--once` output unchanged.
- Startup guard: the tui barrel exposes the wizard only through a lazy async wrapper, so
  Ink/React never load for plain subcommands (caught by the multi-spawn e2e re-failing; fixed
  before commit).

### Added, the paper + final audit (F6.10)
- **`docs/paper/bounded-persona-dynamics.md`**: *Bounded Persona Dynamics: Deterministic
  Runtime Governance and Grounded Synthesis for Portable AI Personas* (APA 7, web/Markdown
  edition): formal model + T1–T6/A1–A2, external persona Jacobian, grounded synthesis,
  preregistered design, and **only recorded results** (E3 2.3M cases/0 counterexamples, E4
  p99 ≤ 0.12 ms, conformance 15/15, proof 12/12; behavioral headline runs explicitly pending).
  All 21 arXiv references re-verified against the arXiv API with full author lists (one title
  correction recorded in RESEARCH.md's amendment log).
- **CLI startup 2× faster** (audit finding → fix): the REPL (Ink/React, ~1 s of import cost)
  was imported eagerly by every subcommand; it is now lazy-loaded only on the no-subcommand
  path. `--version` 1.26 s → 0.62 s; the flaky-at-5 s multi-spawn e2e is green again.
- Final audit recorded in IMPLEMENTATION_CHECKLIST (build 8/8, 477 unit/property tests green,
  evals 15/15, golden CMO PASS, check-mirror byte-identical, proof 12/12 under
  NO_COLOR/80 col, all relative doc links resolve, help strings speak v1.1).

### Changed, docs speak v1.1 everywhere; guides complete (F6.9)
- README leads with the pitch + the recorded evidence (2.3M cases, 0 counterexamples) and a
  60-second `proof --quick`; command tables gain the v1.1 rows (`create`, `proof`,
  `state drift`, `jacobian`, `arbitrate`); stale `/evolve`/`/sigil` mentions fixed.
- CLAUDE.md, `docs/README.md` (map), `docs/commands/README.md` (CLI + REPL indexes),
  HOW_IT_WORKS (band-crossing recompile trigger, math-moat section, v1.1 commands),
  CONCEPTS_FAQ (§13 the math, §14 `create` vs `init`), architecture/self-evolution
  (normative numeric recompile trigger), all updated surgically to v1.1.
- New guides: `docs/guides/creating-personas.md` (which `create` door for which input,
  provenance review, jacobian step, iterate-under-governance) and `docs/guides/production.md`
  (MCP/SDK/serve surfaces, four production controls, sizing, troubleshooting).

### Added, preregistered experiments + the superiority kit (F6.8)
- **Experiment harness** (`packages/evals/experiments/`, protocols frozen in `docs/RESEARCH.md`):
  - **E4 recorded (REAL)**: hot-path bench, p99 0.059/0.073/0.119 ms per governed tick at
    n=8/16/64 coordinates (H4 "p99 < 1 ms" PASS; `results/e4-bench.json`).
  - **E1/E2/E5/E6 runners ready** (`behavioral.mjs`): engine vs system-prompt vs character-card
    under drift pressure/injection, blind dual LLM judges, Cliff's δ, fixed seeds, raw
    transcripts embedded in each results file. `--mock` self-tests recorded (suffixed `-mock`,
    NOT evidence); headline runs need a model endpoint (`PXS_EXP_*`).
  - **E3 recorded (REAL)**: the full property suite at `FC_NUM_RUNS=100000` per CPU-bound
    property, 28/28 properties green, **2,306,140 generated adversarial cases, 0
    counterexamples**, 215 s wall on 20 cores (`results/e3-scale.json`; CI runs the identical
    suite at 5000). Two earlier attempts discarded as non-evidence (timeout-killed / `| tail`
    swallowed the exit code), details in the results file.
- **`docs/GUARANTEES.md`**: the superiority kit on one page: guaranteed-by-theorem vs measured
  vs pending, with an honest evidence scoreboard (nothing outruns its recorded run).
- **Guides**: `docs/guides/getting-started.md` (by audience: developers, teams/enterprises,
  creators) and `docs/guides/recipes.md` (8 vertical recipes: NPC, brand voice,
  legal/compliance, fintech analyst, tutor, sales, companion/AI-world, coding agent).
- **Command docs** for the F6 surface: `docs/commands/{create,proof,drift,jacobian,arbitrate}.md`
  + `docs/architecture/math-core.md` (theorem→code map for newcomers).
- Property suite: explicit per-test timeout (`PROP_TIMEOUT` in `arbitraries.ts`) so the 10⁵ E3
  run is not killed by vitest's 5 s default, timeouts were masking completion, not failures.

### Added, the denotational core (F6.1–F6.2)
- **Property-based proof harness** (`@personaxis/core` test/properties): 19 fast-check properties
  machine-verify the engine's theorems, T1 box invariance under adversarial mutation sequences,
  T2 bounded step, T4 replay determinism + tamper detection, T5 ledger integrity + real erasure,
  gate policy invariants, u-space/metric axioms, and the T3 evidence-cost bound. `FC_NUM_RUNS`
  scales the case count (CI runs 5000).
- **`personaxis state drift`** (+ `/drift` in the REPL): the drift report, per coordinate its
  value, `u` (fraction of allowed deviation consumed), behavior band, and the **T3 evidence
  cost** (minimum audited mutation-log entries before the next band crossing; `immutable` for
  hard-virtue-backed coordinates); per layer `D = max |u|` checked against
  `governance.drift_thresholds` (a MUST spec field that now actually computes, exit code 2 on
  exceedance). New `drift` event on the loop bus.
- **Band→prose compilation (ADR-004 implemented)**: envelope coordinates with `expression`
  band maps now compile deterministically, the CURRENT band's prose (selected from state.json
  values, envelope means as fallback) is injected as "How your traits express right now" by the
  stage-1 assembler. Numbers are compile-load-bearing for the first time.

### Added, governed dynamics + spec v1.1.0 (F6.3, additive, no codemod)
- **Homeostasis (opt-in, T6)**: an envelope may declare `half_life: h` (turns), the deviation
  from `mean` halves every `h` ticks absent stimulus (λ = 1 − 2^(−1/h), applied before each
  tick's admitted deltas, audited as actor `runtime-decay`). Proven consequence: bounded
  adversarial pressure yields standing drift ≤ `max_step_delta/λ` (input-to-state stability,
  property-tested).
- **Value arbitration is an algorithm** (`personaxis arbitrate [a] [b]` + `/arbitrate`): the
  strict total order `type: governance` ≻ `weight` ≻ name, with an explanatory trace. U7
  (`safety_over_completion`) is now DERIVABLE from U6, verified by the eval `u7-derivable`.
  New lint warning `arbitration-governance-outranks-safety`.
- **Tamper-evident mutation_log**: every new entry hash-chains to its predecessor
  (`prev_hash`/`hash`, the episodic-memory scheme; legacy prefix tolerated), T3's evidence
  bound is now forensic: a band crossing costs ≥⌈dist/δ_max⌉ VERIFIABLE audit entries.
  `verifyMutationChain` exported from core.
- **Spec v1.1.0** (additive; every 1.0.0 document remains valid): envelope `half_life`,
  normative SPEC.md §15 "Mathematical semantics", state.schema.json chain fields; schemas +
  template + SPEC.md mirrored byte-identically (`check-mirror` ✓). Erratum fixed: `bands` is
  the schema's `{low_max, moderate_max}` object (SPEC.md/template briefly showed an array form).
- **5 new conformance evals** (C2): `drift-metric-bounded`, `band-crossing-audited` (T3),
  `homeostasis-returns-to-baseline` (T6), `arbitration-deterministic`, `u7-derivable`, 15/15.

### Added, the persona Jacobian (F6.4)
- **`personaxis jacobian`**: J_compile: the deterministic compile stage is a step function of
  each coordinate's band, so its sensitivity is EXACT (no LLM, offline): compile at each
  reachable band's representative, measure normalized line-edit distance between adjacent
  artifacts. σ = 0 flags a **decorative number**: a mutable coordinate that provably cannot
  change the compiled artifact (exit code 2 when any exist). Ranking shows which coordinates
  actually matter. Run against the golden CMO it exposes 8/12 decorative coordinates (all
  affect dimensions + two plain-string traits), audit F-21, now measurable.
- New lint warning **`decorative-number`** (static variant, no compile needed): envelope
  without per-band `expression`, or identical prose across reachable bands.
- J_behavior (probe-based, BYOK, MATH_CORE Def. 11) ships with the experiment harness (RQ3).

### Added, the live proof + interactive surfaces (F6.7)
- **`personaxis proof`**: the guarantees demonstrated on the REAL engine, offline, ~1 s
  (`--quick`) / full 10,000-step storm: (1) adversarial storm with live u-space gauges and
  0 escapes (T1/T2, seeded PRNG, same `--seed`, same run); (2) prompt injection blocked;
  (3) evidence cost: a watchable band crossing that takes EXACTLY its certified minimum of
  chained audit entries (T3); (4) one forged memory byte caught AND located (T5);
  (5) replay exposes a forged state value (T4). TTY: animated frames + Enter/r/q
  navigation; `--auto`/non-TTY: CI-friendly; `NO_COLOR`: ASCII card. Honest exit codes.
  Ends on the theorem card, every number from THIS run.
- **Drift gauge in `personaxis dash`**: live `D = max |u|` bar checked against the declared
  `governance.drift_thresholds`, red ⚠ per layer over threshold.
- **`/replay` in the REPL**: animated playback of the mutation_log (per-entry gauge,
  clamped/blocked flags, actor), ending with the T4 verdict (replay ≡ live state).

### Added, Persona Genesis: `personaxis create` (F6.6)
- **A governed persona from zero, every entry case covered**: the psychometric interview
  (BFI-style items → trait means, value ranking → weights, dilemmas → hard limits, every
  answer becomes auditable evidence), `--from-prompt` (NL brief), `--from-project` (the
  project's own docs), `--from-import` (character cards V2/V3 as .json or PNG-embedded
  tEXt `chara`/`ccv3`, bare system prompts, CLAUDE.md/AGENTS.md), `--from-transcript`.
  Modes compose; later evidence wins per field, visibly.
- **Valid BY CONSTRUCTION, machine-checked**: the spec builder imposes every universal
  (safety ≥ 0.90 governance and un-outrankable by seeds, honesty hard, the three universal
  hard limits, sane envelopes) on ANY input; property PB-G feeds hostile random seeds
  through the REAL five-state validator (found 2 real builder bugs before shipping:
  value-type enum, voice_exemplars required `user`).
- **Creation report with per-number provenance** (`creation-report.md`): every quantitative
  field traces to an evidence item (answer / imported field / model inference WITH quote)
  or a **labeled default**: "every number earned, not invented". Provenance completeness
  is computed, not asserted.
- **Honest degradation**: no model → interview still works fully; extraction falls back to
  labeled heuristics recorded in the gates (never silent invention). Import prose is
  LLM-only refinement, deterministic card fields are never overridden by guesses.
- Outputs: validated `personaxis.md` (Genesis cannot write an invalid persona), `state.json`,
  stage-1 compiled `PERSONA.md`, `creation-report.md`. `--json` (dry-run sin `--yes`).
- Linter accepts spec_version 1.1.0 (was rejecting it, caught by dogfood).

### Fixed/Hardened, the LLM pipelines (F6.5, pre-Genesis audit)
- **Every provider HTTP call is hardened** (`providers/http.ts`): bounded timeout (120 s
  AbortSignal), jittered retry on 429/5xx/network errors, and error messages that carry the
  response-body excerpt (byok Anthropic/OpenAI + local now share one code path).
- **Structured output** (`Provider.runStructured`): OpenAI `json_schema`, Anthropic forced
  tool-use, local with graceful degradation (`json_schema` → `json_object` → plain+parse), 
  the schema-constrained primitive Genesis synthesizes through.
- **`decompile` gained the error-fed repair loop** (`llm-repair.ts`, bounded 3 rounds): the
  exact failing fields/rules go back to the model instead of discarding the round; an invalid
  personaxis.md is still NEVER written. The loop is generic, Genesis reuses it.
- **The inline deterministic recompile is real now**: the REPL wires `assemble` into
  `makeRecompileHook`, so a band crossing rewrites the compiled doc via the stage-1 assembler
  (band-selected expression from fresh state), F3.1's seam existed but nothing passed it.
- Stale help strings fixed: `validate`/`spec` descriptions and the failure hint now say
  v1.1 / `migrate 0.10-to-1.0` (they still said v0.7.0/v0.10); policy template header bumped.

### Changed, spec-faithful recompile trigger (F6.2)
- The Living Loop now recompiles on a **band crossing** instead of on every applied mutation
  (SPEC v1.0 §L3: within-band movement is expression variance, not drift). Cheaper and
  normative; the tick still emits `mutate` + `drift` events for every change.

## [Unreleased], Fase 3 living engine (per `ARCHITECTURE_REVIEW.md` §11–§13, tracked in `IMPLEMENTATION_CHECKLIST.md`)

### Fixed, v1.0 concordance sweep (F5.2): the toolchain now fully speaks v1.0
- **`lint` was broken on v1.0 personas**: it emitted three FALSE errors (`apiVersion` must be
  `persona.dev/v1`; `spec_version 1.0.0` "not supported"; `reflexive_self_regulation` "missing") plus a
  bogus `metadata.display_name` warning, even though `validate` passed the same persona. The linter is
  now version-aware (like the validator): at v1.0 it expects `personaxis.com/v1`, accepts `spec_version
  1.0.0`, treats `self_regulation` as the layer-9 name, drops the `display_name` requirement, and reads
  refusals from `character.prohibited_behaviors`. Regression test added (`test/lint-v1.test.ts`).
- **First-run scaffold shipped a legacy persona**: `personaxis` first-run onboarding wrote a
  `spec_version 0.8.0` starter. The starter template is now v1.0 (`spec_version 1.0.0`), so new users
  start on the current spec.
- **Subagent scaffolds (`personaxis use`) could drop safety**: the Claude Code / Codex placement
  builders read `reflexive_self_regulation` and `metadata.display_name`, so a v1.0 persona compiled via
  `use` would lose its hard limits and display name. They now read `self_regulation` (legacy fallback)
  and `identity.display_name` first.
- **Injected `## Behavioral Baseline` block** (CLAUDE.md / AGENTS.md) referenced the old layer-9 name;
  corrected to `self_regulation`.
- Docs + guidance updated to v1.0: `CLAUDE.md`, `AGENTS.md`, `README.md`, and `docs/` (layer-9 rename,
  `persona_prompting` folded into layer-10 `persona`, `spec_version 1.0.0`, the `migrate 0.10-to-1.0`
  codemod, and the new `edit` / `state rebuild` / `dash` commands).

### Changed, compile is now a deterministic two-stage pipeline (F3.1)
- **Stage 1, deterministic assembler** (`@personaxis/core` `assemblePersonaDoc`): `personaxis compile`
  now ALWAYS first assembles the canonical, second-person persona-prompting document from the spec
  with NO model, verbatim voice exemplars, hard limits, and resource manifest, and never any numeric
  runtime state. The same spec produces byte-identical output, so the compiled-doc hash is finally a
  meaningful provenance signal.
- **Stage 2, optional LLM polish, faithfulness-gated**: when a model provider is configured, an LLM
  rephrases the assembled document (new rephrase-not-add polish prompt). A deterministic faithfulness
  check (`checkFaithfulness`) diffs the polish against the assembled ground truth over four protected
  claim classes and REJECTS a polish that drops a hard limit or invents a claim, the historical CMO
  regression (invented `consistency` items) now fails closed. On rejection, no provider, or `--no-polish`,
  compile writes the deterministic document. Compile no longer requires a model to produce a correct doc.
- The Living Loop's `recompile` hook can now perform a cheap, provider-free inline recompile via the
  same assembler; the `observe`/daemon path gets it for free through the stage-1 fallback.

### Changed, host placement is a core plugin registry; `.dist/` slices (F3.2)
- **Placement moved to `@personaxis/core`** as a plugin registry (`registerTarget`/`getTarget`/
  `placeForTarget`) with the four built-in hosts (claude-code, codex, openclaw, hermes), so a
  backend (the SaaS) can place documents server-side, not only the CLI. The CLI's `placement.ts` /
  `soul-md.ts` are now thin shims; behavior and the `--platform` flag are unchanged. SOUL.md hosts
  (openclaw/Hermes) re-read the file fresh every message, so a recompile hot-reloads with no restart.
- **`.dist/` consumer slices**: a root compile now also emits `.personaxis/.dist/PERSONA.hot.md`
  (the always-load essentials, opener, voice, always/never anchors, and the hard limits, which are
  never dropped) and `PERSONA.cold.md` (the full document). Deterministic, ephemeral, gitignored.

### Changed, evals are now a conformance suite (C0/C1/C2) (F3.9)
- The eval harness classifies every scenario by spec **conformance class**: C0 Identity (the persona
  is valid, its universals hold), C1 Governed State (clamp/gate/drift bound), C2 Living Runtime
  (memory tamper-evidence, injection can't steer, budgets stop, verification catches), and reports a
  per-class rollup where a class is MET only when every scenario in it passes. Two C0 scenarios were
  added against the real golden persona (the honesty universal is present + hard, and relaxing it is
  rejected by the validator). `personaxis-evals` now prints `C0 x/x · C1 x/x · C2 x/x`.

### Changed, the appraiser proposes against a grounded evolution view (F3.8)
- The Living-Loop appraiser used to propose evolution blind, it saw the mutable field *names* but
  not their current values, envelopes, or the improvement mode. It now receives an **evolution view**:
  each mutable field with its current value, `[min,max]` envelope, band, and remaining headroom, plus
  the mode and the sections open to qualitative self-edits. The model proposes deltas against reality
  ("mood.tone is near the top of its range, nudge down"); the runtime still clamps, governs, and audits.

### Added, `personaxis edit <dot-path>`: surgical governed spec edits (F3.7)
- **`personaxis edit <dot-path> <value>`** edits ONE value in the persona spec without rewriting the
  file: it changes the leaf line textually so every author comment survives, coerces the value to the
  current type, runs the governance gate (protected/governance-controlled paths require `--force`),
  and RE-VALIDATES the whole persona, an edit that would break a universal (e.g. relaxing honesty
  enforcement) is refused. Every accepted edit is audited in the self-edit ledger as a
  `human-operator` change and marks the compiled PERSONA.md stale. `--dry-run` previews.

### Changed, the living REPL split into modules (F3.6)
- **`repl/index.ts` 1341 → 168 lines**: the god-file became the entry point only (startRepl +
  the TTY/line UI loops), with the rest factored into seven cohesive modules along a clean acyclic
  dependency graph, `types` (the shared `Ctx` contract), `config` (persona-path + layered model
  resolution + policy), `render` (event → display line), `daemons` (serve/watch background +
  CLI passthrough), `session` (context lifecycle), `turn` (the unified chat+tools turn + multi-persona
  routing), and `commands` (the slash-command registry). Behavior is unchanged; verified by the full
  suite plus an end-to-end REPL smoke through the new modules. (Routing the interactive agent turn
  through the SDK, and the Ink transcript adoption, are tracked as follow-ons.)

### Changed, the SDK is the single engine façade; MCP + serve consume it (F3.5)
- **`@personaxis/sdk` reaches full parity**: the `Persona` class gained `envelopes`, `agentRun`,
  `forget`, `proposeEdit`/`listProposals`/`decideEdit` (with an explicit proposer≠approver `approver`),
  `recompileStatus`, and `compiledBody`, plus module-level `scanText`/`scanConfig`/`skillReview`/
  `evaluateCmd`, the full surface an embedder (or the SaaS) needs.
- **MCP + serve now delegate to the SDK** instead of re-implementing the clamp/audit/loop/agent
  logic. The MCP `service.ts` keeps its `--root` path confinement and snake_case wire shapes but
  routes every operation through a bound `Persona`; `serve`'s HTTP handlers do the same. The
  duplicated engine wrappers across sdk/mcp/serve are gone. (The REPL is rerouted in F3.6.)

### Added, `state rebuild`: state.json as a checkpoint of the log (F3.4)
- **`personaxis state rebuild`**: `state.values` is a derived checkpoint of the append-only
  `mutation_log`. `rebuild` replays the log (each entry stores its authoritative post-governance
  result) to detect DRIFT, a stored value the log does not justify (a torn write or a hand-edit), 
  and `--write` repairs state.json from the log, under the state lock. Safe by design: the log is
  authoritative only over the fields it mutated, so an untouched value is never reset.

### Added, storage ports, the persistence seam (F3.3)
- **Hexagonal storage ports** (`@personaxis/core` `ports/`): `LockProvider`, `StateStore`,
  `MemoryStore`, `LedgerStore` (the append-only hash-chained episodic ledger), and `ModelClient`,
  bundled as `Storage` with a `defaultFsStorage()` reference adapter. The `LivingLoop` accepts an
  optional `storage` (fs by default) and routes its state read→apply→write and its memory/ledger
  operations through it, so the SaaS can host the SAME engine over Postgres/S3 by swapping the
  bundle. No behavior change locally; the fs adapter wraps the existing atomic writes + per-persona
  lock.

## [Unreleased], Fase R replatform (per `ARCHITECTURE_REVIEW.md` §15 + `docs/architecture/TECH_STACK.md`, tracked in `IMPLEMENTATION_CHECKLIST.md`)

### Added, platform (FR.1–FR.3)
- **`docs/architecture/TECH_STACK.md`**: the definitive stack decision record (12 sections,
  evidence from the Claude Code / Codex / OpenClaw+Hermes source studies).
- **`@personaxis/protocol`**: eighth package: `Op`/`EventMsg` discriminated unions over
  JSON-RPC 2.0 (vscode-jsonrpc + node:net; UDS / Windows named pipes, deterministic per-persona
  pipe path), `ProtocolServer` with a hello handshake as registration barrier, subscribe-before-
  connect `ProtocolClient`; the CLI's `EngineHost` binds the core engine 1:1 onto the seam so
  TUI/headless/MCP/serve share one boundary.
- **TUI on Ink 7**: `@personaxis/tui` gains a `./ink` export, `<Sigil/>`, `<AuraBar/>`,
  `<EnvelopeBars/>` (visual.ts preserved verbatim as pure-string components), `<Transcript/>`
  (`<Static>` scrollback + bounded live region), newline-gated commit queue with fence atomicity
  and table holdback (Codex streaming pattern), marked-terminal markdown + lazy shiki + jsdiff,
  zustand vanilla store with frame-batched tokens. `personaxis dash` interactive path now renders
  through Ink.

### Fixed, FR.V verification findings
- **`personaxis-dash` bin moved to a dedicated entry** (`dist/bin.js`): the main-module guard in
  the tui barrel (`import.meta.url === argv[1]`) fires spuriously for every module inside a
  bun-compiled binary (shared virtual root), launching the dashboard on EVERY CLI invocation.
  Rule adopted: bins get dedicated entry files, never barrel guards.
- **bun-compile verified on 3 targets**: Windows x64 built and executed (`--version`, golden CMO
  `validate` exit 0, `dash --once`); linux-x64 + darwin-arm64 cross-compiled. Packaging note:
  ink's optional `react-devtools-core` must be bundled (root devDependency), `--external`
  fails eagerly inside the binary.

### Added, engine extensibility & safety (FR.4–FR.10)
- **Hooks v2 (shell-out)**: `.personaxis/hooks.json` runs user executables on 6 events
  (PreToolUse/PostToolUse/UserPromptSubmit/Stop/SessionStart/SessionEnd), JSON payload on stdin;
  exit 0 = ok, exit 2 = block, other = warn; optional `{"decision":"block"}` on stdout; blocking
  events are timeout-bounded and fail OPEN to warn; the rest are fire-and-forget. PreToolUse veto
  gates the agent loop before the sandbox gate.
- **Config layers**: explicit numeric precedence (managed 0 → global 10 → project 20 → persona 25
  → frontmatter 28 → env 30) with attributable winners, plus `resolvePolicyTier()` where the
  STRICTEST layer wins regardless of rank (generalized min-wins governance).
- **Sessions**: background `SessionWriter` (ordered queue drain, `flush()`/`shutdown()` acks),
  automatic `parent_uuid` threading, derived rebuildable `sessions/index.json` (JSONL stays the
  source of truth; no SQLite by decision, bun-compile forbids native addons).
- **Tools registry v2**: `isReadOnly`/`isConcurrencySafe` flags + `validateToolArgs()`
  (JSON-Schema, an explicit no-new-dep decision instead of Zod).
- **Permissions v2**: `writableRoots`, protected subpaths (`.git/hooks`, `.personaxis`) that an
  allow-list can never override, per-category approvals (network/destructive/write,
  strictest-wins), named profiles `strict|standard|trusted|yolo`.
- **`ApprovalBroker`** (request→deliver→await→gate; expiry fails CLOSED to deny) wired to the
  protocol `approval` op, and **tool-call repair** (OpenClaw port: fences, prose, single quotes,
  unquoted keys, trailing commas, truncation) on both tool-call parse paths.
- **Credentials**: `personaxis credential set|get`, env-first resolution with OS secure storage
  via shell-out only (macOS Keychain `security`, Linux `secret-tool`; value read from stdin,
  never argv; keytar forbidden). Windows stays env-only until a DPAPI helper ships with the
  signed binary (documented assumption). BYOK keys resolve through it.
- **Update hint**: zero-dependency daily npm dist-tags check (cached, never blocks or throws;
  `PERSONAXIS_NO_UPDATE_CHECK=1` and CI disable it), an explicit deviation from update-notifier
  for supply-chain surface reasons. Binary self-updater + Windows code-signing land with the
  bun-compile release infrastructure.

## [Unreleased], F2 SPEC v1.0 support (per `ARCHITECTURE_REVIEW.md` §11, tracked in `IMPLEMENTATION_CHECKLIST.md`)

### Added, spec v1.0 (breaking spec release; the CLI reads BOTH)
- **Dual-schema validator with version dispatch**: v1.0 documents (`spec_version: "1.0.0"`)
  validate against the rewritten `schema/persona.schema.json`; 0.3.0–0.10.0 documents keep
  validating against the frozen `schema/legacy/persona-0.10.schema.json` (read-compat window).
  Universals run unconditionally with the version-correct paths (`self_regulation` vs
  `reflexive_self_regulation`; `apiVersion` `personaxis.com/v1` vs `persona.dev/v1`). New v1
  coherence check: a hard-enforced virtue whose `refs:` point at a trait envelope that permits
  contradiction is FAIL_POLICY.
- **`migrate 0.10-to-1.0`**: the first STRUCTURAL codemod (comment-preserving, dry-run default,
  written report): renames `reflexive_self_regulation` → `self_regulation` (layer 9 +
  `per_layer_edit_policy` + `drift_thresholds`); merges `persona_prompting` into layer 10
  `persona` and its `break_character_guardrails` into `self_regulation.hard_limits`; merges
  `principled_refusals` into `character.prohibited_behaviors` (two refusal surfaces); moves
  `memory.retrieval_policy` knobs + `deletion_policy.retention_days_default` to the new
  `runtime.memory` block; converts bare drive `intensity` to the nearest static `level`
  (a drive is mutable only by declaring a `{mean, range}` envelope); drops
  `metadata.display_name`; bumps `apiVersion`/`spec_version` (policy.yaml too); renames sibling
  `state.json` value keys to full dot-paths.
- **`resolveField` (core)**: every mutation entry point (`state mutate`, HTTP `/persona/adjust`,
  MCP `adjust_persona_state`, SDK `adjust`) accepts BOTH the short (`mood.tone`) and full
  (`affect.baseline.mood.tone`) field form and resolves onto the persona's canonical envelope
  key, v1 personas use full dot-paths natively; 0.x personas keep short keys.
- v1 envelope extraction: full dot-path keys, envelope-declaring drives join the mutable surface,
  and `protectedFields` covers hard virtues' names AND their `refs`.
- **`@personaxis/spec`**: new seventh package: the canonical JSON Schemas (v1.0 + frozen
  `legacy/persona-0.10` for the 1.x read-compat window), the five-state validator with version
  dispatch, and the 12 universals, embedded at build (bun-compile safe). The CLI's `schema.ts`
  is now a shim; `packages/cli/schema/` moved to `packages/spec/schema/` (single monorepo copy;
  CI byte-identity gate re-pointed).
- **Memory erasure (D6)**: new entries are `content_hash`-anchored; `redactMemory()` performs
  REAL erasure (bytes gone, chain still verifies, audited via tombstone record);
  `migrateMemoryChain()` re-anchors legacy logs (remapping tombstone targets); chain verification
  is dual-format. `STATE_SCHEMA_VERSION` → 1.0.0.
- **`improvement_policy` min-wins precedence (SPEC.md §7.2)**: `readMode(frontmatter, personaPath?)`
  composes the authoritative inline mode with a sibling policy.yaml that can only RESTRICT it
  (legacy `auto` normalizes to `autonomous`); wired at the Living Loop, MCP, REPL, `state mutate`
  and `improve` call sites.
- **`personaxis init` scaffolds are v1.0** (all four builders migrated via the codemod itself;
  scattered pre-0.6 `edit_policy` and bare affect scalars fixed) and a new test proves every
  scaffold validates as 1.0.0, which surfaced and fixed a latent defect: the UserPersona scaffold
  had NEVER validated (the schema now requires the full anatomy only for `kind: AgentPersona`,
  the D9 explicit subset).
- Codemod hardening: strips stray layer-level `edit_policy`, wraps bare core_affect/mood scalars
  into degenerate envelopes (with a widen-me follow-up). `validate` banner prefers
  `identity.display_name`.

## [Unreleased], F1 hardening (per `ARCHITECTURE_REVIEW.md` §9, tracked in `IMPLEMENTATION_CHECKLIST.md`)

### Fixed, governance & integrity
- **`state mutate` now goes through the real governance gate** (F-02): the duplicated mutation
  engine in `commands/state.ts` (with its permanent `governanceBlocked = false` stub) was deleted;
  the command uses core's `extractEnvelopes`/`governMutations`/`applyMutation`. Core's
  `GovernanceConfig` gains `humanDirected`: deliberate `--actor human-operator` mutations bypass
  the mode lock and drift bound (the gate's documented intent), while non-human actors are subject
  to `improvement_policy.mode` and `max_step_delta`; traits backing hard-enforced virtues are
  immutable for every actor; a governance refusal is itself recorded in `mutation_log`
  (`governance_blocked: true`) and exits 2 naming the exact rule.
- **Same-machine concurrency control** (F-03): `writeState` is atomic (temp+rename) and every
  read→modify→write site takes a per-persona lock (`core/src/lock.ts`: mkdir lock dir, PID +
  stale-steal, loud 5s timeout), Living Loop apply, agent persist, HTTP `/persona/adjust`, MCP
  `adjust_persona_state`, SDK `adjust`, and `ensureState` seeding. The lock is never held across
  a model call.
- **MCP server hardening** (F-07, ADR-011): every persona/skill path is confined to `--root`
  (default: the server's cwd), escaping paths are rejected; `persona_decide_edit` is disabled
  unless the human launching the server passes `--allow-decide` (proposer≠approver).
- **Hermes hooks installer rewritten** (F-23): the previous installer wrote a
  `hooks.on_session_end` stanza into `~/.hermes/config.yaml`, a shape Hermes never reads. It now
  installs Hermes' real mechanism: `~/.hermes/hooks/personaxis-observe/{HOOK.yaml, handler.py}`
  subscribed to **`agent:end` (per turn)**; install/uninstall also clean the legacy stanza.
  `docs/integrations/hermes.md` corrected (including that `agent:end` IS a per-turn event).

### Fixed, release & versions
- **`release.yml`**: hand-ordered publish loop (which omitted `@personaxis/sdk` and swallowed
  failures with `|| echo`) replaced by topological `pnpm -r publish`; npm provenance enabled.
- **Version single-sourcing** (F-26): `CORE_VERSION` is generated from `core/package.json` at
  build (`core/scripts/gen-version.mjs`); `ensureState` seeds `STATE_SCHEMA_VERSION` (`0.9.0`,
  the state schema's current value) instead of a stale literal; the MCP server reports its own
  package version; the cli package description said "spec v0.8.0", now v0.10.0.

### Security
- **pnpm supply-chain hardening** (F1.9): `minimumReleaseAge: 2880` (48h) and an explicitly empty
  `onlyBuiltDependencies` allowlist in `pnpm-workspace.yaml`.

### Docs
- CLAUDE.md corrections: evals categories are **governance/security/spec-fidelity** (no "honesty"
  category exists), migrate codemods listed through `0.9-to-0.10`, MCP row reflects the 16 tools +
  `--root`/`--allow-decide`; evals package description no longer claims an "optional live" mode.
- Added `ARCHITECTURE_REVIEW.md` (the master architecture audit + v1.0 design reference) and
  `IMPLEMENTATION_CHECKLIST.md` (persistent execution state).

---

## [0.11.0] - 2026-06-29

Runtime/correctness release (no spec field changes; `spec_version` stays `0.10.0`). Closes the
gap between what the spec declared and what the runtime actually did.

### Added, host targets openclaw + Hermes (2026-07-01)
- **`compile --platform openclaw` and `--platform hermes`**: both hosts read `SOUL.md` as the first
  system-prompt section, so compile writes the compiled qualitative identity as `SOUL.md` (openclaw:
  workspace-root; Hermes: `.hermes/SOUL.md`), stripping the subagent frontmatter. Root and sub-personas
  supported; SOUL.md hosts skip the `@PERSONA.md` baseline injection. `PLACEMENT_PLATFORMS` is now
  `claude-code | codex | openclaw | hermes`. The four focus hosts are all live.
- **Compile now uses the layered config too**: the `local` provider resolves its endpoint/model/key via
  `resolveModel` (env > project > global, `apiKeyEnv`), so `config set --global local.*` drives compile,
  not just the REPL (closes a dev/loop-vs-compile inconsistency).

### Added, living engine, config & UX (2026-07-01)
- **Event-driven living engine**: `personaxis observe` runs ONE governed tick on the configured model
  and recompiles `PERSONA.md` on drift (`--stdin` reads a Claude Code Stop-hook payload; `--strict`/
  `--json` for programmatic hosts). `personaxis hooks install --host claude-code` wires a Stop hook so
  every turn feeds a tick **on your model, not the host's**. `personaxis watch` is an optional local
  daemon (recompile on manual spec edits + a drift heartbeat; `--once` for serverless cron/CI).
- **`@personaxis/sdk`**: embed a living persona in a Node/TS backend (`class Persona`:
  `compiledIdentity`/`state`/`observe`/`adjust`/`audit`). Mode 2 self-host.
- **Layered model config** (no more env exports per launch): `resolveModel` resolves env > project >
  global (`~/.personaxis/config.json`) with per-persona overrides (`personas[slug]` or frontmatter
  `runtime`). API key resolves from the env var named by `apiKeyEnv` → `PERSONAXIS_API_KEY` → inline
  (dev). `config set --global`, `/model set` in the REPL, and a first-run setup hint. REPL/`serve`/MCP
  all use it.
- **`/compact` persists**: a summary checkpoint survives `/resume` (no re-compacting after re-entering).
- MCP server version → 0.11.0.

### Fixed, sandbox & UX (2026-07-01)
- **Sandbox postures now meaningfully differ**: `danger-full-access` allows risky ops without asking
  (YOLO; deny-list still wins), previously it still prompted like `workspace-write`. Changing the
  posture mid-session now nudges the model to re-evaluate (it retries instead of parroting a prior
  refusal from history).
- **Per-turn telemetry** renders as a distinct labeled block (memory used/created, evolution,
  evaluations), and `/` commands are visually separated from the reply.

### Added
- **Persistent sessions** per persona under `.personaxis/[personas/<slug>/]sessions/<id>.jsonl`;
  `/sessions` lists them and `/resume <id|name>` continues one. Auto-named from the first message.
- **Whole-spec self-evolution in the live loop**: each turn the appraiser may propose governed
  self-edits to **any** spec section (not just `persona_prompting`), quantitative, qualitative,
  or any other layer, except the protected safety floor. Editability is decided by `editGate`,
  composing the protected floor + the author's declared `governance.per_layer_edit_policy.<layer>`
  + the global `improvement_policy.mode` (`locked` blocks, `suggesting` queues for `/review`,
  `autonomous` auto-applies; a layer marked `human_approval_required` is queued even in autonomous).
  All gated by consensus verifiers + protected paths + a `user`-trust provenance gate. New `/review`
  command. The appraiser prompt now teaches the exact `{ targetPath, toValue, rationale }` shape so
  real models reliably emit structured self-edits instead of prose.
- **All six `memory.types` enforced**: `procedural`, `autobiographical`, `user_preferences`,
  `evaluations` are implemented (were declared-but-unenforced); each producer honors its flag.
- **Real per-turn observability**: new `memory-recall` (memory *used* to answer: kind+count+snippet)
  and `evaluation` (target+dimension+score+rationale) bus events. The per-turn summary now shows
  `recalled episodic×2 (…) · memory +1 episodic (…) · evaluated #hash usefulness 0.74` instead of an
  opaque `+N eval(s)`. `/state` shows the **whole mutable surface** (envelopes + applied self-edit
  overlay + pending proposals); `/memory` lists all six kinds; `/audit` adds the self-edit ledger +
  recent evaluations.
- **Runtime structure awareness**: the system prompt states whether a persona is root or a sub,
  its address, its sub-persona tree, and its `.personaxis/` resource inventory.

### Changed
- `PERSONA.md` is now purely qualitative: the numeric `LIVE-STATE` block is no longer injected
  into the compiled doc (state lives in `state.json`/`.live.json`); old blocks self-heal.
- `/persona` absorbs `/sigil` (role, sub-personas, resources, mode, posture, sigil).
- Compile prompt: one-source-per-fact + no numeric state.
- Reply format `‹glyph› Name ›  text` so it is clear who spoke.

### Removed
- Redundant REPL commands `/do` and `/evolve` (plain chat already uses tools; every turn already
  runs a governed tick).

### Fixed
- **Conversation turns**: assistant replies are now persisted into the transcript before returning,
  so the next turn carries them, fixes the bug where the agent re-answered every prior question
  each turn instead of only the current one.
- **"Stuck thinking" hang**: a self-edit no longer triggers a blocking full LLM recompile on every
  turn (it marks `PERSONA.md` stale → `/compile`); the LLM appraiser has a 30s request timeout so a
  hung endpoint never blocks a turn.
- No-op mutations (`0.98→0.98`) are no longer printed as "evolved".
- Delegation no longer writes episodic memory when `memory.types.episodic` is `false`.

### Docs
- New [docs/CONCEPTS_FAQ.md](docs/CONCEPTS_FAQ.md): a single navigable answer to the common
  conceptual questions (compile/decompile, sub-personas, what self-evolves and who decides, the
  modes, the six memory kinds, sessions, the sandbox, every REPL command).

---

## [Unreleased]

### Added

- `compile [<slug>] [--root] [--platform <p>]` command: compile `.personaxis/[personas/<slug>/]personaxis.md` to `PERSONA.md` (root) or `<slug>.md` (subagent) via the configured provider (`local | byok | agent | remote`).
- `decompile [<slug>] [--root]` command: hand-edited `PERSONA.md`/`<slug>.md` -> proposed `personaxis.md`, validated before writing.
- `push [--root|<slug>]` command: validate, sync `personaxis.md` <-> compiled doc, and publish a new `AgentPersonaVersion`.
- `pull [--root|<slug>] [--version vX.Y.Z]` command: fetch a persona version's spec, compiled doc, and resource bundle into local layout.
- `state init` command: create `state.json` beside `personaxis.md`, seeded from envelope means.
- `state mutate --field <path> --delta <n> --reason <text>` command: adjust a current value, clamped to envelope, with audit log.
- `state show [--json]` command: pretty-print current state, active context, and recent mutations.
- `migrate 0.5-to-0.6 [<file>] [--apply]` command: structural codemod with written report (governance unification, envelope format, reflexive decisions).
- `migrate 0.6-to-0.7 [--apply]` command: layout-only codemod (root `PERSONA.md` -> `.personaxis/personaxis.md` + PERSONA.md recompile).
- `skills list [--root|<slug>]` command: list `extensions.skills` entries and their materialization status.
- `skills pull <name> [--root|<slug>]` command: pull a `github:org/repo[/path]` skill entry into `skills/<name>/`, validate against agentskills.io rules, and rewrite entry to local path.
- `config set provider <local|byok|agent|remote>` command: configure the provider used by `compile`/`decompile`/self-improvement.
- `decompile` command: registered alongside `compile` in the command index.
- `template list|show|get` commands for managing pedagogical templates.
- `spec` command: print the v0.7.0 spec for injection into agent prompts.
- Provider implementations: `local`, `byok`, `agent`, `remote` (see `src/providers/`).
- `src/resource-manifest.ts`: `buildResourceManifest` -- builds capped resource manifest for compile/decompile prompts without inlining file contents.
- `src/compile-instructions.ts`: prompt templates for `compile` (forward) and `decompile` (reverse).
- `src/targets/skills.ts`: resolve `extensions.skills` entries, materialize local skills to platform discovery dirs, write `skills-manifest.json`.
- `src/manifest.ts`: `manifest.json` tracking compile/decompile provenance and content hashes.
- Skills materialization in `compile`: local skills copied to `.claude/skills/<name>/` (claude-code) or `.agents/skills/<name>/` (codex); `skills-manifest.json` written beside `personaxis.md`; `skills:` preload field injected into Claude Code subagent frontmatter for non-empty skill lists; `Skill` added to `disallowedTools` for subagents with no declared skills.
- Codex subagent `[[skills.config]]` blocks generated by `compile` for per-subagent access control.

### Changed

- `spec_version` validator now accepts `"0.3.0"`, `"0.4.0"`, `"0.5.0"`, `"0.6.0"`, and `"0.7.0"` (was hardcoded to `"0.3.0"` or `"0.4.0"`, causing all modern personas to emit a lint error).
- All `init` templates updated from spec v0.5.0 to v0.7.0: removed scattered `edit_policy` from individual layers, removed `drift_threshold` from personality, converted `affect.baseline.core_affect` values to `{mean, range}` envelopes, changed `reflexive_self_regulation.actions: []` to `decisions: {}`, added full `governance` block with `per_layer_edit_policy`, `drift_thresholds`, and `improvement_policy_location`.
- `init` baseline mode now creates `.personaxis/personaxis.md` (quantitative spec) instead of root `PERSONA.md`; user runs `compile --root` to produce the compiled qualitative document.
- `init` agent mode now writes `personaxis.md` (not `PERSONA.md`) inside `.personaxis/personas/<slug>/`.
- `init` user mode now writes `personaxis.md` (not `PERSONA.md`) inside `.personaxis/user-personas/<slug>/`.
- `policy.yaml` template updated from spec v0.5.0 to v0.7.0.
- `compile` hints in `init` output updated from `--target` to `--platform` flags.
- `.personaxis/personaxis.md` (this repo's own baseline): migrated from v0.6.0 to v0.7.0 -- removed scattered `edit_policy` and `drift_threshold`, converted `affect.baseline.core_affect` to envelopes, changed `reflexive_self_regulation` to `decisions:{}` format, expanded `governance` block with `per_layer_edit_policy`, `drift_thresholds`, `improvement_policy_location`.
- `use` command output file changed from `PERSONA.md` to `personaxis.md` (correct v0.7.0 quantitative spec filename); compile hints updated to `--platform`.
- `compile` command: replaced legacy `--target` flag and `runLegacyTargetExport` with `--platform` and `runCompile`; added skills materialization pipeline.
- `CLAUDE.md` golden test paths corrected to `../persona.md/.personaxis/personas/cmo/personaxis.md`; `src/targets/runtime-skills.ts` reference replaced with `src/targets/skills.ts`.
- `AGENTS.md` golden test paths corrected to `../persona.md/.personaxis/personas/cmo/personaxis.md` and `state.json`.
- `README.md`: badge updated to spec-0.7.0; title updated to "spec v0.7.0 / Personaxis v12"; added `migrate 0.6-to-0.7` to migration examples; commands table corrected; "Compile platforms" section replaces "Compile targets"; "v0.7 three-artifact model" section added.
- `package.json` description updated to v0.7.0/Personaxis v12 with correct three-artifact model and command list.

### Removed

- Removed pre-0.7.0 `--target`/`use` legacy skill export; `personaxis compile [slug] --platform <platform>` covers this with v0.7.0 resource names and now also materializes declared skills (see `personaxis skills`).
- Removed `src/targets/runtime-skills.ts` (legacy, pre-v0.6 resource names); replaced by `src/targets/skills.ts`.
- Removed `extensions.knowledge_anchors` support (deprecated in v0.6; redundant with `references/`).
- Removed scattered `edit_policy` fields from individual layers in all `init` templates (consolidated into `governance.per_layer_edit_policy` per v0.6 spec).

### Fixed

- Linter `spec_version` check no longer rejects all v0.5+/v0.6+/v0.7+ personas.
- `use` command no longer writes `PERSONA.md` (v0.5 name) as the quantitative spec output; now correctly writes `personaxis.md`.

---

## [0.6.0] - 2026-05-18

_(initial published version, spec v0.6.0 / Personaxis v11)_

- Baseline validator, linter, `init`, `validate`, `lint`, `list`, `templates`, `diff`, `export`, `spec`, `use` commands.
- Five-state validator (`PASS`, `PASS_WITH_WARNINGS`, `FAIL_SCHEMA`, `FAIL_POLICY`, `FAIL_CONCEPTUAL`) with exit codes 0/0/1/2/3.
- Twelve universal invariants enforced in `src/schema.ts`.
- Lint rules in `src/linter/rules.ts` with tier-aware `MUST`/`SHOULD`/`MAY` findings.
- `init` templates: project baseline, marketing-guru, custom agent, user persona.
- Compile targets: Claude Code (`src/targets/claude-code.ts`), Codex (`src/targets/codex.ts`), with CLAUDE.md/AGENTS.md baseline injection.
