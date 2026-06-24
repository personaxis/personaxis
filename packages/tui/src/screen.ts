/**
 * Screen — a dependency-free, scrollable, region-aware alternate-screen TUI host.
 *
 * The alternate screen buffer (vim/htop/Claude Code) deliberately bypasses the
 * terminal's own scrollback — so a real TUI must own its scroll buffer. This Screen
 * keeps the full transcript in a capped ring buffer and renders a viewport you can
 * scroll (PgUp/PgDn, Shift+↑/↓, Ctrl+U/D, mouse wheel), with role-typed regions
 * (you / persona / activity / system), per-line diff rendering (no full-screen
 * flash), an animated thinking spinner, and an inline approval prompt.
 *
 * TTY-only; callers fall back to a line reader when stdin isn't a TTY.
 */

import readline from "node:readline";
import chalk from "chalk";

export type LineRole = "user" | "persona" | "activity" | "system" | "divider";

export interface SlashItem {
  name: string;
  desc: string;
}

export interface ScreenHooks {
  renderHeader(cols: number): string[];
  renderStatus(cols: number): string;
  commands: SlashItem[];
  onSubmit(line: string): Promise<void> | void;
  onCycleMode?(): void;
  onExit?(): void;
}

interface Line {
  role: LineRole;
  text: string;
}

const ALT_ON = "\x1b[?1049h";
const ALT_OFF = "\x1b[?1049l";
const MOUSE_ON = "\x1b[?1000h\x1b[?1006h";
const MOUSE_OFF = "\x1b[?1000l\x1b[?1006l";
const HIDE_CURSOR = "\x1b[?25l";
const SHOW_CURSOR = "\x1b[?25h";
const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const MAX_TRANSCRIPT = 5000; // ring buffer cap for long / multi-agent sessions

// Subtle left gutter per region so the eye can parse who/what each line is.
const GUTTER: Record<LineRole, string> = {
  user: chalk.cyan("▌"),
  persona: chalk.magentaBright("▌"),
  activity: chalk.dim("│"),
  system: chalk.dim(" "),
  divider: chalk.dim(" "),
};

export class Screen {
  private readonly out = process.stdout;
  private readonly inp = process.stdin;
  private transcript: Line[] = [];
  private input = "";
  private busy = false;
  private phase = "";
  private closed = false;
  private scrollOffset = 0; // lines hidden BELOW the viewport (0 = at bottom)
  private spinnerFrame = 0;
  private spinnerTimer: NodeJS.Timeout | null = null;
  private pendingAsk: ((s: string) => void) | null = null;

  constructor(private readonly hooks: ScreenHooks) {}

  start(): void {
    this.out.write(ALT_ON + HIDE_CURSOR + MOUSE_ON);
    readline.emitKeypressEvents(this.inp);
    if (this.inp.isTTY) this.inp.setRawMode(true);
    this.inp.on("keypress", this.onKey);
    this.inp.on("data", this.onData);
    process.on("SIGWINCH", this.onResize);
    this.render();
  }

