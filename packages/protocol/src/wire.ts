/**
 * Wire transport: JSON-RPC 2.0 over node:net.
 *
 * One API for both OSes (the vscode-jsonrpc + node:net combination VS Code
 * battle-tested): Unix domain sockets on POSIX, named pipes on Windows.
 * The path derives from the persona path so several personas can each run
 * their own engine concurrently on one machine.
 */

import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Socket } from "node:net";
import {
  createMessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
  type MessageConnection,
} from "vscode-jsonrpc/node.js";

/** Deterministic per-persona endpoint (named pipe on win32, UDS elsewhere). */
export function pipePathFor(personaPath: string): string {
  const h = createHash("sha256").update(personaPath).digest("hex").slice(0, 12);
  if (process.platform === "win32") return `\\\\.\\pipe\\personaxis-${h}`;
  const runtimeDir = process.env.XDG_RUNTIME_DIR ?? tmpdir();
  return join(runtimeDir, `personaxis-${h}.sock`);
}

/** JSON-RPC connection over an established socket (either side). */
export function connectionFor(socket: Socket): MessageConnection {
  return createMessageConnection(new StreamMessageReader(socket), new StreamMessageWriter(socket));
}

export type { MessageConnection };
