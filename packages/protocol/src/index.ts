/**
 * @personaxis/protocol — the UI↔engine seam (SQ/EQ over JSON-RPC 2.0).
 *
 * Codex's protocol pattern adapted to TypeScript: front-ends submit typed
 * operations and consume typed events; the engine never renders and a
 * front-end never mutates persona state directly. One transport API on both
 * OSes (UDS / Windows named pipes via node:net + vscode-jsonrpc).
 */

export {
  PROTOCOL_VERSION,
  RPC_SUBMIT,
  RPC_EVENT,
  RPC_HELLO,
  type HelloResult,
  type Op,
  type OpName,
  type OpResult,
  type EventMsg,
  type EventName,
} from "./types.js";
export { pipePathFor, connectionFor, type MessageConnection } from "./wire.js";
export { ProtocolServer, type OpHandler } from "./server.js";
export { ProtocolClient } from "./client.js";
