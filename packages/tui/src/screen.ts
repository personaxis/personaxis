/**
 * Repl — a NORMAL-buffer, minimalist interactive line editor.
 *
 * Deliberately NOT an alternate-screen app: taking over the screen (and capturing
 * the mouse) breaks the things a terminal already does well — native scrollback,
 * text selection, click. So this stays in the normal buffer: output is printed
 * normally (the terminal owns scrollback / wheel / selection), and only a small
 * prompt block is kept pinned at the bottom, redrawn in place. Raw mode is used
 * for key handling ONLY (no mouse reporting), so wheel/selection still work.
 *
 * Provides: a live `/` command palette navigable with ↑/↓ + Tab, an inline busy
 * spinner, and an approval prompt — all without leaving the normal buffer.
 */

import readline from "node:readline";
import chalk from "chalk";

export type LineRole = "user" | "persona" | "activity" | "system" | "divider";

export interface SlashItem {
  name: string;
  desc: string;
}

export interface ReplHooks {
  /** The prompt prefix, e.g. "❯ ". */
  prompt(): string;
  /** A status line shown BELOW the input (tokens · time · mode). */
  status(): string;
  commands: SlashItem[];
  onSubmit(line: string): Promise<void> | void;
  onCycleMode?(): void;
  onExit?(): void;
}

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export class Screen {
  private readonly out = process.stdout;
  private readonly inp = process.stdin;
  private input = "";
  private menuOpen = false;
  private menuIndex = 0;
  private busy = false;
  private phase = "";
  private closed = false;
  private renderedRows = 0; // terminal rows the prompt block currently occupies
  private spinnerFrame = 0;
  private spinnerTimer: NodeJS.Timeout | null = null;
  private pendingAsk: ((s: string) => void) | null = null;

  constructor(private readonly hooks: ReplHooks) {}

  start(): void {
    readline.emitKeypressEvents(this.inp);
    if (this.inp.isTTY) this.inp.setRawMode(true);
    this.inp.on("keypress", this.onKey);
    this.out.write(chalk.dim("\x1b[?25h")); // ensure cursor visible (no alt-screen, no mouse)
    this.renderPrompt();
  }

  stop(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.spinnerTimer) clearInterval(this.spinnerTimer);
    this.clearPrompt();
    this.inp.off("keypress", this.onKey);
    if (this.inp.isTTY) this.inp.setRawMode(false);
    this.inp.pause();
  }

  /** Print a line of OUTPUT above the prompt (stays in native scrollback). */
  print(text: string, _role: LineRole = "system"): void {
    this.clearPrompt();
    this.out.write(text + "\n");
    this.renderPrompt();
  }

  setBusy(busy: boolean, phase = ""): void {
    this.busy = busy;
    this.phase = phase;
    if (busy && !this.spinnerTimer) {
      this.spinnerTimer = setInterval(() => {
        this.spinnerFrame = (this.spinnerFrame + 1) % SPINNER.length;
        this.renderPrompt();
      }, 90);
    } else if (!busy && this.spinnerTimer) {
      clearInterval(this.spinnerTimer);
      this.spinnerTimer = null;
    }
    this.renderPrompt();
  }

  setPhase(phase: string): void {
    this.phase = phase;
    if (this.busy) this.renderPrompt();
  }

  /** Prompt for a one-line answer (e.g. an approval). The next Enter resolves it. */
  ask(prompt: string): Promise<string> {
    this.print(chalk.yellow(prompt));
    return new Promise((res) => {
      this.pendingAsk = res;
      this.renderPrompt();
    });
  }

  // ── prompt rendering (pinned at the bottom of the normal buffer) ────────────
  private cols(): number {
    return this.out.columns ?? 80;
  }

  private matches(): SlashItem[] {
    const q = this.input.slice(1).toLowerCase();
    return this.hooks.commands.filter((c) => c.name.startsWith(q));
  }

  private rule(): string {
    return chalk.dim("─".repeat(Math.min(this.cols(), 72)));
  }

  private promptBlock(): string[] {
    if (this.busy) {
      return [this.rule(), `${chalk.cyan(SPINNER[this.spinnerFrame])} ${chalk.dim(this.phase || "working…")}`];
    }
    if (this.pendingAsk) return [chalk.yellow("? ") + this.input];

    // The input line: a subtle background marks the area the USER is typing in.
    const typed = this.input.length ? chalk.bgAnsi256(236).whiteBright(` ${this.input} `) : chalk.dim(" type a message… ");
    const promptLine = this.hooks.prompt() + typed;

    if (this.menuOpen) {
      const items = this.matches();
      // Windowed + scrollable: the visible slice follows the cursor, and its height
      // adapts to the terminal so the menu never overruns small windows.
      const rows = this.out.rows ?? 24;
      const maxVisible = Math.max(3, Math.min(items.length, rows - 7));
      let start = 0;
      if (items.length > maxVisible) {
        start = Math.min(Math.max(0, this.menuIndex - Math.floor(maxVisible / 2)), items.length - maxVisible);
      }
      const visible = items.slice(start, start + maxVisible);
      const up = start > 0 ? "↑" : " ";
      const down = start + maxVisible < items.length ? "↓" : " ";
      const head = items.length > maxVisible
        ? chalk.dim(`  ┄ ${up}${down} ${this.menuIndex + 1}/${items.length} · Tab fill · Enter run · Esc close ┄`)
        : chalk.dim("  ┄ ↑↓ select · Tab fill · Enter run · Esc close ┄");
      const menu = visible.map((c, i) => {
        const idx = start + i;
        const sel = idx === this.menuIndex;
        const label = sel ? chalk.black.bgCyan(` /${c.name} `) : chalk.cyan(` /${c.name} `);
        const pad = " ".repeat(Math.max(0, (sel ? 26 : 20) - (c.name.length + 3)));
        return "  " + label + pad + chalk.dim(c.desc.slice(0, Math.max(8, this.cols() - 30)));
      });
      return [promptLine, head, ...menu];
    }
    // Status line BELOW the input, separated by a rule.
    return [promptLine, this.rule(), this.hooks.status()];
  }

  private renderPrompt(): void {
    if (this.closed) return;
    this.clearPrompt();
    const block = this.promptBlock();
    this.out.write(block.join("\n"));
    this.renderedRows = block.length;
  }

  private clearPrompt(): void {
    if (this.renderedRows <= 0) {
      this.out.write("\r\x1b[K");
      return;
    }
    // Move to column 0, up to the first prompt row, then clear everything below.
    this.out.write("\r");
    if (this.renderedRows > 1) this.out.write(`\x1b[${this.renderedRows - 1}A`);
    this.out.write("\x1b[J");
    this.renderedRows = 0;
  }

  // ── input ───────────────────────────────────────────────────────────────────
  private onKey = (str: string | undefined, key: readline.Key): void => {
    if (this.closed) return;
    if (key.ctrl && key.name === "c") {
      this.hooks.onExit?.();
      this.stop();
      this.out.write("\n");
      process.exit(0);
    }

    // Command-palette navigation.
    if (this.menuOpen) {
      const items = this.matches();
      if (key.name === "up") {
        this.menuIndex = (this.menuIndex - 1 + Math.max(1, items.length)) % Math.max(1, items.length);
        return this.renderPrompt();
      }
      if (key.name === "down") {
        this.menuIndex = (this.menuIndex + 1) % Math.max(1, items.length);
        return this.renderPrompt();
      }
      if (key.name === "tab") {
        if (items[this.menuIndex]) this.input = "/" + items[this.menuIndex].name + " ";
        this.menuOpen = false;
        return this.renderPrompt();
      }
      if (key.name === "escape") {
        this.menuOpen = false;
        return this.renderPrompt();
      }
    }

    if (key.name === "return") {
      // If the palette is open with a highlighted command and the user only typed
      // the partial, run that command; otherwise submit the typed line.
      if (this.menuOpen) {
        const items = this.matches();
        if (items[this.menuIndex] && this.input.slice(1) !== items[this.menuIndex].name) {
          this.input = "/" + items[this.menuIndex].name;
        }
        this.menuOpen = false;
      }
      if (this.pendingAsk) {
        const ans = this.input;
        this.input = "";
        const r = this.pendingAsk;
        this.pendingAsk = null;
        r(ans);
        return this.renderPrompt();
      }
      void this.submit();
      return;
    }
    if (key.name === "backspace") {
      this.input = this.input.slice(0, -1);
      this.menuOpen = this.input.startsWith("/");
      this.menuIndex = 0;
      return this.renderPrompt();
    }
    if (key.name === "tab" && key.shift) {
      this.hooks.onCycleMode?.();
      return this.renderPrompt();
    }
    if (str && !key.ctrl && !key.meta && str.length === 1 && str >= " ") {
      this.input += str;
      this.menuOpen = this.input.startsWith("/");
      this.menuIndex = 0;
      return this.renderPrompt();
    }
  };

  private async submit(): Promise<void> {
    const line = this.input.trim();
    this.input = "";
    this.menuOpen = false;
    this.clearPrompt();
    if (!line) {
      this.renderPrompt();
      return;
    }
    try {
      await this.hooks.onSubmit(line);
    } catch (e) {
      this.print(chalk.red(`error: ${(e as Error).message}`));
    }
    this.renderPrompt();
  }
}
