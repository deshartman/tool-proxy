# Several connectors on one host

Running one connector per host and running several on the same host are both
supported. Each connector is its own process with its own tunnel, its own
identity, and its own state. The controller cannot tell the difference.

Choose separate **containers** when you can: each container has its own
network namespace and volume, so nothing below can collide. Choose separate
**processes** (systemd units, or the dev script) when containers are not an
option, and give each instance the values in the table.

## What each instance must own

| Setting | Why it must differ | Default |
|---|---|---|
| `INSPECTOR_PORT` | The dashboard and the loopback IPC that MCPs use for webhooks and controller calls | `9090` |
| `HEALTH_PORT` | `/livez` and `/readyz`, bound on `0.0.0.0`. A second instance on the same port can't bind it, and a probe on that port would then read the **first** instance's readiness | `9100` |
| `MCP_BASE_PORT` | The start of the auto-assigned port range for spawned MCP children. Space instances 100 apart | `7100` |
| `CONNECTOR_STATE_DIR` | Holds `config.json`: the sealed tunnel credential and the connector's identity. Two instances sharing it would share one identity | `/var/lib/mcp-connector/state` |
| `AGENTIC_MEMORY_STATE_PATH` | The bundled agentic-memory MCP's state file. If shared, memory written for one controller is read back for another | `/var/lib/mcp-connector/agentic-memory/.state.json` (image) |
| `CONNECTOR_KEY_FILE` | The master key that seals `config.json`. Sharing one is allowed; one per instance is recommended | — |

**If `HEALTH_PORT` is set explicitly and already taken, the connector exits at boot**
with `HEALTH_PORT is explicitly set but already in use`. That is deliberate:
running with a probe that reports someone else's health is worse than not
running. With the default port, boot continues and logs an error instead.

`MCP_DROPIN_DIR` and the bundled MCP directory are read-only, so they can be
shared. Each instance still approves its own MCPs: approval lives in each
process's memory and is replayed by its own controller.

## Containers (recommended)

One service per instance, each with its **own named volume**. The volume holds
the connector's identity, so two services must never share one.

```yaml
services:
  connector-a:
    image: ghcr.io/twilio/mcp-connector:${MCP_VERSION:-latest}
    environment:
      CONNECTOR_KEY_FILE: /etc/mcp-connector/connector.key
    volumes:
      - state-a:/var/lib/mcp-connector
      - ./secrets/connector-a.key:/etc/mcp-connector/connector.key:ro
    restart: unless-stopped

  connector-b:
    image: ghcr.io/twilio/mcp-connector:${MCP_VERSION:-latest}
    environment:
      CONNECTOR_KEY_FILE: /etc/mcp-connector/connector.key
    volumes:
      - state-b:/var/lib/mcp-connector
      - ./secrets/connector-b.key:/etc/mcp-connector/connector.key:ro
    restart: unless-stopped

volumes:
  state-a:
  state-b:
```

Inside each container the ports can all stay at their defaults, because the
containers don't share a network namespace. Configure each instance's tunnel
separately in its own dashboard. The [compose README](./compose/) covers how to
reach a containerised dashboard (`docker compose exec`, or `ssh -L` to the VM).

**Memory: budget about 1 GB per instance** with the shipped image. Each running
MCP child costs roughly 120 MB, and the image ships four bundled MCPs.

## Processes on one host

Give every instance its own value for each row of the table. For example, for
a second instance alongside the default one:

```bash
INSPECTOR_PORT=9091 \
HEALTH_PORT=9301 \
MCP_BASE_PORT=7200 \
CONNECTOR_STATE_DIR=/var/lib/mcp-connector-b/state \
AGENTIC_MEMORY_STATE_PATH=/var/lib/mcp-connector-b/agentic-memory/.state.json \
CONNECTOR_KEY_FILE=/etc/mcp-connector-b/connector.key \
node dist/index.js start
```

Keep `HEALTH_PORT` values outside the range you use for `INSPECTOR_PORT`, so a
later instance's dashboard port can't land on an earlier one's health port.

### Development: `scripts/start-connector.sh <port>`

The dev script derives every per-instance value from one inspector port:

| Inspector port | `HEALTH_PORT` | `MCP_BASE_PORT` | State |
|---|---|---|---|
| `9090` (default) | `9100` | `7100` | `.local/state-9090`, `.local/agentic-memory-9090` |
| `9091` | `9301` | `7200` | `.local/state-9091`, `.local/agentic-memory-9091` |
| `9092` | `9302` | `7300` | `.local/state-9092`, `.local/agentic-memory-9092` |

Inspector ports above about `9109` push `MCP_BASE_PORT` into the 9xxx range,
where child ports can meet other instances' listeners. The supervisor probes
before binding, so it skips a taken port rather than failing, but stay within
`9090`–`9109` to keep the layout predictable.

## Checking an instance

`node dist/index.js doctor` (inside the image) or `mcp-connector doctor` reports:

- **`health-port` warn, "held by a connector":** either this instance is
  already running, or another instance on the host has its `HEALTH_PORT`. Every
  connector answers `/livez` the same way, so `doctor` can't tell which; if
  this is a second instance that hasn't started yet, give it its own port.
- **`health-port` fail:** an explicit `HEALTH_PORT` is held by something that
  isn't a connector. The connector will exit at boot; choose a free port.
