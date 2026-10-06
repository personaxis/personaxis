/**
 * D6: holding presence for the length of a command.
 *
 * Announcing once is not enough and announcing forever is a lie. A holder has to refresh
 * while it works and disappear when it stops, including the way long-running commands
 * actually stop, which is Ctrl+C rather than a return statement. That is three concerns
 * (heartbeat, clean exit, signal exit) that every producer would otherwise implement
 * slightly differently, and the REPL's version was the only one that existed.
 *
 * Why it matters beyond tidiness: `livePresence` is what the Command Center and `ps` read
 * to answer "is someone using this persona". A `serve` running for an hour showed up as
 * idle, so the fleet asserted a state the system did not have. A presence view that is
 * wrong in the direction of "nobody is here" is worse than none, because the whole point is
 * to stop two people editing the same persona at once.
 *
 * WHO ANNOUNCES: whoever holds the persona long enough for someone else to collide with
 * them. The daemons (`serve`, `watch`, MCP) and the operations that run a model
 * (`compile`, `observe`, `orchestrate --run`). Read-only and instant commands
 * (`validate`, `lint`, `ps`, `dash`) do not: a marker that appears and vanishes inside a
 * few milliseconds is noise on disk that no reader can ever see in time.
 */

import { resolve } from "node:path";
import { announcePresence, releasePresence, PRESENCE_HEARTBEAT_MS, type PresenceHost } from "@personaxis/core";

export interface PresenceHold {
  /** Change what this holder reports doing, and publish it at once. */
  note(activity: string): void;
  /** Withdraw. Idempotent: the exit hook and an explicit call must not fight. */
  release(): void;
}

export interface HoldOptions {
  host: PresenceHost;
  /** What it is doing at the moment it starts, in plain words. */
  activity: string;
  project?: string;
  sessionId?: string;
}

/** A hold that does nothing, for the paths where there is no persona to hold. */
const NO_HOLD: PresenceHold = { note: () => {}, release: () => {} };

/**
 * What this process is holding right now, one entry per persona.
 *
 * Presence is written per `<device>-<pid>`, so a process is ONE holder however many nested
 * operations it is running. `watch` calling `compile` is the real case: without this it
 * would install a second heartbeat and a second set of exit hooks on every recompile, and
 * Node would start warning about listener leaks after a few of them.
 */
interface Holder {
  /** Innermost activity last. A nested operation restores what it interrupted. */
  activities: string[];
  publish(): void;
  stop(): void;
}
const HELD = new Map<string, Holder>();

/**
 * Announce this process as a holder of `personaPath` until it releases.
 *
 * Never throws and never keeps the process alive: presence is observability, and a command
 * that failed to announce itself must still do the job it was asked for.
 */
export function holdPresence(personaPath: string | undefined, opts: HoldOptions): PresenceHold {
  if (!personaPath) return NO_HOLD;
  const key = resolve(personaPath);

  const existing = HELD.get(key);
  if (existing) return nest(key, existing, opts.activity);

  const project = opts.project ?? process.cwd();
  const holder: Holder = {
    activities: [opts.activity],
    publish() {
      const activity = this.activities[this.activities.length - 1];
      announcePresence(key, { host: opts.host, project, sessionId: opts.sessionId, activity });
    },
    stop() {
      clearInterval(beat);
      HELD.delete(key);
      releasePresence(key);
    },
  };

  const beat = setInterval(() => holder.publish(), PRESENCE_HEARTBEAT_MS);
  // A heartbeat must never be the reason a process stays up. Without this, a short command
  // whose work is done would sit there beating until the interval was cleared.
  beat.unref?.();

  HELD.set(key, holder);
  holder.publish();
  installExitHooks(() => {
    if (HELD.get(key) === holder) holder.stop();
  });

  return {
    note(next: string) {
      holder.activities[holder.activities.length - 1] = next;
      holder.publish();
    },
    release() {
      if (HELD.get(key) === holder) holder.stop();
    },
  };
}

/**
 * A hold taken while this process already holds the same persona.
 *
 * It owns only its own line of the activity stack: releasing it restores what was being
 * reported before, so `compile` running inside `watch` leaves "watching for spec edits"
 * behind instead of a stale "compiling" that outlives the compile.
 */
function nest(key: string, holder: Holder, activity: string): PresenceHold {
  const depth = holder.activities.push(activity);
  holder.publish();
  let released = false;

  return {
    note(next: string) {
      if (released) return;
      holder.activities[depth - 1] = next;
      holder.publish();
    },
    release() {
      if (released) return;
      released = true;
      // Truncate rather than pop: an inner hold released out of order must not take
      // someone else's line with it, and the outer one is still the truth.
      if (HELD.get(key) === holder && holder.activities.length >= depth) {
        holder.activities.length = depth - 1;
        if (holder.activities.length) holder.publish();
      }
    },
  };
}

/**
 * Make sure `release` runs however this process ends.
 *
 * `exit` is the reliable half: it fires on a natural return and on `process.exit()`, and it
 * allows synchronous work, which deleting a file is. It does NOT fire on a signal nobody
 * handles, because an unhandled SIGINT kills the process outright.
 *
 * So signals are handled too, but carefully. Adding a listener to SIGINT silently cancels
 * the default "die now", which would leave `serve` unstoppable with Ctrl+C. The rule is
 * decided WHEN THE SIGNAL ARRIVES, not when the hook is installed: if by then some other
 * handler is registered, that one owns the exit and this hook only cleans up; if this hook
 * is alone, the default was to terminate and it inherits that duty. Deciding at install
 * time would get `watch` wrong, since it registers its own handler afterwards. Exit codes
 * follow the shell convention, 128 plus the signal number.
 */
function installExitHooks(release: () => void): void {
  process.once("exit", release);

  for (const [signal, code] of [
    ["SIGINT", 130],
    ["SIGTERM", 143],
  ] as const) {
    process.once(signal, () => {
      release();
      // `once` removes this listener before calling it, so a remaining count means
      // somebody else is still listening and will end the process.
      if (process.listenerCount(signal) === 0) process.exit(code);
    });
  }
}
