/**
 * @personaxis/protocol, the UI↔engine seam (SQ/EQ over JSON-RPC 2.0).
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

/**
 * The ACP bridge: a turn run by one of the forty agents that speak the protocol.
 *
 * Lives here rather than in `@personaxis/core` on purpose. `core` is what the SaaS
 * installs, and this brings a third-party package with it; `protocol` is already
 * the JSON-RPC package, already depends on `core`, and is already what the CLI and
 * the TUI consume, so the dependency stops at the layer that needs it.
 */
export {
	AcpTurnCollector,
	acpLoop,
	deltaOf,
	type AcpAgentConnection,
	type AcpCost,
	type AcpProvider,
	type AcpProviderOptions,
	type AcpUsage,
} from "./acp/provider.js";
export {
	ACP_PROTOCOL_VERSION,
	acpOverStdio,
	type AcpClient,
	type AcpConnection,
} from "./acp/connect.js";
export {
	ACP_STOP_REASONS,
	type AcpStopReason,
	type AcpTurnState,
	type CancelCause,
} from "./acp/translate.js";
