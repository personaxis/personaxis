/**
 * Engine-side endpoint: accepts front-end connections, dispatches Ops to a
 * single handler (the engine), broadcasts EventMsg to every connected front.
 *
 * The server holds NO business logic, governance, clamping and memory live in
 * @personaxis/core behind the handler. This file is only the seam.
 */

import { createServer, type Server, type Socket } from "node:net";
import { existsSync, unlinkSync } from "node:fs";
import {
  PROTOCOL_VERSION,
  RPC_EVENT,
  RPC_HELLO,
  RPC_SUBMIT,
  type EventMsg,
  type HelloResult,
  type Op,
  type OpResult,
} from "./types.js";
import { connectionFor, type MessageConnection } from "./wire.js";

export type OpHandler = (op: Op) => Promise<OpResult> | OpResult;

export class ProtocolServer {
  private server: Server | null = null;
  private readonly connections = new Set<MessageConnection>();
  private readonly sockets = new Set<Socket>();

  constructor(private readonly handler: OpHandler) {}

  /** Bind the endpoint. On POSIX a stale socket file from a crash is removed. */
  listen(pipePath: string, onConfigured?: (conn: MessageConnection) => void): Promise<void> {
    if (process.platform !== "win32" && existsSync(pipePath)) {
      // A previous engine that crashed leaves the UDS file behind; net.listen
      // would EADDRINUSE forever. Named pipes on Windows self-clean.
      try {
        unlinkSync(pipePath);
      } catch {
        /* raced with another cleanup, listen() will surface a real conflict */
      }
    }
    this.server = createServer((socket: Socket) => {
      const conn = connectionFor(socket);
      // Handshake barrier: answered by the transport AFTER registration, so a
      // client whose hello resolved is guaranteed to receive broadcasts.
      conn.onRequest(RPC_HELLO, (): HelloResult => ({ protocolVersion: PROTOCOL_VERSION }));
      conn.onRequest(RPC_SUBMIT, async (op: Op): Promise<OpResult> => {
        try {
          return await this.handler(op);
        } catch (e) {
          // A handler bug must not tear down the transport for every front-end.
          return { ok: false, error: (e as Error).message };
        }
      });
      conn.onClose(() => this.connections.delete(conn));
      socket.on("close", () => this.sockets.delete(socket));
      conn.listen();
      this.connections.add(conn);
      this.sockets.add(socket);
      onConfigured?.(conn);
    });
    return new Promise((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(pipePath, () => resolve());
    });
  }

  /** Broadcast an event to every connected front-end (JSON-RPC notification). */
  broadcast(event: EventMsg): void {
    for (const conn of this.connections) {
      // Best-effort per connection: one dead front must not stop the others.
      try {
        void conn.sendNotification(RPC_EVENT, event);
      } catch {
        this.connections.delete(conn);
      }
    }
  }

  /** Send to ONE connection (e.g. the session.configured greeting). */
  send(conn: MessageConnection, event: EventMsg): void {
    void conn.sendNotification(RPC_EVENT, event);
  }

  get connectionCount(): number {
    return this.connections.size;
  }

  close(): Promise<void> {
    for (const conn of this.connections) conn.dispose();
    this.connections.clear();
    // net.Server.close waits for every socket to END, destroy them so close()
    // resolves even when a front-end never disconnected (crash, test teardown).
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    return new Promise((resolve) => {
      if (!this.server) return resolve();
      this.server.close(() => resolve());
      this.server = null;
    });
  }
}
