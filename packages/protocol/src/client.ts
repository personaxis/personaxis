/**
 * Front-end side: connect to an engine endpoint, submit Ops, receive events.
 * Deliberately tiny, a TUI, a headless script, or a test all use the same
 * three calls: `connect`, `submit`, `onEvent`.
 */

import { createConnection, type Socket } from "node:net";
import {
  RPC_EVENT,
  RPC_HELLO,
  RPC_SUBMIT,
  type EventMsg,
  type HelloResult,
  type Op,
  type OpResult,
} from "./types.js";
import { connectionFor, type MessageConnection } from "./wire.js";

export class ProtocolClient {
  private socket: Socket | null = null;
  private conn: MessageConnection | null = null;
  private readonly listeners = new Set<(e: EventMsg) => void>();
  /** The engine's protocol version, known after connect() resolves. */
  serverProtocolVersion: number | null = null;

  async connect(pipePath: string, timeoutMs = 5_000): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const socket = createConnection(pipePath);
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error(`timed out connecting to engine at ${pipePath}`));
      }, timeoutMs);
      socket.once("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
      socket.once("connect", () => {
        clearTimeout(timer);
        this.socket = socket;
        this.conn = connectionFor(socket);
        this.conn.onNotification(RPC_EVENT, (e: EventMsg) => {
          for (const l of this.listeners) l(e);
        });
        this.conn.listen();
        resolve();
      });
    });
    // Handshake: version exchange AND registration barrier, once this request
    // roundtrips, the server has registered us and broadcasts will arrive.
    const hello = (await this.conn!.sendRequest(RPC_HELLO)) as HelloResult;
    this.serverProtocolVersion = hello.protocolVersion;
  }

  /** Submit an operation; resolves with the engine's result. */
  submit(op: Op): Promise<OpResult> {
    if (!this.conn) return Promise.reject(new Error("not connected"));
    return this.conn.sendRequest(RPC_SUBMIT, op) as Promise<OpResult>;
  }

  /** Subscribe to engine events; returns the unsubscribe function.
   * Subscribe BEFORE connect(), greeting events arrive during the handshake. */
  onEvent(listener: (e: EventMsg) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  close(): void {
    this.conn?.dispose();
    this.socket?.destroy();
    this.conn = null;
    this.socket = null;
    this.listeners.clear();
  }
}
