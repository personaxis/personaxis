# @personaxis/protocol

The boundary between a Personaxis front-end and the engine. A front-end submits typed operations
and receives typed events; the engine never renders, and a front-end never changes persona state
directly. Both sides speak JSON-RPC 2.0 over `node:net`, so one API covers Unix domain sockets and
Windows named pipes.

```bash
npm i @personaxis/protocol
```

| Export | What it is |
|---|---|
| `Op`, `EventMsg` | the operations a front-end may send (`user_input`, `observe`, `adjust`, `approval`, `interrupt`, …) and the events the engine emits, as discriminated unions |
| `ProtocolServer`, `ProtocolClient` | the two ends of the connection |
| `pipePathFor`, `connectionFor` | the socket or pipe address for a persona, and a connection over it |
| `PROTOCOL_VERSION` | checked in the `hello` handshake |

It also carries the [Agent Client Protocol](https://agentclientprotocol.com) bridge, in both
directions:

- **Driving**: `acpLoop` runs a turn through any agent that speaks ACP.
- **Being driven**: `serveAcpOverStdio` lets an editor run a persona as its agent; the
  `personaxis-acp` binary in the [`personaxis`](https://www.npmjs.com/package/personaxis) package
  is built on it.

MIT licensed.
