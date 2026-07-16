/**
 * Alt-screen fullscreen harness (V2-F2.1), the professional-TUI primitive the
 * codebase never had: enter the terminal's ALTERNATE SCREEN BUFFER (the k9s /
 * lazygit / btop pattern), render one Ink app, and on exit restore the primary
 * buffer EXACTLY as it was, zero scrollback residue. This is what makes menus
 * feel like stable modals instead of printing panels into the chat history.
 *
 * Fallbacks: no TTY (pipes/CI) or PERSONAXIS_NO_ALTSCREEN=1 renders normally,
 * so headless callers still get output.
 */

import { render } from "ink";
import type { ReactElement } from "react";

const ENTER_ALT = "\x1b[?1049h\x1b[2J\x1b[H\x1b[?25l"; // alt buffer + clear + home + hide cursor
const LEAVE_ALT = "\x1b[?25h\x1b[?1049l"; // show cursor + back to the primary buffer

export interface FullscreenOptions {
  /** Injected for tests. */
  stdout?: NodeJS.WriteStream;
  stdin?: NodeJS.ReadStream;
}

/** True when the alternate screen buffer will actually be used. */
export function altScreenAvailable(stdout: NodeJS.WriteStream = process.stdout): boolean {
  return Boolean(stdout.isTTY) && process.env.PERSONAXIS_NO_ALTSCREEN !== "1";
}

/**
 * Render `element` fullscreen on the alternate screen; resolves when the app
 * unmounts (its own exit(), Ctrl+C, or an error). The primary buffer is restored
 * on EVERY path, including a hard `process.exit` (the exit hook), so a crash can
 * never leave the user's terminal trapped in the alt buffer with a hidden cursor.
 */
export async function runFullscreen(element: ReactElement, opts: FullscreenOptions = {}): Promise<void> {
  const stdout = opts.stdout ?? process.stdout;
  const stdin = opts.stdin ?? process.stdin;

  if (!altScreenAvailable(stdout)) {
    const app = render(element, { stdout, stdin, patchConsole: false });
    await app.waitUntilExit();
    return;
  }

  stdout.write(ENTER_ALT);
  let restored = false;
  const restore = (): void => {
    if (restored) return;
    restored = true;
    stdout.write(LEAVE_ALT);
  };
  process.once("exit", restore);
  try {
    const app = render(element, { stdout, stdin, exitOnCtrlC: true, patchConsole: false });
    await app.waitUntilExit();
  } finally {
    process.removeListener("exit", restore);
    restore();
  }
}
