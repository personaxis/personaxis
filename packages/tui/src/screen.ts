/**
 * Screen — a minimal, dependency-free alternate-screen TUI host (G2).
 *
 * Turns the REPL/dashboard into a real full-screen app (like vim/htop/Claude
 * Code): it takes over the alternate screen buffer so frames never pile up in
 * scrollback, reads keys in raw mode (so `shift+tab` and a live `/` menu work),
 * and repaints a composed frame (header · transcript · menu · status · input).
 *
 * TTY-only. Callers fall back to a simple line reader when stdin isn't a TTY
 * (pipes/CI), so nothing here runs in non-interactive contexts.
 */

import readline from "node:readline";
import chalk from "chalk";

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

const ALT_ON = "\x1b[?1049h";
const ALT_OFF = "\x1b[?1049l";

export class Screen {
  private readonly out = process.stdout;
  private readonly inp = process.stdin;
  private transcript: string[] = [];
  private input = "";
  private busy = false;
  private closed = false;
  private pendingAsk: ((s: string) => void) | null = null;

  constructor(private readonly hooks: ScreenHooks) {}

  /** Prompt for a one-line answer (e.g. an approval). The next Enter resolves it. */
  ask(prompt: string): Promise<string> {
    this.print(chalk.yellow(prompt));
    return new Promise((res) => {
      this.pendingAsk = res;
      this.render();
    });
  }

  start(): void {
    this.out.write(ALT_ON + "\x1b[?25h");
    readline.emitKeypressEvents(this.inp);
    if (this.inp.isTTY) this.inp.setRawMode(true);
    this.inp.on("keypress", this.onKey);
    this.render();
  }

  stop(): void {
    if (this.closed) return;
    this.closed = true;
    this.inp.off("keypress", this.onKey);
    if (this.inp.isTTY) this.inp.setRawMode(false);
    this.inp.pause();
    this.out.write(ALT_OFF);
  }

  /** Append one or more lines to the scrolling transcript and repaint. */
  print(text: string): void {
    for (const l of text.split("\n")) this.transcript.push(l);
    this.render();
  }

  setBusy(b: boolean): void {
    this.busy = b;
    this.render();
  }

  private onKey = (str: string | undefined, key: readline.Key): void => {
    if (this.closed) return;
    if (key.ctrl && key.name === "c") {
      this.hooks.onExit?.();
      this.stop();
      process.exit(0);
    }
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
      this.render();
      return;
    }
    // Printable character (ignore other control keys).
    if (str && !key.ctrl && !key.meta && str.length === 1 && str >= " ") {
      this.input += str;
      this.render();
    }
  };

  private async submit(): Promise<void> {
    const line = this.input.trim();
    this.input = "";
    if (!line) {
      this.render();
      return;
    }
    this.busy = true;
    this.render();
    try {
      await this.hooks.onSubmit(line);
    } catch (e) {
      this.print(chalk.red(`  error: ${(e as Error).message}`));
    }
    this.busy = false;
    this.render();
  }

  private menuLines(cols: number): string[] {
    if (!this.input.startsWith("/")) return [];
    const q = this.input.slice(1).toLowerCase();
    const matches = this.hooks.commands.filter((c) => c.name.startsWith(q)).slice(0, 8);
    if (matches.length === 0) return [];
    return matches.map((c) => chalk.dim("  ") + chalk.cyan(`/${c.name}`).padEnd(24) + chalk.dim(c.desc.slice(0, cols - 26)));
  }

  private render(): void {
    const rows = this.out.rows ?? 24;
    const cols = this.out.columns ?? 80;
    const header = this.hooks.renderHeader(cols);
    const menu = this.menuLines(cols);
    const status = this.hooks.renderStatus(cols);
    const promptGlyph = this.busy ? chalk.yellow("…") : chalk.cyan("›");
    const inputLine = `${promptGlyph} ${this.input}`;

    const chrome = header.length + 1 /*blank*/ + menu.length + 1 /*status*/ + 1 /*input*/ + 1 /*blank*/;
    const bodyHeight = Math.max(1, rows - chrome);
    const body = this.transcript.slice(-bodyHeight);
    while (body.length < bodyHeight) body.unshift("");

    const frame = [...header, "", ...body, ...menu, status, inputLine];
    this.out.write("\x1b[2J\x1b[H" + frame.join("\r\n"));
  }
}