  stop(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.spinnerTimer) clearInterval(this.spinnerTimer);
    this.inp.off("keypress", this.onKey);
    this.inp.off("data", this.onData);
    process.off("SIGWINCH", this.onResize);
    if (this.inp.isTTY) this.inp.setRawMode(false);
    this.inp.pause();
    this.out.write(MOUSE_OFF + SHOW_CURSOR + ALT_OFF);
  }

  /** Append text to the transcript under a region role, then repaint. */
  print(text: string, role: LineRole = "system"): void {
    const atBottom = this.scrollOffset === 0;
    const lines = text.split("\n");
    for (const l of lines) this.transcript.push({ role, text: l });
    if (this.transcript.length > MAX_TRANSCRIPT) this.transcript.splice(0, this.transcript.length - MAX_TRANSCRIPT);
    // Keep the user's scroll position stable if they've scrolled up.
    if (!atBottom) this.scrollOffset = Math.min(this.transcript.length - 1, this.scrollOffset + lines.length);
    this.render();
  }

  /** A blank divider line between turns. */
  divider(): void {
    this.print("", "divider");
  }

  setBusy(busy: boolean, phase = ""): void {
    this.busy = busy;
    this.phase = phase;
    if (busy && !this.spinnerTimer) {
      this.spinnerTimer = setInterval(() => {
        this.spinnerFrame = (this.spinnerFrame + 1) % SPINNER.length;
        this.render();
      }, 90);
    } else if (!busy && this.spinnerTimer) {
      clearInterval(this.spinnerTimer);
      this.spinnerTimer = null;
    }
    this.render();
  }

  setPhase(phase: string): void {
    this.phase = phase;
    if (this.busy) this.render();
  }

  /** Prompt for a one-line answer (e.g. an approval). The next Enter resolves it. */
  ask(prompt: string): Promise<string> {
    this.print(prompt, "system");
    return new Promise((res) => {
      this.pendingAsk = res;
      this.render();
    });
  }

  // ── input ──────────────────────────────────────────────────────────────────
  private onResize = (): void => this.render();

  private onData = (buf: Buffer): void => {
    if (this.closed) return;
    const s = buf.toString("latin1");
    // SGR mouse wheel: ESC [ < b ; x ; y (M|m). 64 = wheel up, 65 = wheel down.
    const m = s.match(/\x1b\[<(\d+);\d+;\d+[Mm]/);
    if (m) {
      const b = Number(m[1]);
      if (b === 64) this.scrollBy(3);
      else if (b === 65) this.scrollBy(-3);
    }
  };

  private viewportBody(): number {
    const rows = this.out.rows ?? 24;
    const header = this.hooks.renderHeader(this.cols()).length;
    const menu = this.menuLines(this.cols()).length;
    return Math.max(1, rows - header - 1 /*blank*/ - menu - 1 /*status*/ - 1 /*input*/ - 1 /*blank*/);
  }

  private scrollBy(lines: number): void {
    const maxOffset = Math.max(0, this.transcript.length - 1);
    this.scrollOffset = Math.min(maxOffset, Math.max(0, this.scrollOffset + lines));
    this.render();
  }

  private onKey = (str: string | undefined, key: readline.Key): void => {
    if (this.closed) return;
    const body = this.viewportBody();
    if (key.ctrl && key.name === "c") {
      this.hooks.onExit?.();
      this.stop();
      process.exit(0);
    }
    // Scroll controls (work whether or not you're typing).
    if (key.name === "pageup") return this.scrollBy(body - 1);
    if (key.name === "pagedown") return this.scrollBy(-(body - 1));
    if (key.shift && key.name === "up") return this.scrollBy(1);
    if (key.shift && key.name === "down") return this.scrollBy(-1);
    if (key.ctrl && key.name === "u") return this.scrollBy(Math.floor(body / 2));
    if (key.ctrl && key.name === "d") return this.scrollBy(-Math.floor(body / 2));

    if (key.name === "return") {
      if (this.pendingAsk) {
        const ans = this.input;
        this.input = "";
        const resolve = this.pendingAsk;
        this.pendingAsk = null;
        resolve(ans);
        this.render();
        return;
      }
      void this.submit();
      return;
    }
    if (key.name === "backspace") {
      this.input = this.input.slice(0, -1);
      this.render();
      return;
    }
    if (key.name === "tab" && key.shift) {
      this.hooks.onCycleMode?.();
      this.render();
      return;
    }
    if (key.name === "escape") {
      this.input = "";
      this.scrollOffset = 0;
      this.render();
      return;
    }
    // Printable character (ignore control/escape sequences incl. mouse).
    if (str && !key.ctrl && !key.meta && str.length === 1 && str >= " ") {
      this.input += str;
      this.scrollOffset = 0; // jump to bottom when you start typing
      this.render();
    }
  };

  private async submit(): Promise<void> {
    const line = this.input.trim();
    this.input = "";
    this.scrollOffset = 0;
    if (!line) {
      this.render();
      return;
    }
    try {
      await this.hooks.onSubmit(line);
    } catch (e) {
      this.print(chalk.red(`error: ${(e as Error).message}`), "system");
    }
    this.render();
  }

  // ── rendering ────────────────────────────────────────────────────────────────
  private cols(): number {
    return this.out.columns ?? 80;
  }

  private menuLines(cols: number): string[] {
    if (!this.input.startsWith("/")) return [];
    const q = this.input.slice(1).toLowerCase();
    const matches = this.hooks.commands.filter((c) => c.name.startsWith(q)).slice(0, 8);
    if (matches.length === 0) return [];
    return matches.map((c) => "  " + chalk.cyan(`/${c.name}`).padEnd(22) + chalk.dim(c.desc.slice(0, cols - 26)));
  }

  private inputLine(): string {
    if (this.pendingAsk) return chalk.yellow("? ") + this.input + chalk.dim("▏");
    if (this.busy) {
      const sp = chalk.magentaBright(SPINNER[this.spinnerFrame]);
      return `${sp} ${chalk.dim(this.phase || "working…")}`;
    }
    return `${chalk.cyan("›")} ${this.input}${chalk.dim("▏")}`;
  }

  private render(): void {
    if (this.closed) return;
    const rows = this.out.rows ?? 24;
    const cols = this.cols();
    const header = this.hooks.renderHeader(cols);
    const menu = this.menuLines(cols);
    let status = this.hooks.renderStatus(cols);
    if (this.scrollOffset > 0) status = chalk.yellow(`  ↑ scrolled · ${this.scrollOffset} line(s) below · End/type to return`);

    const bodyHeight = Math.max(1, rows - header.length - 1 - menu.length - 1 - 1 - 1);
    const end = this.transcript.length - this.scrollOffset;
    const startIdx = Math.max(0, end - bodyHeight);
    const slice = this.transcript.slice(startIdx, end);
    const body: string[] = slice.map((l) => `${GUTTER[l.role]} ${l.text}`);
    while (body.length < bodyHeight) body.unshift("");

    const frame = [...header, "", ...body, ...menu, status, this.inputLine()];
    // Per-line diff paint: home, then each line cleared to EOL; clear below at end.
    let outBuf = "\x1b[H";
    for (let i = 0; i < frame.length; i++) outBuf += "\x1b[2K" + frame[i] + (i < frame.length - 1 ? "\r\n" : "");
    outBuf += "\x1b[J";
    this.out.write(outBuf);
  }
}
